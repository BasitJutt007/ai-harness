/**
 * TargetProfile: layout, runner and resolution are read from the API's own config, for many
 * layouts (property-style table, _variants.ts), and nothing broad enough to un-govern source
 * is ever accepted (negative cases).
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import {
  computeTargetProfile,
  defaultScopeAllow,
  formatProfile,
  isSourcePath,
  isTestPath,
  isTestSupportPath,
  LEGACY_LAYOUT,
  parseNodeTestScript,
  profileRecord,
  suggestTestPath,
} from '../../src/core/target.ts';
import type { TargetProfile } from '../../src/core/target.ts';
import { missingSourceModule } from '../../src/core/testing.ts';
import { buildTestMap, importSpecifiers, resolveImport } from '../../src/core/testmap.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { fakePackage, scratch, VARIANTS, writeTree } from './_variants.ts';

const tmp = scratch('profile');
afterAll(() => tmp.cleanup());

let n = 0;
async function profileOf(files: Record<string, string>): Promise<{ root: string; p: TargetProfile }> {
  n += 1;
  const root = join(tmp.dir, `v${n}`);
  writeTree(root, files);
  return { root, p: await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT }) };
}

describe.each(VARIANTS)('profile: $name', (v) => {
  it('reads runner, source roots, test dirs and a collected test path from the API itself', async () => {
    const { root, p } = await profileOf(v.files);
    expect(p.runner.kind).toBe(v.runner);
    expect(p.sourceRoots).toEqual(v.sourceRoots);
    expect(p.testSupportRoots).toEqual(v.testSupportRoots);
    expect(suggestTestPath(v.suggest.source, p)).toBe(v.suggest.test);
    // the suggested file is one the runner collects, and a real test of this layout
    expect(isTestPath(v.suggest.test, p)).toBe(true);
    // red and green files are tests; the source they exercise is governed source, never test support
    for (const t of [v.red.test, v.green.test]) expect(isTestPath(t, p), t).toBe(true);
    expect(isSourcePath(v.red.source, p)).toBe(true);
    expect(isTestSupportPath(v.red.source, p)).toBe(false);
    // the static import graph maps the red test to its source (relative, alias, require: whatever the API uses)
    const map = await buildTestMap(createWorkspace(root, '.'), p);
    expect(map.coverage[v.red.test]).toContain(v.red.source);
    expect(map.testsFor(v.red.source)).toContain(v.red.test);
    // the default write scope covers the source and the suggested test
    const scope = defaultScopeAllow(p);
    const { default: picomatch } = await import('picomatch');
    expect(picomatch(scope)(v.red.source), scope.join(', ')).toBe(true);
    expect(picomatch(scope)(v.suggest.test), scope.join(', ')).toBe(true);
    // the summary names all of it; run.json gets a JSON-safe record
    const text = formatProfile(p).join('\n');
    expect(text).toContain(`source ${v.sourceRoots.map((r) => `${r}/`).join(' ')}`);
    expect(JSON.parse(JSON.stringify(profileRecord(p)))).toMatchObject({ sourceRoots: v.sourceRoots, runner: { kind: v.runner } });
  });
});

describe('profile: other shapes', () => {
  it('no tsconfig: the whole root minus test dirs is source (noted), tooling config never is', async () => {
    const { p } = await profileOf({ 'package.json': '{"type":"module"}', 'app.ts': 'export const a = 1;\n', 'lib/x.ts': 'export const x = 1;\n', 'vitest.config.ts': 'export default {};\n', 'test/a.test.ts': '' });
    expect(p.sourceRoots).toEqual(['.']);
    expect(p.notes.join('\n')).toMatch(/no tsconfig\.json/);
    expect(isSourcePath('app.ts', p)).toBe(true);
    expect(isSourcePath('lib/x.ts', p)).toBe(true);
    expect(isSourcePath('vitest.config.ts', p)).toBe(false);
    expect(isSourcePath('test/helper.ts', p)).toBe(false);
  });

  it('tsconfig rootDir is the source root; solution-style references are followed', async () => {
    const a = await profileOf({ 'tsconfig.json': JSON.stringify({ compilerOptions: { rootDir: 'app', outDir: 'dist' }, include: ['app', 'spec'] }), 'app/x.ts': '', 'spec/x.spec.ts': '' });
    expect(a.p.sourceRoots).toEqual(['app']);
    expect(a.p.testSupportRoots).toEqual(['spec']);
    const b = await profileOf({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({ include: ['server'] }),
      'server/x.ts': '',
      'test/x.test.ts': '',
    });
    expect(b.p.sourceRoots).toEqual(['server']);
  });

  it('entry from package.json main/start maps dist/*.js back to the TypeScript source', async () => {
    const { p } = await profileOf({
      'package.json': JSON.stringify({ main: 'dist/index.js', scripts: { start: 'node dist/index.js' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { rootDir: 'source', outDir: 'dist' }, include: ['source'] }),
      'source/index.ts': '',
    });
    expect(p.entryCandidates[0]).toBe('source/index.ts');
  });

  it('node:test script: patterns and loader flags are taken from the script', () => {
    expect(parseNodeTestScript('node --test test/')).toEqual({ globs: ['test/**/*.test.?(c|m)[jt]s'], nodeArgs: [], tsx: false });
    expect(parseNodeTestScript('node --import tsx --test "tests/**/*.test.ts"')).toEqual({ globs: ['tests/**/*.test.ts'], nodeArgs: ['--import=tsx'], tsx: false });
    expect(parseNodeTestScript('tsc && tsx --test --test-concurrency 1 spec/*.ts')?.globs).toEqual(['spec/*.ts']);
    expect(parseNodeTestScript('vitest run')).toBeNull();
  });

  it('zod: major and converter from the installed package; zod 3 without zod-to-json-schema is reported', async () => {
    const a = await profileOf({ 'package.json': JSON.stringify({ dependencies: { zod: '^3.23.8' } }) });
    fakePackage(join(a.root, 'node_modules'), 'zod', '3.23.8');
    const z3 = await computeTargetProfile({ apiRoot: a.root, repoRoot: a.root, harnessRoot: HARNESS_ROOT });
    expect(z3.zod).toMatchObject({ version: '3.23.8', major: 3, origin: 'target', converter: 'unavailable' });
    expect(z3.notes.join('\n')).toContain('zod 3 schemas need zod-to-json-schema');
    fakePackage(join(a.root, 'node_modules'), 'zod-to-json-schema', '3.24.1');
    const withConverter = await computeTargetProfile({ apiRoot: a.root, repoRoot: a.root, harnessRoot: HARNESS_ROOT });
    expect(withConverter.zod.converter).toBe('zod-to-json-schema');
    const b = await profileOf({ 'package.json': '{}' });
    expect(b.p.zod).toMatchObject({ major: 4, origin: 'harness', converter: 'toJSONSchema' });
  });

  it('dependencies record where express/zod/vitest/typescript resolve from (target vs harness)', async () => {
    const { root } = await profileOf({ 'package.json': JSON.stringify({ dependencies: { express: '^4.21.0' } }) });
    fakePackage(join(root, 'node_modules'), 'express', '4.21.2');
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.dependencies['express']).toMatchObject({ version: '4.21.2', origin: 'target', declared: '^4.21.0' });
    expect(p.dependencies['vitest']).toMatchObject({ origin: 'harness' });
    expect(p.framework).toMatchObject({ name: 'express', version: '4.21.2', supported: true });
  });
});

describe('profile: unsupported targets are refused at preflight (UNPROVEN), never guessed', () => {
  it('an unsupported runner (mocha) and a non-Express framework (fastify) are named', async () => {
    const { p } = await profileOf({ 'package.json': JSON.stringify({ dependencies: { fastify: '^5.0.0' }, scripts: { test: 'mocha -r ts-node/register test/**/*.ts' } }) });
    expect(p.runner).toMatchObject({ kind: 'unknown', name: 'mocha', supported: false });
    expect(p.unsupported.join('\n')).toMatch(/unsupported test runner mocha/);
    expect(p.unsupported.join('\n')).toMatch(/framework fastify: .*Express only.*UNPROVEN/);
    expect(formatProfile(p).join('\n')).toMatch(/UNPROVEN: unsupported test runner mocha/);
  });

  it('jest declared but not installed: unsupported with the precise reason (no fake jest run)', async () => {
    const jest = VARIANTS.find((v) => v.runner === 'jest');
    if (jest === undefined) throw new Error('jest variant missing');
    const { p } = await profileOf(jest.files);
    expect(p.runner).toMatchObject({ kind: 'jest', supported: false });
    expect(p.runner.reason).toMatch(/jest is not installed in the target's node_modules/);
    expect(p.unsupported.join('\n')).toMatch(/jest is not installed/);
  });

  it('an installed jest is used (its own bin) from 29 on; older jest is refused: it may run tests in the reporting process', async () => {
    const jest = VARIANTS.find((v) => v.runner === 'jest');
    if (jest === undefined) throw new Error('jest variant missing');
    for (const [version, supported] of [['29.7.0', true], ['30.0.5', true], ['28.1.3', false], ['27.5.1', false]] as const) {
      const { root } = await profileOf(jest.files);
      writeTree(join(root, 'node_modules', 'jest'), {
        'package.json': JSON.stringify({ name: 'jest', version, bin: { jest: './bin/jest.js' } }),
        'bin/jest.js': '',
      });
      const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
      expect(p.runner.supported, version).toBe(supported);
      if (supported) expect(p.runner).toMatchObject({ kind: 'jest', bin: join(root, 'node_modules', 'jest', 'bin', 'jest.js'), origin: 'target', version });
      else expect(p.runner.reason).toMatch(/jest < 29 may run tests inside the reporting process/);
    }
  });

  it('a framework is detected from imports when package.json declares none', async () => {
    const { p } = await profileOf({ 'package.json': '{}', 'tsconfig.json': JSON.stringify({ include: ['src'] }), 'src/app.ts': "import Koa from 'koa';\nexport const app = new Koa();\n" });
    expect(p.framework).toMatchObject({ name: 'koa', supported: false });
  });
});

describe('profile: negative cases (no loosening)', () => {
  it('a test-named dir that source imports from stays governed source', async () => {
    const { p } = await profileOf({
      'tsconfig.json': JSON.stringify({ include: ['src', 'test'] }),
      'vitest.config.ts': "export default { test: { include: ['test/**/*.test.ts'] } };\n",
      'src/app.ts': "import { data } from '../test/fixtures/data.ts';\nexport const app = data;\n",
      'test/fixtures/data.ts': 'export const data = 1;\n',
      'test/a.test.ts': '',
    });
    expect(p.testSupportRoots).toEqual([]);
    expect(isTestSupportPath('test/fixtures/data.ts', p)).toBe(false);
    expect(isSourcePath('test/fixtures/data.ts', p)).toBe(true);
    expect(p.notes.join('\n')).toMatch(/source outside it imports from it/);
  });

  it('a broad runner include never turns source into tests or test support', async () => {
    const { p } = await profileOf({
      'tsconfig.json': JSON.stringify({ include: ['src', 'test'] }),
      'vitest.config.ts': "export default { test: { include: ['**/*.ts'] } };\n",
      'src/app.ts': '',
      'test/a.test.ts': '',
      'test/helper.ts': '',
    });
    expect(isTestPath('src/app.ts', p)).toBe(false);
    expect(isTestSupportPath('src/app.ts', p)).toBe(false);
    expect(isSourcePath('src/app.ts', p)).toBe(true);
    // inside the dedicated test dir the runner's include is the truth: it collects helper.ts as a test file
    expect(isTestPath('test/helper.ts', p)).toBe(true);
  });

  it('colocated tests: the source dir is never a test-support dir', async () => {
    const colocated = VARIANTS.find((v) => v.name.startsWith('colocated'));
    if (colocated === undefined) throw new Error('colocated variant missing');
    const { p } = await profileOf(colocated.files);
    expect(isTestSupportPath('src/math.ts', p)).toBe(false);
    expect(isTestSupportPath('src/util/format.ts', p)).toBe(false);
    expect(isSourcePath('src/util/format.ts', p)).toBe(true);
  });

  it('a non-conventional dir inside the tsconfig build is not a test dir just because a glob is rooted there', async () => {
    const { p } = await profileOf({
      'tsconfig.json': JSON.stringify({ include: ['src', 'checks'] }),
      'vitest.config.ts': "export default { test: { include: ['checks/**/*.test.ts'] } };\n",
      'src/app.ts': '',
      'checks/a.test.ts': '',
      'checks/util.ts': '',
    });
    expect(p.testSupportRoots).toEqual([]);
    expect(isSourcePath('checks/util.ts', p)).toBe(true);
    // …but outside the build it is (tsconfig does not compile it: it is not shipped source)
    const out = await profileOf({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'vitest.config.ts': "export default { test: { include: ['checks/**/*.test.ts'] } };\n",
      'src/app.ts': '',
      'checks/a.test.ts': '',
      'checks/util.ts': '',
    });
    expect(out.p.testSupportRoots).toEqual(['checks']);
    expect(isTestSupportPath('checks/util.ts', out.p)).toBe(true);
  });

  it('LEGACY_LAYOUT (no profile) keeps the template semantics', () => {
    expect(isTestSupportPath('test/helpers.ts', LEGACY_LAYOUT)).toBe(true);
    expect(isTestSupportPath('tests/helpers.ts', LEGACY_LAYOUT)).toBe(false);
    expect(isSourcePath('src/a.ts', LEGACY_LAYOUT)).toBe(true);
    expect(isSourcePath('lib/a.ts', LEGACY_LAYOUT)).toBe(false);
    expect(suggestTestPath('src/routes/index.ts', LEGACY_LAYOUT)).toBe('test/routes.test.ts');
  });
});

describe('import resolution (testmap): the API resolves specifiers, the graph follows', () => {
  it('relative, tsconfig paths, baseUrl, runner aliases, package imports; packages stay external', async () => {
    const { p } = await profileOf({
      'package.json': JSON.stringify({ imports: { '#lib/*': './src/lib/*.js', '#db': { import: './src/db/index.ts', default: './src/db/index.ts' } } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~app/*': ['src/app/*'], 'cfg': ['src/config.ts'] } }, include: ['src', 'test'] }),
      'vitest.config.ts': "import path from 'node:path';\nexport default { resolve: { alias: [{ find: '@src', replacement: path.resolve(__dirname, 'src') }] }, test: { include: ['test/**/*.test.ts'] } };\n",
      'src/app/users.ts': '',
      'src/config.ts': '',
      'src/lib/errors.ts': '',
      'src/db/index.ts': '',
      'src/plain.ts': '',
    });
    const existing = new Set(['src/app/users.ts', 'src/config.ts', 'src/lib/errors.ts', 'src/db/index.ts', 'src/plain.ts']);
    const from = 'test/a.test.ts';
    expect(resolveImport(from, '../src/plain.js', existing, p)).toBe('src/plain.ts');
    expect(resolveImport(from, '~app/users', existing, p)).toBe('src/app/users.ts');
    expect(resolveImport(from, '~app/new-thing.js', existing, p)).toBe('src/app/new-thing.ts'); // not written yet: kept
    expect(resolveImport(from, 'cfg', existing, p)).toBe('src/config.ts');
    expect(resolveImport(from, 'src/plain', existing, p)).toBe('src/plain.ts'); // baseUrl
    expect(resolveImport(from, '@src/lib/errors.ts', existing, p)).toBe('src/lib/errors.ts');
    expect(resolveImport(from, '#lib/errors', existing, p)).toBe('src/lib/errors.ts');
    expect(resolveImport(from, '#db', existing, p)).toBe('src/db/index.ts');
    for (const pkg of ['express', 'zod/v4', '@types/node', 'node:fs', 'vitest']) expect(resolveImport(from, pkg, existing, p), pkg).toBeNull();
    expect(resolveImport(from, '../../outside.ts', existing, p)).toBeNull();
  });

  it('alias keys with a trailing slash, and a non-static alias is noted (not followed, not guessed)', async () => {
    const { p } = await profileOf({
      'tsconfig.json': JSON.stringify({ include: ['src', 'test'] }),
      'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({ resolve: { alias: { '~/': './src/', '#gen': computeDir() } } });\n",
      'src/a.ts': '',
    });
    expect(resolveImport('test/x.test.ts', '~/a', new Set(['src/a.ts']), p)).toBe('src/a.ts');
    expect(resolveImport('test/x.test.ts', '#gen/x', new Set(), p)).toBeNull();
    expect(p.notes.join('\n')).toMatch(/resolve\.alias "#gen" .* not a static path/);
  });

  it('a missing module behind an alias is a missing-source red; behind a package or a test helper it is not', async () => {
    const pathsVariant = VARIANTS.find((v) => v.name.startsWith('tsconfig paths'));
    if (pathsVariant === undefined) throw new Error('paths variant missing');
    const { root, p } = await profileOf(pathsVariant.files);
    const from = join(root, 'test/red.test.ts');
    expect(missingSourceModule(root, `Error: Failed to resolve import "@/users/store.ts" from "${from}". Does the file exist?`, p)).toBe('src/users/store.ts');
    expect(missingSourceModule(root, `Error: Failed to resolve import "@/math.ts" from "${from}".`, p)).toBeNull(); // exists
    expect(missingSourceModule(root, `Cannot find package 'left-pad' imported from ${from}`, p)).toBeNull();
    expect(missingSourceModule(root, `Error: Failed to resolve import "./helpers/nope.ts" from "${from}".`, p)).toBeNull();
    expect(missingSourceModule(root, "Cannot find module '../src/billing' from 'test/red.test.ts'", p)).toBe('src/billing.ts');
  });

  it('require(), import x = require() and jest.mock() are import edges', () => {
    const text = [
      "const { a } = require('./a');",
      "import b = require('./b');",
      "jest.mock('./c');",
      "const d = jest.requireActual('./d');",
      "vi.mock('./e');",
      "const notAnImport = someRequire('./f');",
    ].join('\n');
    expect(importSpecifiers('x.ts', text)).toEqual(['./a', './b', './c', './d', './e']);
  });
});
