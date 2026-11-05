/**
 * The generic web profile (stack web): in place, a repository that is not express / nestjs / react-vite
 * but has a package.json is profiled instead of being UNPROVEN for the whole run: its own type check
 * (confined; vue-tsc where installed) and ESLint, its test runner when supported, and an honest line for
 * what cannot be proven. File mode keeps 'unknown' (the twin). Runners the harness cannot run (bun,
 * react-scripts, Angular, ...) are named as unsupported with why, never replaced by the harness's vitest.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { runChecks, selectChecks } from '../../src/core/checks.ts';
import { requiredGates } from '../../src/core/gates.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { targetProfile } from '../../src/core/run.ts';
import { computeTargetProfile, formatProfile, setActiveLayout, WEB_NO_STANDARDS_NOTE, webServerNote } from '../../src/core/target.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { sessionSystemPrompt } from '../../src/session/prompt.ts';
import type { BrownfieldTask, Exec, LogStore, Stack } from '../../src/core/types.ts';
import { scratch, writeTree } from './_variants.ts';

const tmp = scratch('generic-web');
afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };
const profile = (root: string, inPlace: boolean) => computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace });
const pkg = (extra: Record<string, unknown>): string => JSON.stringify({ name: 'web-app', private: true, type: 'module', ...extra });
const BROWNFIELD = { kind: 'brownfield' } as BrownfieldTask;

const VUE_APP = {
  'package.json': pkg({ scripts: { test: 'vitest run' }, dependencies: { vue: '3.5.0' }, devDependencies: { vite: '7.0.0', vitest: '5.0.3', '@vitejs/plugin-vue': '6.0.0' } }),
  'src/main.js': "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\n",
  'src/App.vue': '<template><p>hi</p></template>\n',
};

describe('stack web: in place, any repository with a package.json', () => {
  it('a Vue + Vite app with ESLint is profiled (framework vue, nothing unsupported; vitest can load .vue); file mode keeps it unknown (the twin)', async () => {
    const root = join(tmp.dir, 'vue');
    writeTree(root, { ...VUE_APP, 'eslint.config.js': 'export default [];\n' });
    const web = await profile(root, true);
    expect(web.stack).toBe('web');
    expect(web.framework).toMatchObject({ name: 'vue', supported: true });
    expect(web.unsupported).toEqual([]);
    expect(web.runner).toMatchObject({ kind: 'vitest', supported: true, components: ['.vue'] });
    expect(web.notes.join('\n')).toMatch(/stack web \(generic, framework vue\)/);
    const file = await profile(root, false);
    expect(file.stack).toBe('unknown');
    expect(file.unsupported.join('\n')).toMatch(/framework .*: no stack profile .* applies/);
  });

  it('a server framework without route extraction is unsupported (shown before the first turn, carried by every verdict); a frontend twin is not', async () => {
    const root = join(tmp.dir, 'fastify');
    writeTree(root, { 'package.json': pkg({ dependencies: { fastify: '5.0.0' } }), 'src/server.js': 'export {};\n', 'eslint.config.js': 'export default [];\n' });
    const web = await profile(root, true);
    expect(web).toMatchObject({ stack: 'web', framework: { name: 'fastify' } });
    expect(web.unsupported).toEqual([webServerNote('fastify')]);
    expect(web.unsupported[0]).toMatch(/framework fastify serves an API the harness extracts no routes from: contract changes are not locked, so "Work completed" cannot be reached here/);
    expect(formatProfile(web).join('\n')).toContain(`UNPROVEN: ${webServerNote('fastify')}`);
    const front = join(tmp.dir, 'lit-front');
    writeTree(front, { 'package.json': pkg({ dependencies: { lit: '3.0.0' } }), 'src/main.js': 'export {};\n', 'eslint.config.js': 'export default [];\n' });
    expect((await profile(front, true)).unsupported).toEqual([]);
  });

  it('a file-routed framework is named for its API routes in the notes (a change to one is named UNPROVEN), not unsupported', async () => {
    const root = join(tmp.dir, 'next-app');
    writeTree(root, { 'package.json': pkg({ dependencies: { next: '15.0.0', react: '19.0.0' } }), 'app/page.jsx': 'export default () => null;\n', 'eslint.config.js': 'export default [];\n' });
    const web = await profile(root, true);
    expect(web).toMatchObject({ stack: 'web', framework: { name: 'next' }, unsupported: [] });
    expect(web.notes.join('\n')).toMatch(/framework next serves API routes by file convention .* a change to one is named UNPROVEN/);
  });

  it('no package.json: still unknown in place (nothing says it is a web repository)', async () => {
    const root = join(tmp.dir, 'static');
    writeTree(root, { 'index.html': '<p>hi</p>\n' });
    expect((await profile(root, true)).stack).toBe('unknown');
  });

  it('the stacks the 01 rubric relies on are unchanged in place', async () => {
    const root = join(tmp.dir, 'express');
    writeTree(root, { 'package.json': pkg({ dependencies: { express: '5.2.1' } }), 'src/app.ts': 'export {};\n' });
    expect((await profile(root, true)).stack).toBe('express');
  });

  const JS_EXPRESS = {
    'package.json': pkg({ scripts: { test: 'node --test' }, dependencies: { express: '5.2.1' } }),
    'app.js': "import express from 'express';\nimport { users } from './routes/users.js';\nexport const app = express().use('/users', users);\n",
    'routes/users.js': "import { Router } from 'express';\nexport const users = Router().get('/', (_req, res) => res.json([]));\n",
    'test/users.test.js': "import { test } from 'node:test';\ntest('x', () => {});\n",
  };
  const JS_REACT_VITE = {
    'package.json': pkg({ dependencies: { react: '19.0.0' }, devDependencies: { vite: '7.0.0' } }),
    'vite.config.js': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
    'src/main.jsx': "import { App } from './App.jsx';\nexport const root = App;\n",
    'src/App.jsx': 'export const App = () => <p>hi</p>;\n',
  };

  it('a JavaScript Express repository in place gets web, its unlocked routes unsupported (never "Work completed"); file mode keeps express and its contract lock (the twin)', async () => {
    for (const [name, extra] of [['js-express', {}], ['js-express-eslint', { 'eslint.config.js': 'export default [];\n' }]] as const) {
      const root = join(tmp.dir, name);
      writeTree(root, { ...JS_EXPRESS, ...extra });
      const web = await profile(root, true);
      expect(web, name).toMatchObject({ stack: 'web', framework: { name: 'express', supported: true } });
      expect(web.notes.join('\n')).toMatch(/JavaScript only \(no tsconfig\.json, no TypeScript sources\): the express profile's TypeScript rules do not apply/);
      expect(web.unsupported, name).toContain(webServerNote('express'));
      // The preflight lines show every unsupported part (the notes only the first three).
      expect(formatProfile(web).join('\n')).toContain(`UNPROVEN: ${webServerNote('express')}`);
      expect(requiredGates(BROWNFIELD, 'finish', web.stack)).not.toContain('contract-lock');
      const fileMode = await profile(root, false);
      expect(fileMode.stack).toBe('express');
      expect(fileMode.unsupported).not.toContain(webServerNote('express'));
      expect(requiredGates(BROWNFIELD, 'finish', fileMode.stack)).toContain('contract-lock');
    }
  });

  it('a JavaScript React + Vite repository in place gets web (framework react); file mode keeps react-vite (the twin)', async () => {
    const root = join(tmp.dir, 'js-react-vite');
    writeTree(root, JS_REACT_VITE);
    expect(await profile(root, true)).toMatchObject({ stack: 'web', framework: { name: 'react' } });
    expect((await profile(root, false)).stack).toBe('react-vite');
  });

  it('TypeScript keeps the TypeScript stacks in place: a tsconfig.json, or a .ts source without one (the twins)', async () => {
    const withTsconfig = join(tmp.dir, 'js-express-tsconfig');
    writeTree(withTsconfig, { ...JS_EXPRESS, 'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true }, include: ['.'] }) });
    expect((await profile(withTsconfig, true)).stack).toBe('express');
    const withTs = join(tmp.dir, 'react-vite-ts');
    writeTree(withTs, { ...JS_REACT_VITE, 'src/money.ts': 'export const cents = (n: number): number => n * 100;\n' });
    expect((await profile(withTs, true)).stack).toBe('react-vite');
    // A tool's TypeScript config or a TypeScript test is not the repository's code.
    const toolingOnly = join(tmp.dir, 'react-vite-ts-config');
    writeTree(toolingOnly, { ...JS_REACT_VITE, 'vite.config.ts': "export default {};\n", 'src/App.test.ts': "import { test } from 'node:test';\ntest('x', () => {});\n" });
    expect((await profile(toolingOnly, true)).stack).toBe('web');
  });

  it('TypeScript test support (an e2e fixture, a Cypress or Playwright helper, a story) keeps a JavaScript app on web; a .ts module of the app is the twin that does not', async () => {
    const helpers = {
      'e2e/fixtures.ts': "export const baseURL = 'http://localhost:3000';\n",
      'e2e/home.spec.ts': "import { baseURL } from './fixtures.ts';\nexport const u = baseURL;\n",
      'test/setup.ts': 'export const ready = true;\n',
      'cypress/support/commands.ts': 'export {};\n',
      'playwright/global-setup.ts': 'export default async () => {};\n',
      'src/Button.stories.ts': 'export default {};\n',
    };
    const js = join(tmp.dir, 'js-express-ts-helpers');
    writeTree(js, { ...JS_EXPRESS, ...helpers });
    expect((await profile(js, true)).stack).toBe('web');
    const twin = join(tmp.dir, 'js-express-ts-module');
    writeTree(twin, { ...JS_EXPRESS, ...helpers, 'routes/money.ts': 'export const cents = (n: number): number => n * 100;\n' });
    expect((await profile(twin, true)).stack).toBe('express');
  });

  it('the session system prompt never calls a web repository TypeScript, its standards included; the express one does (the twin)', async () => {
    const base = { repo: 'r', branch: 'feat/x', writable: true, reason: '', runner: 'node:test', tools: [], checks: [] };
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const checks = selectChecks(reg.checks.map((r) => r.plugin), undefined, undefined, 'web');
    expect(checks.length).toBeGreaterThan(0);
    expect(sessionSystemPrompt({ ...base, stack: 'web', checks })).not.toMatch(/TypeScript/);
    expect(sessionSystemPrompt({ ...base, stack: 'express' })).toMatch(/TypeScript REST APIs/);
  });

  it('a git-visibility workspace (the owner\'s checkout) is profiled in place without a flag; a worktree is not (the twin)', async () => {
    const root = join(tmp.dir, 'js-express-ws');
    writeTree(root, JS_EXPRESS);
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect((await targetProfile(createWorkspace(root, '.', { visibility: 'git' }))).profile?.stack).toBe('web');
    expect((await targetProfile(createWorkspace(root, '.'))).profile?.stack).toBe('express');
  });

  it('requires no API lock for stack web (named in its profile instead); an unknown stack still requires contract-lock', () => {
    const task = { kind: 'brownfield' } as BrownfieldTask;
    expect(requiredGates(task, 'finish', 'web')).not.toContain('contract-lock');
    expect(requiredGates(task, 'finish', 'unknown')).toContain('contract-lock');
  });
});

describe('the generic web checks', () => {
  it('stack web runs web-typecheck, repo-lint and web-build, never another stack\'s rules', async () => {
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const ids = selectChecks(reg.checks.map((r) => r.plugin), undefined, undefined, 'web').map((c) => c.id).sort();
    expect(ids).toEqual(['repo-lint', 'web-build', 'web-typecheck']);
    const reactVite = selectChecks(reg.checks.map((r) => r.plugin), undefined, undefined, 'react-vite').map((c) => c.id);
    expect(reactVite).not.toContain('web-typecheck');
    expect(reactVite).not.toContain('web-build');
    expect(reactVite).toContain('vite-build');
  });

  it('web-build: a web repository with Vite installed and a vite config gets its confined vite build; without either it is n/a (the twins)', async () => {
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const checks = reg.checks.map((r) => r.plugin);
    const calls: string[][] = [];
    let code = 0;
    const fake: Exec = async (_cmd, args) => {
      calls.push(args);
      return { code, stdout: '', stderr: code === 0 ? '' : 'error: [vite]: Rollup failed to resolve import "x"', durationMs: 1, timedOut: false };
    };
    const build = (root: string, stack: Stack = 'web') => runChecks({ root, checks, exec: fake, harnessRoot: HARNESS_ROOT, logs, stack, rules: [stack === 'web' ? 'web-build' : 'vite-build'] });
    const app = { 'package.json': pkg({ dependencies: { vue: '3.5.0' }, devDependencies: { vite: '7.0.0' } }), 'node_modules/vite/bin/vite.js': '', 'src/main.js': 'export {};\n' };
    const withConfig = join(tmp.dir, 'web-build-vite');
    writeTree(withConfig, { ...app, 'vite.config.js': 'export default {};\n' });
    expect((await build(withConfig)).rules).toEqual([expect.objectContaining({ rule: 'web-build', category: 'build', status: 'pass' })]);
    expect(calls.at(-1)?.slice(1, 2)).toEqual(['build']);
    code = 1;
    expect((await build(withConfig)).rules).toEqual([expect.objectContaining({ rule: 'web-build', status: 'fail' })]);
    code = 0;
    const before = calls.length;
    const noConfig = join(tmp.dir, 'web-build-no-config');
    writeTree(noConfig, app);
    expect((await build(noConfig)).rules).toEqual([expect.objectContaining({ rule: 'web-build', status: 'n/a' })]);
    const noVite = join(tmp.dir, 'web-build-no-vite');
    writeTree(noVite, { 'package.json': pkg({}), 'vite.config.js': 'export default {};\n', 'src/main.js': 'export {};\n' });
    expect((await build(noVite)).rules).toEqual([expect.objectContaining({ rule: 'web-build', status: 'n/a' })]);
    expect(calls.length).toBe(before);
    // File mode (react-vite) is unchanged: its Vite missing is UNPROVEN, never n/a.
    expect((await build(noVite, 'react-vite')).rules).toEqual([expect.objectContaining({ rule: 'vite-build', status: 'unproven' })]);
  });

  it('a JavaScript repository has no type check: n/a, never a pass', async () => {
    const root = join(tmp.dir, 'js-check');
    writeTree(root, { 'package.json': pkg({}), 'src/a.js': 'export const a = 1;\n' });
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const report = await runChecks({ root, checks: reg.checks.map((r) => r.plugin), exec, harnessRoot: HARNESS_ROOT, logs, stack: 'web', rules: ['web-typecheck'] });
    expect(report.rules).toEqual([expect.objectContaining({ rule: 'web-typecheck', status: 'n/a' })]);
  });

  it('n/a is decided on the absence of tsconfig.json alone: a JavaScript repository with TypeScript installed has no type check (n/a, not UNPROVEN)', async () => {
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const root = join(tmp.dir, 'js-with-typescript');
    writeTree(root, { 'package.json': pkg({ devDependencies: { typescript: '6.0.3' } }), 'src/a.js': 'export const a = 1;\n' });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(HARNESS_ROOT, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
    const web = await runChecks({ root, checks: reg.checks.map((r) => r.plugin), exec, harnessRoot: HARNESS_ROOT, logs, stack: 'web', rules: ['web-typecheck'] });
    expect(web.rules).toEqual([expect.objectContaining({ rule: 'web-typecheck', status: 'n/a' })]);
    // The twins that stay UNPROVEN: a tsconfig.json without the TypeScript to run it (web), and the file-mode
    // stacks' repo-typecheck, which never decides n/a.
    const noTs = join(tmp.dir, 'tsconfig-without-typescript');
    writeTree(noTs, { 'package.json': pkg({}), 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
    const unproven = await runChecks({ root: noTs, checks: reg.checks.map((r) => r.plugin), exec, harnessRoot: HARNESS_ROOT, logs, stack: 'web', rules: ['web-typecheck'] });
    expect(unproven.rules).toEqual([expect.objectContaining({ rule: 'web-typecheck', status: 'unproven' })]);
    const fileMode = await runChecks({ root, checks: reg.checks.map((r) => r.plugin), exec, harnessRoot: HARNESS_ROOT, logs, stack: 'react-vite', rules: ['repo-typecheck'] });
    expect(fileMode.rules).toEqual([expect.objectContaining({ rule: 'repo-typecheck', status: 'unproven' })]);
  });

  it('the profile lists "Work completed cannot be reached" without a linter or tsconfig as unsupported (the banner shows it); the twins with one do not', async () => {
    const bare = join(tmp.dir, 'web-no-standards');
    writeTree(bare, { 'package.json': pkg({ dependencies: { vue: '3.5.0' } }), 'src/main.js': 'export {};\n' });
    const p = await profile(bare, true);
    expect(p.stack).toBe('web');
    expect(p.unsupported).toEqual([WEB_NO_STANDARDS_NOTE]);
    expect(p.notes).not.toContain(WEB_NO_STANDARDS_NOTE);
    expect(formatProfile(p).join('\n')).toContain('UNPROVEN: "Work completed" cannot be reached in this repository until a linter or a tsconfig.json exists');
    for (const [name, extra] of [['web-eslint', { 'eslint.config.js': 'export default [];\n' }], ['web-tsconfig', { 'tsconfig.json': '{}' }]] as const) {
      const root = join(tmp.dir, name);
      writeTree(root, { 'package.json': pkg({ dependencies: { vue: '3.5.0' } }), 'src/main.js': 'export {};\n', ...extra });
      expect((await profile(root, true)).unsupported, name).toEqual([]);
    }
  });

  it("a TypeScript repository's own tsc runs confined and reports its errors (fail); the clean twin passes", async () => {
    const files = {
      'package.json': pkg({ devDependencies: { typescript: '6.0.3' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022' }, include: ['src'] }),
    };
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const check = async (name: string, source: string) => {
      const root = join(tmp.dir, name);
      writeTree(root, { ...files, 'src/a.ts': source });
      // The repository's own TypeScript: a link to the harness's install stands in for its node_modules/typescript.
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      symlinkSync(join(HARNESS_ROOT, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
      return runChecks({ root, checks: reg.checks.map((r) => r.plugin), exec, harnessRoot: HARNESS_ROOT, logs, stack: 'web', rules: ['web-typecheck'] });
    };
    const bad = await check('ts-bad', 'export const a: number = "x";\n');
    expect(bad.rules[0]).toMatchObject({ rule: 'web-typecheck', status: 'fail', category: 'typecheck' });
    expect(bad.findings.find((f) => f.file === 'src/a.ts')?.violations[0]?.message).toMatch(/^TS2322:/);
    const good = await check('ts-good', 'export const a: number = 1;\n');
    expect(good.rules[0]).toMatchObject({ rule: 'web-typecheck', status: 'pass' });
  });
});

describe('runners the harness cannot run are named, never replaced by its vitest', () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['bun test', { 'package.json': pkg({ scripts: { test: 'bun test' } }) }, /bun test \(bun's own runner/],
    ['react-scripts test', { 'package.json': pkg({ scripts: { test: 'react-scripts test' }, dependencies: { react: '19.0.0', 'react-scripts': '5.0.1' } }) }, /Create React App's jest/],
    ['ng test', { 'package.json': pkg({ scripts: { test: 'ng test' }, dependencies: { '@angular/core': '20.0.0' } }) }, /Angular CLI's test builder/],
    ['react-scripts (no test script)', { 'package.json': pkg({ dependencies: { react: '19.0.0', 'react-scripts': '5.0.1' } }) }, /Create React App's jest/],
    ['bun:test imports', { 'package.json': pkg({}), 'src/a.test.ts': "import { test } from 'bun:test';\ntest('x', () => {});\n" }, /bun test/],
  ];
  for (const [name, files, reason] of cases) {
    it(`${name}: unsupported, with why`, async () => {
      const root = join(tmp.dir, `runner-${name.replace(/\W+/g, '-')}`);
      writeTree(root, files);
      const p = await profile(root, false);
      expect(p.runner.supported).toBe(false);
      expect(p.runner.reason).toMatch(reason);
      expect(p.unsupported.join('\n')).toMatch(reason);
    });
  }

  it('the twin: a declared vitest is still vitest', async () => {
    const root = join(tmp.dir, 'runner-vitest');
    writeTree(root, { 'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '5.0.3' } }) });
    expect((await profile(root, false)).runner).toMatchObject({ kind: 'vitest', supported: true });
  });
});

describe('re-detection keeps tsx for a React + Vite tree with node:test files (ship reopens a run)', () => {
  it('node:test files in a React + Vite app: node:test with the tsx loader, as at run start', async () => {
    const root = join(tmp.dir, 'react-vite-redetect');
    writeTree(root, {
      'package.json': pkg({ dependencies: { react: '19.0.0' }, devDependencies: { vite: '7.0.0' } }),
      'src/money.ts': 'export const cents = (n: number): number => Math.round(n * 100);\n',
      'test/money.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { cents } from '../src/money';\ntest('cents', () => assert.equal(cents(1), 100));\n",
    });
    const p = await profile(root, false);
    expect(p.runner.kind).toBe('node-test');
    expect(p.runner.evidence).toBe('test files import node:test');
    expect((p.runner.nodeArgs ?? []).some((a) => a.includes('tsx'))).toBe(true);
  });

  it('the twin: node:test files outside a React + Vite app get no forced loader', async () => {
    const root = join(tmp.dir, 'plain-node-test');
    writeTree(root, {
      'package.json': pkg({}),
      'test/a.test.mjs': "import { test } from 'node:test';\ntest('x', () => {});\n",
      'test/b.test.ts': "import { test } from 'node:test';\ntest('x', () => {});\n",
    });
    const p = await profile(root, false);
    expect(p.runner.kind).toBe('node-test');
    // node 24 strips types itself: no tsx unless the tree needs it
    if ((process.features as { typescript?: unknown }).typescript) expect((p.runner.nodeArgs ?? []).some((a) => a.includes('tsx'))).toBe(false);
  });
});
