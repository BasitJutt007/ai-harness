/**
 * A Vite app under node:test, with tsx or with Node's own type stripping (no tsx: TypeScript modules load as
 * 'module-typescript'): its modules read import.meta.env, which only Vite and Vitest define,
 * so without the harness's --import hook they crash at import and no test of them can run. With it they
 * see the object Vite gives them (MODE, DEV, PROD, SSR, BASE_URL), line numbers intact. Run for real,
 * sandboxed, with the twin that omits the hook.
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs runtime module without type declarations
import * as hooks from '../../src/core/import-meta-env-hooks.mjs';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { computeTargetProfile, IMPORT_META_ENV } from '../../src/core/target.ts';
import { runTargetTests } from '../../src/core/testing.ts';
import type { LogStore } from '../../src/core/types.ts';
import { scratch, writeTree } from './_variants.ts';

const defineImportMetaEnv = hooks.defineImportMetaEnv as (source: string) => string;
const tmp = scratch('import-meta-env');
afterAll(() => tmp.cleanup());
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };

/** A React + Vite app with no runner (node:test + tsx), whose config module reads import.meta.env at import. */
const VITE_APP = {
  'package.json': JSON.stringify({ name: 'vite-app', private: true, type: 'module', dependencies: { react: '19.0.0' }, devDependencies: { vite: '7.0.0' } }),
  'src/config.ts': 'export const mode: string = import.meta.env.MODE;\nexport const isDev: boolean = import.meta.env.DEV;\nexport const base: string = import.meta.env.BASE_URL;\n',
  'test/config.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { base, isDev, mode } from '../src/config';\ntest('vite env', () => {\n  assert.equal(mode, 'test');\n  assert.equal(isDev, true);\n  assert.equal(base, '/');\n});\n",
};

describe('import.meta.env under node:test for a Vite app', () => {
  it("defines it for the app's modules: the suite loads and passes", async () => {
    const root = join(tmp.dir, 'with-hook');
    writeTree(root, VITE_APP);
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.runner.kind).toBe('node-test');
    expect(p.runner.nodeArgs?.at(-1)).toBe(`--import=file://${IMPORT_META_ENV}`);
    const report = await runTargetTests({ root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(report.observations.map((o) => [o.file, o.status])).toEqual([['test/config.test.ts', 'pass']]);
    expect(report.ok).toBe(true);
  });

  it('the twin: without the hook the same suite fails to load (import.meta.env is undefined)', async () => {
    const root = join(tmp.dir, 'without-hook');
    writeTree(root, VITE_APP);
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    const runner = { ...p.runner, nodeArgs: (p.runner.nodeArgs ?? []).filter((a) => !a.includes('import-meta-env')) };
    const report = await runTargetTests({ root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner, layout: p });
    expect(report.ok).toBe(false);
    expect(report.console ?? '').toMatch(/reading 'MODE'/);
  });

  /** A Vite app (no React: no forced tsx) whose node:test suite Node runs with its own type stripping. */
  const NATIVE_APP = {
    'package.json': JSON.stringify({ name: 'vite-native', private: true, type: 'module', scripts: { test: 'node --test' }, devDependencies: { vite: '7.0.0' } }),
    'src/config.ts': 'export const mode: string = import.meta.env.MODE;\nexport const isDev: boolean = import.meta.env.DEV;\n',
    'test/config.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isDev, mode } from '../src/config.ts';\ntest('vite env', () => {\n  assert.equal(mode, 'test');\n  assert.equal(isDev, true);\n});\n",
  };
  const native = Boolean((process.features as { typescript?: unknown }).typescript);

  it.runIf(native)('without tsx (Node strips the types itself): the TypeScript module gets import.meta.env too, and the suite passes', async () => {
    const root = join(tmp.dir, 'native-with-hook');
    writeTree(root, NATIVE_APP);
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.runner.kind).toBe('node-test');
    expect((p.runner.nodeArgs ?? []).some((a) => a.includes('tsx'))).toBe(false);
    expect(p.runner.nodeArgs?.at(-1)).toBe(`--import=file://${IMPORT_META_ENV}`);
    const report = await runTargetTests({ root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(report.observations.map((o) => [o.file, o.status])).toEqual([['test/config.test.ts', 'pass']]);
  });

  it.runIf(native)('the twin without tsx: without the hook the same suite fails to load', async () => {
    const root = join(tmp.dir, 'native-without-hook');
    writeTree(root, NATIVE_APP);
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    const runner = { ...p.runner, nodeArgs: (p.runner.nodeArgs ?? []).filter((a) => !a.includes('import-meta-env')) };
    const report = await runTargetTests({ root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner, layout: p });
    expect(report.ok).toBe(false);
    expect(report.console ?? '').toMatch(/reading 'MODE'/);
  });

  it("the hook defines it for ES modules, JavaScript or TypeScript ('module', 'module-typescript'); never CommonJS or a dependency", async () => {
    const initialize = hooks.initialize as (d: { root: string }) => Promise<void>;
    const load = hooks.load as (url: string, ctx: object, next: () => Promise<{ format: string; source: string }>) => Promise<{ format: string; source: string }>;
    await initialize({ root: 'file:///repo/' });
    const src = 'export const m = import.meta.env.MODE;\n';
    const loaded = (format: string, url = 'file:///repo/src/a.ts') => load(url, {}, async () => ({ format, source: src }));
    expect((await loaded('module')).source).toMatch(/^import\.meta\.env \?\?=/);
    expect((await loaded('module-typescript')).source).toMatch(/^import\.meta\.env \?\?=/);
    expect((await loaded('commonjs-typescript')).source).toBe(src);
    expect((await loaded('module-typescript', 'file:///repo/node_modules/x/a.ts')).source).toBe(src);
    expect((await loaded('module-typescript', 'file:///elsewhere/a.ts')).source).toBe(src);
  });

  it('is added only for a Vite tree', async () => {
    const root = join(tmp.dir, 'no-vite');
    writeTree(root, { 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }) });
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect((p.runner.nodeArgs ?? []).some((a) => a.includes('import-meta-env'))).toBe(false);
  });

  it('keeps every line where it was (after a hashbang too)', () => {
    const src = 'const a = import.meta.env.MODE;\nconst b = 2;\n';
    const out: string = defineImportMetaEnv(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out.split('\n')[1]).toBe('const b = 2;');
    const bang: string = defineImportMetaEnv('#!/usr/bin/env node\nconst a = import.meta.env;\n');
    expect(bang.startsWith('#!/usr/bin/env node\nimport.meta.env ??=')).toBe(true);
    expect(bang.split('\n').length).toBe(3);
  });
});
