/**
 * Dependency resolution: an API inside a monorepo with its own node_modules AND a hoisted one at the
 * repository top resolves both in the worktree, in the revert copy and in the contract base snapshot,
 * wherever the worktree lives; the harness's node_modules is only the fallback. Zod: the converter is
 * picked per schema by the Zod major that built it, and a Zod 3 schema without zod-to-json-schema is
 * reported with that exact reason (never silently converted by Zod 4).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertAtRuntime, removeSnapshot, snapshotBase } from '../../plugins/lib/contract.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { newRunState } from '../../src/core/run-store.ts';
import { createServices } from '../../src/core/services.ts';
import { activeLayout, computeTargetProfile, LEGACY_LAYOUT, linkDependencies, setActiveLayout } from '../../src/core/target.ts';
import { runTargetTests } from '../../src/core/testing.ts';
import type { LogStore } from '../../src/core/types.ts';
import { createWorkspace, createWorktree, removeWorktree } from '../../src/core/workspace.ts';
import { emptyRegistry } from '../plugins/helpers.ts';
import { fakePackage, scratch, writeTree } from './_variants.ts';

const tmp = scratch('deps');
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A committed monorepo: deps installed at the top (top-dep) and in the API package (api-dep), both git-ignored. */
function monorepo(name: string, opts: { topModules: boolean }): string {
  const repo = join(tmp.dir, name);
  writeTree(repo, {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'packages/api/package.json': JSON.stringify({ name: 'api', private: true, type: 'module', dependencies: { 'api-dep': '1.0.0', ...(opts.topModules ? { 'top-dep': '1.0.0' } : {}) } }),
    'packages/api/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', allowImportingTsExtensions: true, noEmit: true, strict: true }, include: ['src', 'test'] }),
    'packages/api/vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
    'packages/api/src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'packages/api/test/deps.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { local } from 'api-dep';",
      opts.topModules ? "import { top } from 'top-dep';" : 'const top = 1;',
      "import { add } from '../src/math.ts';",
      "it('resolves the API package and the repository top node_modules', () => {",
      '  expect(add(top, local)).toBe(3);',
      '});',
      '',
    ].join('\n'),
  });
  fakePackage(join(repo, 'packages', 'api', 'node_modules'), 'api-dep', '1.0.0', 'export const local = 2;\n');
  if (opts.topModules) fakePackage(join(repo, 'node_modules'), 'top-dep', '1.0.0', 'export const top = 1;\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});

describe('linkDependencies', () => {
  it('links node_modules at every level from the top down to the API root, keeps existing entries, and only then a fallback', () => {
    const src = join(tmp.dir, 'link-src');
    const dest = join(tmp.dir, 'link-dest');
    mkdirSync(join(src, 'node_modules'), { recursive: true });
    mkdirSync(join(src, 'a', 'b', 'node_modules'), { recursive: true });
    mkdirSync(join(dest, 'a', 'node_modules'), { recursive: true }); // already there: kept
    const made = linkDependencies(src, 'a/b', dest, join(HARNESS_ROOT, 'node_modules'));
    expect(made.sort()).toEqual([join(dest, 'a', 'b', 'node_modules'), join(dest, 'node_modules')].sort());
    expect(realpathSync(join(dest, 'node_modules'))).toBe(realpathSync(join(src, 'node_modules')));
    expect(lstatSync(join(dest, 'a', 'node_modules')).isSymbolicLink()).toBe(false);
    // the fallback is used only where the target has nothing
    const bare = join(tmp.dir, 'link-dest-2');
    linkDependencies(join(tmp.dir, 'nothing-here'), '.', bare, join(HARNESS_ROOT, 'node_modules'));
    expect(realpathSync(join(bare, 'node_modules'))).toBe(realpathSync(join(HARNESS_ROOT, 'node_modules')));
  });
});

describe('monorepo package with its own and a hoisted node_modules', () => {
  const config = { ...loadConfig(), worktreeDir: '.harness/worktrees' };
  let repo: string;
  let fakeHarness: string;
  beforeAll(() => {
    repo = monorepo('mono', { topModules: true });
    fakeHarness = join(tmp.dir, 'harness-root');
    mkdirSync(fakeHarness, { recursive: true });
  });

  it('worktree inside the harness root: both levels linked; tests, the revert copy and the base snapshot resolve both', async () => {
    const wt = await createWorktree({ harnessRoot: fakeHarness, config, repoDir: repo, runId: 'mono-1', branch: 'harness/mono-1', apiRel: 'packages/api' });
    try {
      expect(realpathSync(join(wt.worktreeRoot, 'node_modules'))).toBe(realpathSync(join(repo, 'node_modules')));
      expect(realpathSync(join(wt.worktreeRoot, 'packages/api/node_modules'))).toBe(realpathSync(join(repo, 'packages/api/node_modules')));
      expect(existsSync(join(wt.worktreeRoot, 'packages/node_modules'))).toBe(false);

      const ws = createWorkspace(wt.worktreeRoot, 'packages/api');
      const profile = await computeTargetProfile({ apiRoot: ws.root, repoRoot: ws.repoRoot, harnessRoot: HARNESS_ROOT });
      expect(profile.dependencies['vitest']?.origin).toBe('harness'); // the target lacks it: harness fallback, recorded
      const report = await runTargetTests({ root: ws.root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: profile.runner, layout: profile });
      expect(report.ok, report.summary).toBe(true);

      // runTestsReverted builds a scratch copy elsewhere: it must resolve the same packages
      await ws.write('src/extra.ts', 'export const extra = 1;\n');
      const state = newRunState();
      const services = createServices({ ws, registry: emptyRegistry(), state, logs, exec, harnessRoot: HARNESS_ROOT, profile });
      expect(activeLayout()).toBe(profile);
      const reverted = await services.runTestsReverted(['test/deps.test.ts'], ['src/extra.ts']);
      expect(reverted.ok, reverted.summary).toBe(true);

      // the contract base snapshot (git archive of the API) links the same levels
      const snap = await snapshotBase({ repoRoot: wt.worktreeRoot, baseSha: wt.baseSha, rootRel: 'packages/api', harnessRoot: HARNESS_ROOT, exec });
      try {
        expect(existsSync(join(snap, 'node_modules', 'api-dep', 'package.json'))).toBe(true);
        expect(existsSync(join(snap, '..', '..', 'node_modules', 'top-dep', 'package.json'))).toBe(true);
      } finally {
        removeSnapshot(snap);
      }
    } finally {
      setActiveLayout(undefined);
      await removeWorktree(repo, wt.worktreeRoot);
    }
  });

  it('worktree outside the harness root: the same links, and no harness fallback over the target\'s own top', async () => {
    const outside = join(realpathSync(tmpdir()), `harness-target-wt-${process.pid}-${Date.now()}`);
    const wt = await createWorktree({ harnessRoot: fakeHarness, config: { ...config, worktreeDir: outside }, repoDir: repo, runId: 'mono-2', branch: 'harness/mono-2', apiRel: 'packages/api' });
    try {
      expect(realpathSync(join(wt.worktreeRoot, 'node_modules'))).toBe(realpathSync(join(repo, 'node_modules')));
      expect(realpathSync(join(wt.worktreeRoot, 'packages/api/node_modules'))).toBe(realpathSync(join(repo, 'packages/api/node_modules')));
    } finally {
      await removeWorktree(repo, wt.worktreeRoot);
    }
  });

  it('outside the harness root with no node_modules at the top: the harness is linked there as the fallback', async () => {
    const lone = monorepo('mono-no-top', { topModules: false });
    const harnessWithModules = join(tmp.dir, 'harness-with-modules');
    mkdirSync(join(harnessWithModules, 'node_modules'), { recursive: true });
    const outside = join(realpathSync(tmpdir()), `harness-target-wt2-${process.pid}-${Date.now()}`);
    const wt = await createWorktree({ harnessRoot: harnessWithModules, config: { ...config, worktreeDir: outside }, repoDir: join(lone, 'packages', 'api'), runId: 'mono-3', branch: 'harness/mono-3' });
    try {
      expect(realpathSync(join(wt.worktreeRoot, 'node_modules'))).toBe(realpathSync(join(harnessWithModules, 'node_modules')));
      expect(realpathSync(join(wt.worktreeRoot, 'packages/api/node_modules'))).toBe(realpathSync(join(lone, 'packages/api/node_modules')));
    } finally {
      await removeWorktree(lone, wt.worktreeRoot);
    }
  });
});

/**
 * The API's own vitest as an install leaves it: a real package directory in the API's node_modules (its
 * package.json and bin copied; the rest of its files linked to the harness's install to keep the fixture small).
 */
function ownVitest(nodeModules: string): void {
  const from = join(HARNESS_ROOT, 'node_modules', 'vitest');
  const to = join(nodeModules, 'vitest');
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === 'package.json' || name === 'vitest.mjs') copyFileSync(join(from, name), join(to, name));
    else symlinkSync(join(from, name), join(to, name));
  }
}

describe('the target\'s own test runner, installed in its node_modules', () => {
  it('runs confined from its real path, in the worktree and in the revert copy (the read fence never opens the worktree to the copy)', async () => {
    const repo = monorepo('own-runner', { topModules: true });
    ownVitest(join(repo, 'packages', 'api', 'node_modules'));
    const harnessRoot = join(tmp.dir, 'own-runner-harness');
    mkdirSync(harnessRoot, { recursive: true });
    const wt = await createWorktree({
      harnessRoot, config: { ...loadConfig(), worktreeDir: '.harness/worktrees' }, repoDir: repo, runId: 'own-1', branch: 'harness/own-1', apiRel: 'packages/api',
    });
    try {
      const ws = createWorkspace(wt.worktreeRoot, 'packages/api');
      const profile = await computeTargetProfile({ apiRoot: ws.root, repoRoot: ws.repoRoot, harnessRoot: HARNESS_ROOT });
      // found through the worktree's node_modules link, executed from where it really lives
      expect(profile.runner).toMatchObject({ kind: 'vitest', supported: true, origin: 'target' });
      expect(profile.runner.bin).toBe(realpathSync(join(repo, 'packages', 'api', 'node_modules', 'vitest', 'vitest.mjs')));
      const report = await runTargetTests({ root: ws.root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: profile.runner, layout: profile });
      expect(report.ok, report.summary).toBe(true);

      await ws.write('src/extra.ts', 'export const extra = 1;\n');
      const services = createServices({ ws, registry: emptyRegistry(), state: newRunState(), logs, exec, harnessRoot: HARNESS_ROOT, profile });
      const reverted = await services.runTestsReverted(['test/deps.test.ts'], ['src/extra.ts']);
      expect(reverted.ok, reverted.summary).toBe(true);
    } finally {
      setActiveLayout(undefined);
      await removeWorktree(repo, wt.worktreeRoot);
    }
  });
});

describe('zod: the converter follows the Zod major of each schema', () => {
  let api: string;
  beforeAll(() => {
    api = join(tmp.dir, 'zod-api');
    writeTree(api, {
      'package.json': JSON.stringify({ name: 'zod-api', private: true, type: 'module', dependencies: { zod: '4.6.5' } }),
      'src/legacy.ts': "import { z } from 'zod/v3';\nexport const Legacy = z.object({ name: z.string(), age: z.number().optional() });\n",
      'src/modern.ts': "import { z } from 'zod';\nexport const Modern = z.object({ name: z.string() });\n",
    });
  });
  const refs = [{ module: 'src/legacy.ts', exportName: 'Legacy' }, { module: 'src/modern.ts', exportName: 'Modern' }];

  it('Zod 3 schema without zod-to-json-schema: a precise error (static fallback, UNPROVEN on change); Zod 4 converts', async () => {
    const out = await convertAtRuntime({ apiRoot: api, harnessRoot: HARNESS_ROOT, exec, refs });
    expect(out[0]).toEqual({ module: 'src/legacy.ts', exportName: 'Legacy', error: 'zod 3 schemas need zod-to-json-schema (not resolvable from the API root)' });
    expect(out[1]?.input).toMatchObject({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
  });

  it('with zod-to-json-schema in the API, Zod 3 schemas convert through it (io-specific options)', async () => {
    // A minimal stand-in exposing the real package's interface: zodToJsonSchema(schema, options).
    fakePackage(join(api, 'node_modules'), 'zod-to-json-schema', '3.24.1', [
      'export function zodToJsonSchema(schema, opts) {',
      '  const conv = (s) => {',
      '    const d = s._def;',
      "    if (d.typeName === 'ZodObject') {",
      '      const properties = {}; const required = [];',
      '      for (const [k, v] of Object.entries(d.shape())) {',
      "        properties[k] = conv(v); if (v._def.typeName !== 'ZodOptional') required.push(k);",
      '      }',
      "      return { type: 'object', properties, required };",
      '    }',
      "    if (d.typeName === 'ZodOptional') return conv(d.innerType);",
      "    if (d.typeName === 'ZodString') return { type: 'string' };",
      "    if (d.typeName === 'ZodNumber') return { type: 'number' };",
      '    return {};',
      '  };',
      "  return { $schema: 'http://json-schema.org/draft-07/schema#', ...conv(schema), 'x-io': opts.pipeStrategy };",
      '}',
      '',
    ].join('\n'));
    const out = await convertAtRuntime({ apiRoot: api, harnessRoot: HARNESS_ROOT, exec, refs });
    expect(out[0]?.error).toBeUndefined();
    expect(out[0]?.input).toEqual({ type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name'], 'x-io': 'input' });
    expect(out[0]?.output).toMatchObject({ 'x-io': 'output' });
    expect(out[1]?.input).toMatchObject({ type: 'object' }); // Zod 4 still through toJSONSchema
  });

  it('the layout state is restored for other tests', () => {
    setActiveLayout(undefined);
    expect(activeLayout()).toBe(LEGACY_LAYOUT);
  });
});
