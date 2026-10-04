/**
 * App entry discovery, harness side (reads files only): which modules the probe runtime tries, in
 * which order, for many project layouts. The runtime side (loading them, finding the app) is in
 * probe-layouts.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeSearch, discoverEntries, parseEntry, scriptFiles, tsSourceOf } from '../../plugins/lib/app-entry.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway project with these files (contents irrelevant unless JSON). */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'app-entry-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const pkg = (o: Record<string, unknown>): string => JSON.stringify({ name: 'x', type: 'module', ...o });
const tsconfig = (o: Record<string, unknown>): string => JSON.stringify({ compilerOptions: { strict: true, ...o } });

describe('parseEntry', () => {
  it.each([
    [{ module: 'src/app.ts', export: 'createApp' }, { module: 'src/app.ts', export: 'createApp' }],
    [{ module: 'lib/server.ts' }, { module: 'lib/server.ts' }],
    ['src/app.ts#buildApp', { module: 'src/app.ts', export: 'buildApp' }],
    ['src/main.ts', { module: 'src/main.ts' }],
    ['src/main.ts#', { module: 'src/main.ts' }],
  ])('%j -> %j', (raw, want) => {
    expect(parseEntry(raw)).toEqual(want);
  });

  it.each([[undefined], [null], [''], ['#createApp'], [{ export: 'createApp' }], [{ module: 3 }], [42]])('rejects %j', (raw) => {
    expect(parseEntry(raw)).toBeUndefined();
  });
});

describe('scriptFiles', () => {
  it.each([
    ['tsx src/server.ts', ['src/server.ts']],
    ['tsx watch src/index.ts', ['src/index.ts']],
    ['node dist/main.js', ['dist/main.js']],
    ['node --import tsx ./lib/start.mts', ['./lib/start.mts']],
    ['ts-node -r tsconfig-paths/register src/app.ts', ['src/app.ts']],
    ['npm run build && node build/boot.cjs', ['build/boot.cjs']],
    ['nodemon --exec "ts-node src/index.ts"', ['src/index.ts']],
    ['NODE_ENV=production node dist/index.js --port=8080', ['dist/index.js']],
    ['vitest run', []],
    ['node -e "require(\'x\')" config.json', []],
  ])('%s -> %j', (cmd, want) => {
    expect(scriptFiles(cmd)).toEqual(want);
  });
});

describe('tsSourceOf: built JavaScript and bare paths map back to the TypeScript source', () => {
  const root = project({
    'src/index.ts': '',
    'src/http/index.ts': '',
    'src/boot/server.ts': '',
    'lib/start.mts': '',
    'tools/run.cts': '',
  });
  it.each([
    ['src/index.ts', 'src/index.ts'],
    ['./src/index.ts', 'src/index.ts'],
    ['src/index.js', 'src/index.ts'],
    ['dist/index.js', 'src/index.ts'],
    ['build/boot/server.js', 'src/boot/server.ts'],
    ['out/http/index.js', 'src/http/index.ts'],
    ['src/http', 'src/http/index.ts'],
    ['src/index', 'src/index.ts'],
    ['./lib/start.mjs', 'lib/start.mts'],
    ['tools/run.cjs', 'tools/run.cts'],
  ])('%s -> %s', (from, want) => {
    expect(tsSourceOf(root, from)).toBe(want);
  });

  it.each([['dist/index.d.ts'], ['dist/missing.js'], ['../outside/app.ts'], ['/etc/app.ts'], [''], ['.'], ['src/index.json']])('%s -> nothing', (from) => {
    expect(tsSourceOf(root, from)).toBeUndefined();
  });

  it('uses tsconfig outDir/rootDir when they are set', () => {
    const custom = project({ 'tsconfig.json': tsconfig({ rootDir: 'source', outDir: 'compiled' }), 'source/entry.ts': '', 'src/entry.ts': '' });
    expect(tsSourceOf(custom, 'compiled/entry.js')).toBe('source/entry.ts');
    // without tsconfig the usual folders map to src/
    expect(tsSourceOf(project({ 'src/entry.ts': '' }), 'dist/entry.js')).toBe('src/entry.ts');
  });
});

describe('discoverEntries', () => {
  const modules = (root: string): string[] => discoverEntries(root).candidates.map((c) => c.module);

  it.each<[string, Record<string, string>, string[]]>([
    ['template layout', { 'src/app.ts': '', 'src/server.ts': '', 'package.json': pkg({ scripts: { start: 'tsx src/server.ts' } }) }, ['src/app.ts', 'src/server.ts']],
    ['all four conventional names, in order', { 'src/main.ts': '', 'src/server.ts': '', 'src/index.ts': '', 'src/app.ts': '' }, ['src/app.ts', 'src/index.ts', 'src/server.ts', 'src/main.ts']],
    ['index only', { 'src/index.ts': '' }, ['src/index.ts']],
    ['root-level files after src/', { 'index.ts': '', 'app.ts': '', 'src/server.ts': '' }, ['src/server.ts', 'app.ts', 'index.ts']],
    ['tsconfig rootDir lib', { 'tsconfig.json': tsconfig({ rootDir: 'lib' }), 'lib/server.ts': '' }, ['lib/server.ts']],
    ['.mts entry', { 'src/main.mts': '' }, ['src/main.mts']],
    ['package.json main (built)', { 'src/http/bootstrap.ts': '', 'package.json': pkg({ main: 'dist/http/bootstrap.js' }) }, ['src/http/bootstrap.ts']],
    ['package.json main dist/index.js with src/index.ts', { 'src/index.ts': '', 'package.json': pkg({ main: 'dist/index.js' }) }, ['src/index.ts']],
    ['package.json exports with conditions', { 'src/api/entry.ts': '', 'package.json': pkg({ exports: { '.': { types: './dist/api/entry.d.ts', import: './dist/api/entry.js' }, './package.json': './package.json' } }) }, ['src/api/entry.ts']],
    ['package.json exports string', { 'src/lib.ts': '', 'package.json': pkg({ exports: './dist/lib.js' }) }, ['src/lib.ts']],
    ['scripts.start runs a built file', { 'src/boot/serve.ts': '', 'package.json': pkg({ scripts: { build: 'tsc', start: 'node dist/boot/serve.js' } }) }, ['src/boot/serve.ts']],
    ['scripts.dev only', { 'server/main.ts': '', 'package.json': pkg({ scripts: { dev: 'tsx watch server/main.ts' } }) }, ['server/main.ts']],
    ['conventional before declared, no duplicates', { 'src/app.ts': '', 'src/server.ts': '', 'package.json': pkg({ main: 'dist/server.js', scripts: { start: 'node dist/server.js', dev: 'tsx src/app.ts' } }) }, ['src/app.ts', 'src/server.ts']],
    ['nothing', { 'src/lib/util.ts': '', 'package.json': pkg({ scripts: { test: 'vitest run' } }) }, []],
  ])('%s', (_name, files, want) => {
    expect(modules(project(files))).toEqual(want);
  });

  it('an explicit entry comes first, then the manifest entry, each with its export', () => {
    const root = project({
      'src/app.ts': '',
      'src/alt/entry.ts': '',
      'src/other.ts': '',
      'harness.template.json': JSON.stringify({ name: 'express-zod', entry: { module: 'src/app.ts', export: 'createApp' } }),
    });
    expect(discoverEntries(root).candidates.map((c) => [c.module, c.export, c.why])).toEqual([['src/app.ts', 'createApp', 'entry in harness.template.json']]);
    expect(discoverEntries(root, { module: 'src/alt/entry.ts', export: 'makeAltApp' }).candidates.map((c) => [c.module, c.export])).toEqual([
      ['src/alt/entry.ts', 'makeAltApp'],
      ['src/app.ts', 'createApp'],
    ]);
  });

  it('a declared entry without a TypeScript source is reported, and discovery goes on', () => {
    const root = project({ 'src/index.ts': '', 'package.json': pkg({ main: 'dist/gone.js' }), 'harness.template.json': JSON.stringify({ entry: 'src/missing.ts#createApp' }) });
    const d = discoverEntries(root);
    expect(d.candidates.map((c) => c.module)).toEqual(['src/index.ts']);
    expect(d.missing).toEqual(['src/missing.ts (entry in harness.template.json)', 'dist/gone.js (package.json "main")']);
  });

  it('a malformed manifest or package.json is ignored, not fatal', () => {
    const root = project({ 'src/server.ts': '', 'package.json': '{ nope', 'harness.template.json': '[' });
    expect(modules(root)).toEqual(['src/server.ts']);
  });

  // The API's layout (TargetProfile source roots, from its tsconfig include/rootDir) widens the search
  // beyond src/ and rootDir; with no layout the result is unchanged (the first row).
  it.each<[string, Record<string, string>, string[], string[]]>([
    ['include lib/, no layout passed', { 'tsconfig.json': JSON.stringify({ include: ['lib'] }), 'lib/app.ts': '' }, [], []],
    ['include lib/, layout source root lib', { 'tsconfig.json': JSON.stringify({ include: ['lib'] }), 'lib/app.ts': '', 'lib/util.ts': '' }, ['lib'], ['lib/app.ts']],
    ['two source roots, in layout order', { 'server/main.ts': '', 'api/index.ts': '' }, ['server', 'api'], ['server/main.ts', 'api/index.ts']],
    ['src/ still first', { 'src/server.ts': '', 'service/app.ts': '' }, ['service'], ['src/server.ts', 'service/app.ts']],
    ['built main mapped into a source root', { 'service/http/boot.ts': '', 'package.json': pkg({ main: 'dist/http/boot.js' }) }, ['service'], ['service/http/boot.ts']],
    ['root as a source root', { 'main.ts': '', 'package.json': pkg({ main: 'dist/main.js' }) }, ['.'], ['main.ts']],
  ])('layout: %s', (_name, files, roots, want) => {
    const d = discoverEntries(project(files), undefined, roots);
    expect(d.candidates.map((c) => c.module)).toEqual(want);
    for (const r of roots.filter((x) => x !== '.')) expect(d.searched).toContain(`${r}/app.ts`);
  });

  it('the UNPROVEN text names every place that was looked at', () => {
    const d = discoverEntries(project({ 'tsconfig.json': tsconfig({ rootDir: 'lib' }), 'package.json': pkg({ main: 'dist/x.js' }) }));
    const text = describeSearch(d);
    for (const f of ['src/app.ts', 'src/index.ts', 'src/server.ts', 'src/main.ts', 'lib/app.ts', 'app.ts', 'index.ts', 'dist/x.js (package.json "main")']) expect(text).toContain(f);
  });
});
