/**
 * Target API variants for the TargetProfile tests: the same tiny API (a pure `add` function, a
 * failing test that asserts on it, a green test with two cases) in the layouts and toolchains a
 * grader's API may use. Trimmed from the audit's runtime-assumption variants (src→lib rename,
 * tests/ dir, tsconfig paths + vite alias, CommonJS, jest-style, node:test, monorepo package,
 * zod 3) plus colocated tests. Written under <harness>/.harness/tmp so the harness's own
 * node_modules is the fallback (as for a worktree inside the harness root).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESS_ROOT } from '../../src/core/config.ts';

export interface Variant {
  name: string;
  files: Record<string, string>;
  /** Expected profile facts. */
  runner: 'vitest' | 'jest' | 'node-test' | 'unknown';
  sourceRoots: string[];
  testSupportRoots: string[];
  /** Where a new test for `source` should go (a path the runner collects). */
  suggest: { source: string; test: string };
  /** A test file failing on a real assertion against `source`. */
  red: { test: string; source: string };
  /** A green test file and its case keys ("describe > title"). */
  green: { test: string; cases: string[] };
  /** Runs the runner live (jest is not installed in the harness: its adapter is tested on a recorded report). */
  live: boolean;
}

const ADD = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const ADD_CJS = 'function add(a: number, b: number): number {\n  return a + b;\n}\nmodule.exports = { add };\n';
const pkg = (extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'variant-api', private: true, type: 'module', ...extra }, null, 2);
const tsconfig = (include: string[], options: Record<string, unknown> = {}): string =>
  JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, allowImportingTsExtensions: true, noEmit: true, ...options }, include }, null, 2);
const vitestConfig = (include: string[], opts: { imports?: string; resolve?: string } = {}): string =>
  `${opts.imports ?? ''}import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n${opts.resolve ?? ''}  test: { include: ${JSON.stringify(include)}, cache: false },\n});\n`;
const vitestRed = (from: string): string =>
  `import { describe, expect, it } from 'vitest';\nimport { add } from '${from}';\ndescribe('add', () => {\n  it('adds (red)', () => {\n    expect(add(1, 1)).toBe(3);\n  });\n});\n`;
const vitestGreen = (from: string): string =>
  `import { describe, expect, it } from 'vitest';\nimport { add } from '${from}';\ndescribe('add', () => {\n  it('adds two', () => {\n    expect(add(1, 1)).toBe(2);\n  });\n  it('adds zero', () => {\n    expect(add(2, 0)).toBe(2);\n  });\n});\n`;
const GREEN_CASES = ['add > adds two', 'add > adds zero'];
const VITEST_DEPS = { devDependencies: { vitest: '5.0.3', typescript: '6.0.3' }, scripts: { test: 'vitest run' } };

export const VARIANTS: Variant[] = [
  {
    name: 'template (src/ + test/)',
    files: {
      'package.json': pkg(VITEST_DEPS),
      'tsconfig.json': tsconfig(['src', 'test']),
      'vitest.config.ts': vitestConfig(['test/**/*.test.ts']),
      'src/math.ts': ADD,
      'test/helpers.ts': 'export const two = 2;\n',
      'test/red.test.ts': vitestRed('../src/math.ts'),
      'test/green.test.ts': vitestGreen('../src/math.ts'),
    },
    runner: 'vitest',
    sourceRoots: ['src'],
    testSupportRoots: ['test'],
    suggest: { source: 'src/routes/users.ts', test: 'test/users.test.ts' },
    red: { test: 'test/red.test.ts', source: 'src/math.ts' },
    green: { test: 'test/green.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'src renamed to lib/',
    files: {
      'package.json': pkg({ ...VITEST_DEPS, scripts: { test: 'vitest run', start: 'tsx lib/server.ts' } }),
      'tsconfig.json': tsconfig(['lib', 'test']),
      'vitest.config.ts': vitestConfig(['test/**/*.test.ts']),
      'lib/math.ts': ADD,
      'lib/server.ts': "import { add } from './math.ts';\nconsole.log(add(1, 2));\n",
      'test/red.test.ts': vitestRed('../lib/math.ts'),
      'test/green.test.ts': vitestGreen('../lib/math.ts'),
    },
    runner: 'vitest',
    sourceRoots: ['lib'],
    testSupportRoots: ['test'],
    suggest: { source: 'lib/math.ts', test: 'test/math.test.ts' },
    red: { test: 'test/red.test.ts', source: 'lib/math.ts' },
    green: { test: 'test/green.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'tests/ directory (plural)',
    files: {
      'package.json': pkg(VITEST_DEPS),
      'tsconfig.json': tsconfig(['src', 'tests']),
      'vitest.config.ts': vitestConfig(['tests/**/*.test.ts']),
      'src/math.ts': ADD,
      'tests/helpers.ts': "export function make(): number {\n  return 2;\n}\n",
      'tests/red.test.ts': vitestRed('../src/math.ts'),
      'tests/green.test.ts': vitestGreen('../src/math.ts'),
    },
    runner: 'vitest',
    sourceRoots: ['src'],
    testSupportRoots: ['tests'],
    suggest: { source: 'src/math.ts', test: 'tests/math.test.ts' },
    red: { test: 'tests/red.test.ts', source: 'src/math.ts' },
    green: { test: 'tests/green.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'colocated src/*.test.ts',
    files: {
      'package.json': pkg(VITEST_DEPS),
      'tsconfig.json': tsconfig(['src']),
      'vitest.config.ts': vitestConfig(['src/**/*.test.ts']),
      'src/math.ts': ADD,
      'src/util/format.ts': "export const format = (n: number): string => String(n);\n",
      'src/math.red.test.ts': vitestRed('./math.ts'),
      'src/math.test.ts': vitestGreen('./math.ts'),
    },
    runner: 'vitest',
    sourceRoots: ['src'],
    testSupportRoots: [],
    suggest: { source: 'src/util/format.ts', test: 'src/util/format.test.ts' },
    red: { test: 'src/math.red.test.ts', source: 'src/math.ts' },
    green: { test: 'src/math.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'tsconfig paths + vite alias (@/…)',
    files: {
      'package.json': pkg(VITEST_DEPS),
      'tsconfig.json': tsconfig(['src', 'test'], { paths: { '@/*': ['./src/*'] } }),
      'vitest.config.ts': vitestConfig(['test/**/*.test.ts'], {
        imports: "import { fileURLToPath } from 'node:url';\n",
        resolve: "  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },\n",
      }),
      'src/math.ts': ADD,
      'test/red.test.ts': vitestRed('@/math.ts'),
      'test/green.test.ts': vitestGreen('@/math.ts'),
    },
    runner: 'vitest',
    sourceRoots: ['src'],
    testSupportRoots: ['test'],
    suggest: { source: 'src/math.ts', test: 'test/math.test.ts' },
    red: { test: 'test/red.test.ts', source: 'src/math.ts' },
    green: { test: 'test/green.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'CommonJS (no "type", module commonjs, extensionless imports)',
    files: {
      'package.json': JSON.stringify({ name: 'variant-cjs', private: true, ...VITEST_DEPS }),
      'tsconfig.json': tsconfig(['src', 'test'], { module: 'commonjs', moduleResolution: 'node', allowImportingTsExtensions: false }),
      'vitest.config.ts': vitestConfig(['test/**/*.test.ts']),
      'src/math.ts': ADD,
      'test/red.test.ts': vitestRed('../src/math'),
      'test/green.test.ts': vitestGreen('../src/math'),
    },
    runner: 'vitest',
    sourceRoots: ['src'],
    testSupportRoots: ['test'],
    suggest: { source: 'src/math.ts', test: 'test/math.test.ts' },
    red: { test: 'test/red.test.ts', source: 'src/math.ts' },
    green: { test: 'test/green.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'node:test, CommonJS require()',
    files: {
      'package.json': JSON.stringify({ name: 'variant-node-test', private: true, scripts: { test: 'node --test test/' } }),
      'tsconfig.json': tsconfig(['src', 'test'], { module: 'commonjs', moduleResolution: 'node', allowImportingTsExtensions: false }),
      'src/math.ts': ADD_CJS,
      'test/red.test.ts': "const { describe, it } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('../src/math.ts');\ndescribe('add', () => {\n  it('adds (red)', () => {\n    assert.equal(add(1, 1), 3);\n  });\n});\n",
      'test/green.test.ts': "const { describe, it } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('../src/math.ts');\ndescribe('add', () => {\n  it('adds two', () => {\n    assert.equal(add(1, 1), 2);\n  });\n  it('adds zero', () => {\n    assert.equal(add(2, 0), 2);\n  });\n});\n",
    },
    runner: 'node-test',
    sourceRoots: ['src'],
    testSupportRoots: ['test'],
    suggest: { source: 'src/math.ts', test: 'test/math.test.ts' },
    red: { test: 'test/red.test.ts', source: 'src/math.ts' },
    green: { test: 'test/green.test.ts', cases: GREEN_CASES },
    live: true,
  },
  {
    name: 'jest (roots, testMatch, moduleNameMapper)',
    files: {
      'package.json': pkg({ devDependencies: { jest: '29.7.0', 'ts-jest': '29.2.5' }, scripts: { test: 'jest' } }),
      'tsconfig.json': tsconfig(['src']),
      'jest.config.cjs': "module.exports = {\n  preset: 'ts-jest',\n  roots: ['<rootDir>/src'],\n  testMatch: ['**/__tests__/**/*.test.ts'],\n  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },\n};\n",
      'src/math.ts': ADD,
      'src/__tests__/helpers.ts': 'export const two = 2;\n',
      'src/__tests__/red.test.ts': "import { add } from '@/math';\ndescribe('add', () => {\n  it('adds (red)', () => {\n    expect(add(1, 1)).toBe(3);\n  });\n});\n",
      'src/__tests__/green.test.ts': "import { add } from '../math';\ndescribe('add', () => {\n  it('adds two', () => {\n    expect(add(1, 1)).toBe(2);\n  });\n  it('adds zero', () => {\n    expect(add(2, 0)).toBe(2);\n  });\n});\n",
    },
    runner: 'jest',
    sourceRoots: ['src'],
    testSupportRoots: ['src/__tests__'],
    suggest: { source: 'src/math.ts', test: 'src/__tests__/math.test.ts' },
    red: { test: 'src/__tests__/red.test.ts', source: 'src/math.ts' },
    green: { test: 'src/__tests__/green.test.ts', cases: GREEN_CASES },
    live: false,
  },
];

/** A throwaway directory under <harness>/.harness/tmp (node resolution falls back to the harness's node_modules). */
export function scratch(label: string): { dir: string; cleanup: () => void } {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `target-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** A minimal installed package (package.json + index.js) inside `nodeModules`. */
export function fakePackage(nodeModules: string, name: string, version: string, index = 'export const value = 1;\n'): void {
  writeTree(join(nodeModules, name), {
    'package.json': JSON.stringify({ name, version, type: 'module', main: 'index.js', exports: { '.': './index.js' } }),
    'index.js': index,
  });
}
