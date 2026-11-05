/**
 * orphans gate: ship commits every file under the API root, so a file the run created must be used:
 * a test helper by a test, a source file by a test or by code that existed at run start. Scratch
 * files fail finish with the way out (delete_file).
 */
import { afterEach, describe, expect, it } from 'vitest';
import orphans from '../../plugins/gates/orphans.ts';
import type { GateResult } from '../../src/core/plugin-api.ts';
import { LEGACY_LAYOUT, setActiveLayout } from '../../src/core/target.ts';
import { makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const EXISTING: Record<string, string> = {
  'src/app.ts': "import { routes } from './routes/index.ts';\nexport const app = routes;\n",
  'src/routes/index.ts': 'export const routes: string[] = [];\n',
  'src/server.ts': "import { app } from './app.ts';\nexport const s = app;\n",
  'test/app.test.ts': "import { app } from '../src/app.ts';\nexport const a = app;\n",
};

/** A run whose start state is EXISTING (plus `start`), with `created` written since. */
async function run(created: Record<string, string>, start: Record<string, string> = {}): Promise<GateResult> {
  const before = { ...EXISTING, ...start };
  const h = await makeHarness({ label: 'orphans', files: { ...before, ...created } });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(before)) h.ctx.state.initialHashes.set(rel, sha(content));
  return orphans.run(h.ctx, 'finish');
}

const details = (r: GateResult): string => (r.details ?? []).join('\n');

describe('orphans gate', () => {
  it('passes when every created file is imported by a test or by existing code', async () => {
    const r = await run({
      // Changed existing route index imports the new module; the new test uses a new helper, which uses a new factory.
      'src/routes/index.ts': "import { items } from './items.ts';\nexport const routes: string[] = [items];\n",
      'src/routes/items.ts': "import { label } from '../lib/label.ts';\nexport const items = label('items');\n",
      'src/lib/label.ts': 'export const label = (s: string): string => s;\n',
      'test/items.test.ts': "import { make } from './helpers/make.ts';\nexport const m = make();\n",
      'test/helpers/make.ts': "import { seed } from './seed.ts';\nexport const make = () => seed;\n",
      'test/helpers/seed.ts': 'export const seed = 1;\n',
      'src/only-tested.ts': 'export const t = 1;\n',
      'test/only-tested.test.ts': "import { t } from '../src/only-tested.ts';\nexport const x = t;\n",
    });
    expect(r.status, details(r)).toBe('pass');
    expect(r.summary).toBe('5 created files, all imported by a test or by existing code');
  });

  it('fails on scratch files under the test root and unreachable source, and says to delete_file them', async () => {
    const r = await run({
      'test/scratch-explore.ts': 'export const probe = 1;\n',
      'src/debug-scratch.ts': "import { helper } from './debug-helper.ts';\nexport const d = helper;\n",
      'src/debug-helper.ts': 'export const helper = 1;\n',
    });
    expect(r.status).toBe('fail');
    expect(details(r)).toContain('test/scratch-explore.ts: created under the test root, but no test imports it');
    expect(details(r)).toContain('src/debug-scratch.ts: created, but neither a test nor code that existed at run start imports it');
    // Imported only by another orphan: still an orphan.
    expect(details(r)).toContain('src/debug-helper.ts: created');
    expect(details(r)).toContain('delete_file { "path": "src/debug-helper.ts" }');
  });

  it('a test helper must be used by a test: existing source importing it does not count', async () => {
    const r = await run(
      { 'test/helpers/fixture.ts': 'export const f = 1;\n' },
      { 'src/legacy.ts': "import { f } from '../test/helpers/fixture.ts';\nexport const l = f;\n" },
    );
    expect(r.status).toBe('fail');
    expect(details(r)).toContain('test/helpers/fixture.ts');
  });

  it('follows tsconfig path aliases the way TypeScript resolves them; a package name is not an alias', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', allowImportingTsExtensions: true, noEmit: true, paths: { '@/*': ['./src/*'] } } });
    const aliased = await run(
      { 'src/lib/format.ts': 'export const fmt = 1;\n', 'test/format.test.ts': "import { fmt } from '@/lib/format.ts';\nexport const x = fmt;\n" },
      { 'tsconfig.json': tsconfig },
    );
    expect(aliased.status, details(aliased)).toBe('pass');
    const pkgName = await run({ 'test/supertest.ts': 'export const s = 1;\n', 'test/api.test.ts': "import request from 'supertest';\nexport const r = request;\n" });
    expect(pkgName.status).toBe('fail');
    expect(details(pkgName)).toContain('test/supertest.ts');
  });

  it('an alias TypeScript cannot resolve makes a same-named created file UNPROVEN, not an orphan', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { paths: { '~/*': ['./nowhere/*'] } } });
    const r = await run({ 'src/fmt.ts': 'export const fmt = 1;\n', 'test/fmt.test.ts': "import { fmt } from '~/fmt';\nexport const x = fmt;\n" }, { 'tsconfig.json': tsconfig });
    expect(r.status).toBe('unproven');
    expect(details(r)).toContain('src/fmt.ts: no import reaches it');
  });

  it('created test files themselves are always used; no new files passes', async () => {
    expect((await run({ 'test/new.test.ts': 'export {};\n' })).summary).toBe('no new non-test files');
  });
});

describe('orphans gate in an in-place web layout (JavaScript and components are in the graph)', () => {
  const VUE: Record<string, string> = {
    'src/main.js': "import App from './App.vue';\nexport const app = App;\n",
    'src/App.vue': '<template><p/></template>\n<script setup>\nimport { greet } from "./lib/greet.js";\nconst g = greet;\n</script>\n',
    'src/lib/greet.js': 'export const greet = (n) => `hi ${n}`;\n',
  };
  async function runWeb(created: Record<string, string>, start: Record<string, string> = VUE): Promise<GateResult> {
    setActiveLayout({ ...LEGACY_LAYOUT, codeKinds: 'web' });
    try {
      return await run(created, start);
    } finally {
      setActiveLayout(undefined);
    }
  }

  it('a new helper only a component imports is used; a new component an existing module imports is used', async () => {
    const r = await runWeb({
      'src/App.vue': '<template><Badge/></template>\n<script setup>\nimport { greet } from "./lib/greet.js";\nimport { fmt } from "./lib/fmt.ts";\nimport Badge from "./Badge.vue";\nconst g = [greet, fmt, Badge];\n</script>\n',
      'src/lib/fmt.ts': 'export const fmt = (n: number): string => String(n);\n',
      'src/Badge.vue': '<template><b/></template>\n',
    });
    expect(r).toMatchObject({ status: 'pass', summary: '2 created files, all imported by a test or by existing code' });
  });

  const pkg = (deps: Record<string, string>): string => JSON.stringify({ name: 'web', private: true, dependencies: deps });
  const PAGE = 'export default function Page() { return null; }\n';

  it('a new file a file-routed framework loads by convention is UNPROVEN ("verify by hand"), never an orphan', async () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      [{ 'package.json': pkg({ next: '16.0.0' }) }, ['app/dashboard/page.tsx', 'src/app/api/users/route.ts', 'pages/about.jsx', 'app/layout.js']],
      [{ 'package.json': pkg({ nuxt: '4.0.0' }) }, ['pages/index.vue', 'components/Badge.vue']],
      [{ 'package.json': pkg({ '@sveltejs/kit': '2.0.0' }) }, ['src/routes/about/+page.svelte', 'src/routes/api/+server.ts']],
      [{ 'package.json': pkg({ '@remix-run/react': '2.0.0' }) }, ['app/routes/users.tsx']],
      [{ 'package.json': pkg({ astro: '5.0.0' }) }, ['src/pages/api/hello.ts']],
      [{ 'package.json': pkg({}), 'apps/web/package.json': pkg({ next: '16.0.0' }) }, ['apps/web/app/page.tsx']],
    ];
    for (const [start, created] of cases) {
      const r = await runWeb(Object.fromEntries(created.map((f) => [f, PAGE])), { ...VUE, ...start });
      expect(r.status, `${created.join(', ')}: ${details(r)}`).toBe('unproven');
      expect(r.summary).toBe(`${created.length} created file(s) loaded by the framework by convention; verify by hand`);
      for (const f of created) expect(details(r)).toMatch(new RegExp(`${f.replace(/[.+$]/g, '\\$&')}: loaded by the framework by convention \\(.+\\); verify by hand`));
      expect(r.humanMustVerify).toHaveLength(created.length);
    }
  });

  it('the twins: without the framework declared it is an orphan; a test that imports it makes it used; a file outside the convention is an orphan', async () => {
    const noFramework = await runWeb({ 'app/dashboard/page.tsx': PAGE }, { ...VUE, 'package.json': pkg({ react: '19.0.0' }) });
    expect(noFramework.status).toBe('fail');
    expect(details(noFramework)).toMatch(/app\/dashboard\/page\.tsx: created, but neither a test nor code that existed at run start imports it/);
    const tested = await runWeb({ 'app/dashboard/page.tsx': PAGE, 'test/page.test.ts': "import Page from '../app/dashboard/page.tsx';\nexport const p = Page;\n" }, { ...VUE, 'package.json': pkg({ next: '16.0.0' }) });
    expect(tested).toMatchObject({ status: 'pass' });
    const mixed = await runWeb({ 'app/dashboard/page.tsx': PAGE, 'app/dashboard/scratch.ts': 'export const x = 1;\n', 'src/routes/about/helper.js': 'export {};\n' }, { ...VUE, 'package.json': pkg({ next: '16.0.0' }) });
    expect(mixed.status).toBe('fail');
    expect(details(mixed)).toMatch(/app\/dashboard\/scratch\.ts: created, but neither/);
    expect(details(mixed)).toMatch(/src\/routes\/about\/helper\.js: created, but neither/);
    expect(details(mixed)).toMatch(/unproven: app\/dashboard\/page\.tsx: loaded by the framework by convention \(Next\.js\)/);
  });

  it('file-mode twin: the same Next.js route is an orphan (no convention outside an in-place web layout)', async () => {
    const r = await run({ 'app/api/users/route.ts': 'export const GET = (): null => null;\n' }, { 'package.json': pkg({ next: '16.0.0' }) });
    expect(r.status).toBe('fail');
    expect(details(r)).toMatch(/app\/api\/users\/route\.ts: created, but neither/);
  });

  it('the twin: a new component and a new JavaScript module nothing imports are orphans', async () => {
    const r = await runWeb({ 'src/Unused.vue': '<template><i/></template>\n', 'src/lib/unused.js': 'export const x = 1;\n' });
    expect(r.status).toBe('fail');
    expect(details(r)).toMatch(/src\/Unused\.vue: created, but neither a test nor code that existed at run start imports it/);
    expect(details(r)).toMatch(/src\/lib\/unused\.js: created/);
  });
});
