/**
 * The generic web profile (stack web): in place, a repository that is not express / nestjs / react-vite
 * but has a package.json is profiled instead of being UNPROVEN for the whole run: its own type check
 * (confined; vue-tsc where installed) and ESLint, its test runner when supported, and an honest line for
 * what cannot be proven. File mode keeps 'unknown' (the twin). Runners the harness cannot run (bun,
 * react-scripts, Angular, ...) are named as unsupported with why, never replaced by the harness's vitest.
 */
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { runChecks, selectChecks } from '../../src/core/checks.ts';
import { requiredGates } from '../../src/core/gates.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { computeTargetProfile, setActiveLayout } from '../../src/core/target.ts';
import type { BrownfieldTask, LogStore } from '../../src/core/types.ts';
import { scratch, writeTree } from './_variants.ts';

const tmp = scratch('generic-web');
afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };
const profile = (root: string, inPlace: boolean) => computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace });
const pkg = (extra: Record<string, unknown>): string => JSON.stringify({ name: 'web-app', private: true, type: 'module', ...extra });

const VUE_APP = {
  'package.json': pkg({ scripts: { test: 'vitest run' }, dependencies: { vue: '3.5.0' }, devDependencies: { vite: '7.0.0', vitest: '5.0.3', '@vitejs/plugin-vue': '6.0.0' } }),
  'src/main.js': "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\n",
  'src/App.vue': '<template><p>hi</p></template>\n',
};

describe('stack web: in place, any repository with a package.json', () => {
  it('a Vue + Vite app is profiled (framework vue, nothing unsupported; vitest can load .vue); file mode keeps it unknown (the twin)', async () => {
    const root = join(tmp.dir, 'vue');
    writeTree(root, VUE_APP);
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

  it('a server framework without route extraction is named: its contract changes are not locked', async () => {
    const root = join(tmp.dir, 'fastify');
    writeTree(root, { 'package.json': pkg({ dependencies: { fastify: '5.0.0' } }), 'src/server.js': 'export {};\n' });
    const web = await profile(root, true);
    expect(web).toMatchObject({ stack: 'web', framework: { name: 'fastify' } });
    expect(web.notes.join('\n')).toMatch(/framework fastify serves an API the harness extracts no routes from: contract changes are not locked/);
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

  it('requires no API lock for stack web (named in its profile instead); an unknown stack still requires contract-lock', () => {
    const task = { kind: 'brownfield' } as BrownfieldTask;
    expect(requiredGates(task, 'finish', 'web')).not.toContain('contract-lock');
    expect(requiredGates(task, 'finish', 'unknown')).toContain('contract-lock');
  });
});

describe('the generic web checks', () => {
  it('stack web runs web-typecheck and repo-lint, never another stack\'s rules', async () => {
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const ids = selectChecks(reg.checks.map((r) => r.plugin), undefined, undefined, 'web').map((c) => c.id).sort();
    expect(ids).toEqual(['repo-lint', 'web-typecheck']);
    expect(selectChecks(reg.checks.map((r) => r.plugin), undefined, undefined, 'react-vite').map((c) => c.id)).not.toContain('web-typecheck');
  });

  it('a JavaScript repository has no type check: n/a, never a pass', async () => {
    const root = join(tmp.dir, 'js-check');
    writeTree(root, { 'package.json': pkg({}), 'src/a.js': 'export const a = 1;\n' });
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const report = await runChecks({ root, checks: reg.checks.map((r) => r.plugin), exec, harnessRoot: HARNESS_ROOT, logs, stack: 'web', rules: ['web-typecheck'] });
    expect(report.rules).toEqual([expect.objectContaining({ rule: 'web-typecheck', status: 'n/a' })]);
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
