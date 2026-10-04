/**
 * The TargetProfile inside the rest of the harness: the check context's file lists and layout, the
 * contract extractor's source set, app-entry discovery and the source-boundary hook all follow the
 * API's own layout (lib/ instead of src/, tests/ instead of test/), and the template layout behaves
 * exactly as before.
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverEntries } from '../../plugins/lib/app-entry.ts';
import { apiSourceFiles } from '../../plugins/lib/contract.ts';
import { boundaryViolations } from '../../plugins/hooks/source-boundary.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { computeTargetProfile, setActiveLayout } from '../../src/core/target.ts';
import type { LogStore } from '../../src/core/types.ts';
import { scratch, writeTree } from './_variants.ts';

const tmp = scratch('integration');
afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };

const tsconfig = (include: string[]): string =>
  JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, allowImportingTsExtensions: true, noEmit: true }, include });

/** An API in lib/ with tests in tests/ (helpers included) and a tooling config at the root. */
const LIB_API = {
  'package.json': JSON.stringify({ name: 'lib-api', private: true, type: 'module', scripts: { test: 'vitest run' } }),
  'tsconfig.json': tsconfig(['lib', 'tests']),
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });\n",
  'lib/app.ts': "import express from 'express';\nexport function createApp() {\n  return express();\n}\n",
  'lib/routes/items.ts': 'export const items: string[] = [];\n',
  'lib/types.d.ts': 'export {};\n',
  'tests/helpers.ts': 'export const two = 2;\n',
  'tests/items.test.ts': "import { it } from 'vitest';\nit('x', () => {});\n",
  'scripts/seed.ts': 'export {};\n',
};

describe('a lib/ + tests/ API', () => {
  it('check context: source = lib/, tests = tests/ (helpers too), the layout is on the context', async () => {
    const root = join(tmp.dir, 'lib-api');
    writeTree(root, LIB_API);
    const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(ctx.sourceFiles).toEqual(['lib/app.ts', 'lib/routes/items.ts']);
    expect(ctx.testFiles).toEqual(['tests/helpers.ts', 'tests/items.test.ts']);
    expect(ctx.layout?.sourceRoots).toEqual(['lib']);
    // the contract extractor reads the very same source set
    expect(await apiSourceFiles(root)).toEqual(ctx.sourceFiles);
    // the probe's app discovery searches the layout's source roots (src/ and the root alone would miss lib/app.ts)
    expect(discoverEntries(root).candidates).toEqual([]);
    expect(discoverEntries(root, undefined, ctx.layout?.sourceRoots).candidates.map((c) => c.module)).toEqual(['lib/app.ts']);
  });

  it('a run profile given to the context wins over re-reading the config', async () => {
    const root = join(tmp.dir, 'lib-api-profile');
    writeTree(root, LIB_API);
    const profile = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs, layout: { ...profile, sourceRoots: ['lib/routes'] } });
    expect(ctx.sourceFiles).toEqual(['lib/routes/items.ts']);
  });

  it('source-boundary: lib/ code may import lib/ and packages, never tests/ or modules outside the source roots', async () => {
    const root = join(tmp.dir, 'lib-api-boundary');
    writeTree(root, LIB_API);
    setActiveLayout(await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT }));
    try {
      expect(boundaryViolations('lib/app.ts', "import { items } from './routes/items.ts';\nimport { z } from 'zod';\n")).toEqual([]);
      const keys = (content: string): string[] => boundaryViolations('lib/app.ts', content).map((v) => v.key);
      expect(keys("import { two } from '../tests/helpers.ts';\n")).toEqual(['test|tests/helpers.ts']);
      expect(keys("import '../scripts/seed.ts';\n")).toEqual(['outside|scripts/seed.ts']);
      expect(boundaryViolations('lib/app.ts', "import '../scripts/seed.ts';\n")[0]?.message).toContain('outside lib/');
    } finally {
      setActiveLayout(undefined);
    }
  });
});

describe('the template layout is unchanged', () => {
  it('src/ + test/: the same file lists, entry and boundary as before the profile', async () => {
    const root = join(tmp.dir, 'template');
    writeTree(root, {
      'package.json': JSON.stringify({ name: 't', private: true, type: 'module' }),
      'tsconfig.json': tsconfig(['src', 'test']),
      'src/app.ts': 'export {};\n',
      'src/lib/problem.ts': 'export {};\n',
      'test/helpers.ts': 'export {};\n',
      'test/a.test.ts': 'export {};\n',
    });
    const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(ctx.sourceFiles).toEqual(['src/app.ts', 'src/lib/problem.ts']);
    expect(ctx.testFiles).toEqual(['test/a.test.ts', 'test/helpers.ts']);
    expect(discoverEntries(root, undefined, ctx.layout?.sourceRoots).candidates.map((c) => c.module)).toEqual(['src/app.ts']);
    expect(boundaryViolations('src/app.ts', "import '../scripts/x.ts';\n")[0]?.message).toContain('outside src/');
  });
});
