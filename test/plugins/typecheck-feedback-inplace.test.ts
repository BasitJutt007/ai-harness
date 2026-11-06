/**
 * typecheck-feedback IN PLACE (a session in the owner's checkout): the feedback says what the repository's
 * own type check (repo-typecheck / web-typecheck) would say. A written file is checked in the tsconfig project
 * whose program includes it (tsconfig.json, or every project a solution-style tsconfig references, parsed
 * fresh on every write), under that project's own options; a file no project includes gets no type errors,
 * because the gate does not type-check it. Every in-place change has its file-mode twin, which keeps the
 * forced-strict root-config behaviour the 01 rubric depends on.
 *
 * The fixture repositories live in the OS temp dir, outside the harness checkout (an in-place repository is
 * any checkout), and reach their packages through a node_modules SYMLINK to another directory, as a git
 * worktree sharing one install does.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import typecheckFeedback, { checkFiles, checkInPlace, MAX_OVERRUNS } from '../../plugins/hooks/typecheck-feedback.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import type { HookVerdict, RunContext } from '../../src/core/plugin-api.ts';
import { callInfo, callTool, fakeWorkspace, makeHarness, removeTmp, sha } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** A neutral types package a project names in "types" (the shape of a bundler's client types). */
const TINY_ENV = {
  'tiny-env/package.json': '{ "name": "tiny-env", "version": "1.0.0" }\n',
  'tiny-env/client.d.ts': 'declare const __APP_NAME__: string;\n',
};
/** A tiny stand-in for @types/node: just the node:test and node:assert/strict a test file imports. */
const FAKE_NODE_TYPES = {
  '@types/node/package.json': '{ "name": "@types/node", "version": "0.0.0", "types": "index.d.ts" }\n',
  '@types/node/index.d.ts': "declare module 'node:test' { export function test(name: string, fn: () => void): void; }\n"
    + "declare module 'node:assert/strict' { const assert: { equal(a: unknown, b: unknown): void }; export default assert; }\n",
};

const BASE_OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM'], strict: true, noEmit: true, skipLibCheck: true };
/** Solution-style root config (files: [] + references), as a bundler app template ships it. */
const SOLUTION = JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] });
const APP = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, types: ['tiny-env/client'] }, include: ['src'] });
const NODE = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, types: [] }, include: ['build.config.ts'] });
const SOLUTION_FILES = { 'tsconfig.json': SOLUTION, 'tsconfig.app.json': APP, 'tsconfig.node.json': NODE, 'build.config.ts': 'export default {};\n', 'src/add.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' };

/** The test the live session wrote: node:test, run through tsx (types stripped, never type-checked by the repository). */
const NODE_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add';\n\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n});\n";

interface Repo {
  /** The checkout as the session sees it (OS temp dir, NOT realpath'd: on macOS /var is a link to /private/var). */
  root: string;
  base: string;
}

/**
 * A repository in the OS temp dir. Its node_modules is a symlink to <base>/shared/node_modules, which holds
 * `packages` and, unless `typescript` is null, a node_modules/typescript/package.json of that version.
 */
function makeRepo(files: Record<string, string>, opts: { packages?: Record<string, string>; typescript?: string | null } = {}): Repo {
  const base = mkdtempSync(path.join(tmpdir(), 'tsfeedback-inplace-'));
  cleanups.push(async () => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const shared = path.join(base, 'shared', 'node_modules');
  mkdirSync(root, { recursive: true });
  const put = (abs: string, content: string): void => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) put(path.join(root, rel), content);
  mkdirSync(shared, { recursive: true });
  for (const [rel, content] of Object.entries(opts.packages ?? {})) put(path.join(shared, rel), content);
  const version = opts.typescript === undefined ? '5.9.3' : opts.typescript;
  if (version !== null) put(path.join(shared, 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version }));
  symlinkSync(shared, path.join(root, 'node_modules'), 'dir');
  return { root, base };
}

/** A run context over `repo`: in place (a session) unless `fileMode`. */
async function contextFor(repo: Repo, opts: { fileMode?: boolean } = {}): Promise<RunContext> {
  const h = await makeHarness({ label: 'tsfeedback-inplace' });
  cleanups.push(() => removeTmp(h.dir));
  const ctx: RunContext = { ...h.ctx, workspace: fakeWorkspace(repo.root, '') };
  return opts.fileMode === true ? ctx : { ...ctx, inPlace: { repoTop: repo.root, branch: 'feat/x' } };
}

/** Write through the real tool, then run the post hook on that call and its result (as the loop does). */
async function writeThenCheck(ctx: RunContext, p: string, content: string): Promise<HookVerdict> {
  const result = await callTool(writeFile, { path: p, content }, ctx);
  expect(result.ok).toBe(true);
  return typecheckFeedback.run({ event: 'post_tool', call: callInfo(writeFile, { path: p, content }), result }, ctx);
}

const noteOf = (v: HookVerdict): string => (v.decision === 'record' ? v.note : '');
/** Cold checks parse the TypeScript libs: a generous budget so a loaded machine cannot flake the assertions. */
const COLD = 60_000;

/**
 * Warm a file-mode service for `repo` with a cold budget, so the hook's own check (BUDGET_MS) that follows is
 * a warm one: a loaded machine cannot turn the twin's expected note into a cancelled check.
 */
function warmFileMode(repo: Repo): void {
  expect(checkFiles(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)).not.toBeNull();
}

describe('typecheck-feedback in place: the project that compiles the file, with its own options', () => {
  it('a test file no tsconfig project includes gets no type errors (the gate does not check it); the file-mode twin keeps the root-config check', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const abs = path.join(repo.root, 'test', 'add.test.ts');
    const inPlace = await contextFor(repo);
    const r = await writeThenCheck(inPlace, 'test/add.test.ts', NODE_TEST);
    // The live failure: "tsc: 6 error(s): test/...:1:22 TS2591 Cannot find name 'node:test'" for a file the gate never checks.
    expect(r).toEqual({ decision: 'pass' });
    expect(checkInPlace(repo.root, [abs], COLD)).toEqual({ errors: [], project: [], uncovered: ['test/add.test.ts'], skipped: null });

    // File mode (the 01 rubric): the root tsconfig.json's options with every strict flag forced, as before.
    const fileMode = await contextFor(repo, { fileMode: true });
    warmFileMode(repo);
    const twin = await writeThenCheck(fileMode, 'test/add.test.ts', NODE_TEST);
    expect(noteOf(twin)).toMatch(/^tsc: \d+ error\(s\): test\/add\.test\.ts:1:22 TS25(80|91) Cannot find name 'node:test'/);
  });

  it('a file the app project includes is checked: its real type error is recorded (the twin)', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    const v = await writeThenCheck(ctx, 'src/total.ts', "import { add } from './add';\nexport const total: number = add(1, '2');\n");
    expect(noteOf(v)).toBe("tsc: 1 error(s): src/total.ts:2:37 TS2345 Argument of type 'string' is not assignable to parameter of type 'number'.");
  });

  it("a project with types [node] that includes test/ checks its test files: a real error is recorded, a clean test passes", async () => {
    const withTests = JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.test.json' }] });
    const testProject = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, types: ['node'] }, include: ['test'] });
    const repo = makeRepo({ ...SOLUTION_FILES, 'tsconfig.json': withTests, 'tsconfig.test.json': testProject }, { packages: { ...TINY_ENV, ...FAKE_NODE_TYPES } });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    // The clean twin, with a cold budget (it also warms the test project for the hook's checks below).
    await callTool(writeFile, { path: 'test/add.test.ts', content: NODE_TEST }, ctx);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'test', 'add.test.ts')], COLD)).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(await writeThenCheck(ctx, 'test/add.test.ts', NODE_TEST)).toEqual({ decision: 'pass' });
    const bad = NODE_TEST.replace('add(1, 2)', "add(1, 'two')");
    expect(noteOf(await writeThenCheck(ctx, 'test/add.test.ts', bad))).toBe("tsc: 1 error(s): test/add.test.ts:6:23 TS2345 Argument of type 'string' is not assignable to parameter of type 'number'.");
  });

  it("in place the project's own options apply (no forced strict); the file-mode twin forces noUncheckedIndexedAccess", async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const first = 'export function first(xs: number[]): number {\n  const x = xs[0];\n  return x + 1;\n}\n';
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    expect(await writeThenCheck(ctx, 'src/first.ts', first)).toEqual({ decision: 'pass' });
    const fileMode = await contextFor(repo, { fileMode: true });
    warmFileMode(repo);
    expect(noteOf(await writeThenCheck(fileMode, 'src/first.ts', first))).toMatch(/^tsc: 1 error\(s\): src\/first\.ts:3:10 TS18048 /);
  });

  it('a NEW file matching an include glob counts on its first write (projects are parsed fresh, not cached)', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    // Warm the app project's service first, so a cached file list would not know the new file.
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    const v = await writeThenCheck(ctx, 'src/features/brand-new.ts', "export const n: number = 'one';\n");
    expect(noteOf(v)).toBe("tsc: 1 error(s): src/features/brand-new.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.");
  });

  it('ownership compares real paths: a project listing the file under another spelling still owns it', async () => {
    // The root as the session sees it is a symlink; the solution references the app project by its REAL path,
    // so the project's file list spells every file through the real directory.
    const repo = makeRepo({}, { packages: TINY_ENV });
    const real = path.join(realpathSync(repo.base), 'real');
    const files: Record<string, string> = { ...SOLUTION_FILES, 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: path.join(real, 'tsconfig.app.json') }] }) };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(real, rel)), { recursive: true });
      writeFileSync(path.join(real, rel), content);
    }
    rmSync(path.join(repo.root), { recursive: true, force: true });
    symlinkSync(real, repo.root, 'dir');
    symlinkSync(path.join(repo.base, 'shared', 'node_modules'), path.join(real, 'node_modules'), 'dir');
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    const v = await writeThenCheck(ctx, 'src/total.ts', "export const n: number = 'one';\n");
    expect(noteOf(v)).toBe("tsc: 1 error(s): src/total.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.");
    // A rewrite is read again (versioned by content under the real path too), not served from the first parse.
    const again = await writeThenCheck(ctx, 'src/total.ts', 'export const n: string = 2;\n');
    expect(noteOf(again)).toBe("tsc: 1 error(s): src/total.ts:1:14 TS2322 Type 'number' is not assignable to type 'string'.");
  });

  it('a file two projects list is checked under both, as the type check runs both: an error only the second raises is recorded', async () => {
    // The app project lists src/ without Node types; a test project lists src/ and test/ with them (listed second).
    const both = JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.test.json' }] });
    const appWithDom = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, lib: ['ES2022', 'DOM'], types: ['tiny-env/client'] }, include: ['src'] });
    const testProject = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, lib: ['ES2022'], types: ['node'] }, include: ['src', 'test'] });
    const repo = makeRepo({ ...SOLUTION_FILES, 'tsconfig.json': both, 'tsconfig.app.json': appWithDom, 'tsconfig.test.json': testProject }, { packages: { ...TINY_ENV, ...FAKE_NODE_TYPES } });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    // `document` exists only under the app project's DOM lib: the test project (no DOM) rejects it.
    const v = await writeThenCheck(ctx, 'src/title.ts', 'export const title: string = document.title;\n');
    expect(noteOf(v)).toBe("tsc: 1 error(s): src/title.ts:1:30 TS2584 Cannot find name 'document'. Do you need to change your target library? Try changing the 'lib' compiler option to include 'dom'.");
    // The twin: an error both projects raise is one line, not two.
    expect(noteOf(await writeThenCheck(ctx, 'src/title.ts', 'export const title: number = "t";\n'))).toBe("tsc: 1 error(s): src/title.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.");
  });

  it('a file one project lists and another imports is checked under both: an error only the importing project raises is recorded; with DOM in both, nothing', async () => {
    // The app project (DOM) lists src/; the test project (no DOM) lists only test/, whose test imports src/title.ts.
    // `tsc -p tsconfig.test.json` checks src/title.ts as part of its program, so the gate fails on it there.
    const solution = JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.test.json' }] });
    const app = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, lib: ['ES2022', 'DOM'], types: [] }, include: ['src'] });
    const testProject = (lib: string[]): string => JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, lib, types: [] }, include: ['test'] });
    const files = {
      'tsconfig.json': solution, 'tsconfig.app.json': app,
      'src/title.ts': "export const title: string = 'x';\n",
      'test/title.test.ts': "import { title } from '../src/title';\nexport const shown: string = title;\n",
    };
    const usesDom = 'export const title: string = document.title;\n';
    const noDom = makeRepo({ ...files, 'tsconfig.test.json': testProject(['ES2022']) });
    expect(checkInPlace(noDom.root, [path.join(noDom.root, 'src', 'title.ts')], COLD)).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(noteOf(await writeThenCheck(await contextFor(noDom), 'src/title.ts', usesDom))).toBe("tsc: 1 error(s): src/title.ts:1:30 TS2584 Cannot find name 'document'. Do you need to change your target library? Try changing the 'lib' compiler option to include 'dom'.");
    // The twin: the importing project has DOM too, so neither project rejects the file.
    const withDom = makeRepo({ ...files, 'tsconfig.test.json': testProject(['ES2022', 'DOM']) });
    expect(checkInPlace(withDom.root, [path.join(withDom.root, 'src', 'title.ts')], COLD)?.errors).toEqual([]);
    expect(await writeThenCheck(await contextFor(withDom), 'src/title.ts', usesDom)).toEqual({ decision: 'pass' });
  });

  it("the project's other files are part of its program: an ambient module declaration in src/ applies (the root-config twin reports TS2307)", async () => {
    const repo = makeRepo({ ...SOLUTION_FILES, 'src/assets.d.ts': "declare module '*.svg' {\n  const url: string;\n  export default url;\n}\n" }, { packages: TINY_ENV });
    const usesLogo = "import logo from './logo.svg';\nexport const src: string = logo;\n";
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    expect(await writeThenCheck(ctx, 'src/logo-src.ts', usesLogo)).toEqual({ decision: 'pass' });
    const fileMode = await contextFor(repo, { fileMode: true });
    warmFileMode(repo);
    expect(noteOf(await writeThenCheck(fileMode, 'src/logo-src.ts', usesLogo))).toMatch(/src\/logo-src\.ts:1:18 TS2307 /);
  });

  it('a file outside every include that a project file imports is in that program: its error is recorded; an unimported one is not', async () => {
    const repo = makeRepo({ ...SOLUTION_FILES, 'src/main.ts': "import { label } from '../shared/label';\nexport const shown: string = label;\n", 'shared/label.ts': "export const label: string = 'ok';\n" }, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'shared', 'label.ts')], COLD)?.errors).toEqual([]);
    expect(noteOf(await writeThenCheck(ctx, 'shared/label.ts', 'export const label: string = 42;\n'))).toBe("tsc: 1 error(s): shared/label.ts:1:14 TS2322 Type 'number' is not assignable to type 'string'.");
    // The twin: a file next to it that nothing imports is in no program.
    expect(await writeThenCheck(ctx, 'shared/unused.ts', 'export const unused: string = 42;\n')).toEqual({ decision: 'pass' });
    expect(checkInPlace(repo.root, [path.join(repo.root, 'shared', 'unused.ts')], COLD)?.uncovered).toEqual(['shared/unused.ts']);
  });
});

describe('typecheck-feedback in place: types from a symlinked node_modules, under the read fence', () => {
  it('a "types" entry resolved through a node_modules symlink raises no "Cannot find type definition file"', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(await writeThenCheck(ctx, 'src/name.ts', 'export const appName: string = __APP_NAME__;\n')).toEqual({ decision: 'pass' });
  });

  it('more project errors than the window holds: each shows once over the run, and the written file\'s own error shows on the first write', async () => {
    const missing = JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, lib: ['ES2022'], types: ['m1', 'm2', 'm3', 'm4'] }, include: ['src'] });
    const repo = makeRepo({ 'tsconfig.json': missing, 'src/a.ts': 'export {};\n' });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'a.ts')], COLD)?.project).toHaveLength(4);
    const lost = (m: string): string => `tsconfig.json TS2688 Cannot find type definition file for '${m}'.`;
    const own = "src/b.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.";
    const first = noteOf(await writeThenCheck(ctx, 'src/b.ts', "export const b: number = 'x';\n"));
    expect(first).toBe(`tsc: 5 error(s): ${lost('m1')}\n  ${lost('m2')}\n  ${own} (+2 more)`);
    const second = noteOf(await writeThenCheck(ctx, 'src/b.ts', "export const b: number = 'y';\n"));
    expect(second).toBe(`tsc: 3 error(s): ${lost('m3')}\n  ${lost('m4')}\n  ${own}`);
    expect(noteOf(await writeThenCheck(ctx, 'src/b.ts', "export const b: number = 'z';\n"))).toBe(`tsc: 1 error(s): ${own}`);
    // The twin: a clean file leaves the whole window to the project errors; the one that does not fit comes next.
    const clean = makeRepo({ 'tsconfig.json': missing, 'src/a.ts': 'export {};\n' });
    const cleanCtx = await contextFor(clean);
    expect(checkInPlace(clean.root, [path.join(clean.root, 'src', 'a.ts')], COLD)?.project).toHaveLength(4);
    expect(noteOf(await writeThenCheck(cleanCtx, 'src/b.ts', 'export const b = 1;\n'))).toBe(`tsc: 4 error(s): ${lost('m1')}\n  ${lost('m2')}\n  ${lost('m3')} (+1 more)`);
    expect(noteOf(await writeThenCheck(cleanCtx, 'src/b.ts', 'export const b = 2;\n'))).toBe(`tsc: 1 error(s): ${lost('m4')}`);
    expect(await writeThenCheck(cleanCtx, 'src/b.ts', 'export const b = 3;\n')).toEqual({ decision: 'pass' });
  });

  it('the twin: the package really missing records TS2688 once per run, and the error it causes in the file every time', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: {} });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.project).toEqual(["tsconfig.app.json TS2688 Cannot find type definition file for 'tiny-env/client'."]);
    const first = noteOf(await writeThenCheck(ctx, 'src/name.ts', 'export const appName: string = __APP_NAME__;\n'));
    expect(first).toBe("tsc: 2 error(s): tsconfig.app.json TS2688 Cannot find type definition file for 'tiny-env/client'.\n  src/name.ts:1:32 TS2304 Cannot find name '__APP_NAME__'.");
    const again = noteOf(await writeThenCheck(ctx, 'src/name.ts', 'export const appName: string = __APP_NAME__ + "";\n'));
    expect(again).toBe("tsc: 1 error(s): src/name.ts:1:32 TS2304 Cannot find name '__APP_NAME__'.");
  });
});

describe('typecheck-feedback in place: nothing configured, nothing recorded', () => {
  it('no tsconfig.json: no feedback in place (web-typecheck is n/a); the file-mode twin uses the harness defaults', async () => {
    const repo = makeRepo({ 'src/add.ts': 'export const n = 1;\n' });
    const bad = "export const n: number = 'one';\n";
    const ctx = await contextFor(repo);
    expect(await writeThenCheck(ctx, 'src/bad.ts', bad)).toEqual({ decision: 'pass' });
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'bad.ts')], COLD)?.skipped).toMatch(/no tsconfig\.json/);
    const fileMode = await contextFor(repo, { fileMode: true });
    warmFileMode(repo);
    expect(noteOf(await writeThenCheck(fileMode, 'src/bad.ts', bad))).toMatch(/^tsc: 1 error\(s\): src\/bad\.ts:1:14 TS2322 /);
  });

  it('no TypeScript in the repository: no feedback (its type check cannot run); with it, the same write is checked', async () => {
    const bad = "export const n: number = 'one';\n";
    const without = makeRepo(SOLUTION_FILES, { packages: TINY_ENV, typescript: null });
    expect(await writeThenCheck(await contextFor(without), 'src/bad.ts', bad)).toEqual({ decision: 'pass' });
    expect(checkInPlace(without.root, [path.join(without.root, 'src', 'bad.ts')], COLD)?.skipped).toMatch(/no TypeScript/);
    const withTs = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const ctx = await contextFor(withTs);
    expect(checkInPlace(withTs.root, [path.join(withTs.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    expect(noteOf(await writeThenCheck(ctx, 'src/bad.ts', bad))).toMatch(/^tsc: 1 error\(s\): src\/bad\.ts:1:14 TS2322 /);
  });

  it('a project the read fence cannot read (referenced from outside the checkout): no feedback, nothing read from there', async () => {
    const repo = makeRepo({ ...SOLUTION_FILES, 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: '../elsewhere/tsconfig.app.json' }] }) }, { packages: TINY_ENV });
    mkdirSync(path.join(repo.base, 'elsewhere'), { recursive: true });
    writeFileSync(path.join(repo.base, 'elsewhere', 'tsconfig.app.json'), JSON.stringify({ compilerOptions: BASE_OPTIONS, include: ['../repo/src'] }));
    const ctx = await contextFor(repo);
    expect(await writeThenCheck(ctx, 'src/bad.ts', "export const n: number = 'one';\n")).toEqual({ decision: 'pass' });
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'bad.ts')], COLD)?.skipped).toMatch(/cannot be read/);
  });

  it("an unset option keeps the default of the repository's TypeScript: strict is off before 6.0, on from 6.0", async () => {
    const loose = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022'], noEmit: true, types: [] }, include: ['src'] });
    const implicitAny = 'export function twice(x) {\n  return x * 2;\n}\n';
    const five = makeRepo({ 'tsconfig.json': loose, 'src/a.ts': 'export {};\n' }, { typescript: '5.9.3' });
    const fiveCtx = await contextFor(five);
    expect(checkInPlace(five.root, [path.join(five.root, 'src', 'a.ts')], COLD)?.errors).toEqual([]);
    expect(await writeThenCheck(fiveCtx, 'src/twice.ts', implicitAny)).toEqual({ decision: 'pass' });
    const six = makeRepo({ 'tsconfig.json': loose, 'src/a.ts': 'export {};\n' }, { typescript: '6.0.3' });
    const sixCtx = await contextFor(six);
    expect(checkInPlace(six.root, [path.join(six.root, 'src', 'a.ts')], COLD)?.errors).toEqual([]);
    expect(noteOf(await writeThenCheck(sixCtx, 'src/twice.ts', implicitAny))).toMatch(/src\/twice\.ts:1:23 TS7006 /);
  });
});

describe("typecheck-feedback in place: the defaults of the repository's TypeScript", () => {
  const MODERN = { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022'], noEmit: true, types: [] };
  const project = (options: Record<string, unknown>, include = ['src']): string => JSON.stringify({ compilerOptions: options, include });
  /** What checkInPlace finds for `file` in a repository of `files` on that TypeScript version (cold budget). */
  const found = (version: string, files: Record<string, string>, file: string, packages: Record<string, string> = {}) => {
    const repo = makeRepo(files, { typescript: version, packages });
    return { repo, r: checkInPlace(repo.root, [path.join(repo.root, file)], COLD) };
  };

  it('a 5.x repository\'s ignoreDeprecations "5.0" lets no 6.0 deprecation through; a 6.x repository with it gets them, as its own tsc does', async () => {
    // strict unset: the hook itself sets alwaysStrict false (5.x's default), an option 6.0 deprecates.
    const quiet = found('5.9.3', { 'tsconfig.json': project({ ...MODERN, ignoreDeprecations: '5.0' }), 'src/a.ts': 'export const a: number = 1;\n' }, 'src/a.ts');
    expect(quiet.r).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    // baseUrl: deprecated by 6.0, not by 5.x.
    const withBaseUrl = { 'tsconfig.json': project({ ...MODERN, strict: true, baseUrl: '.', ignoreDeprecations: '5.0' }), 'src/a.ts': 'export const a: number = 1;\n' };
    const five = found('5.9.3', withBaseUrl, 'src/a.ts');
    expect(five.r).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(await writeThenCheck(await contextFor(five.repo), 'src/b.ts', 'export const b: number = 2;\n')).toEqual({ decision: 'pass' });
    // The twin: on TypeScript 6 the same config fails its own type check, so the feedback says so.
    const six = found('6.0.3', withBaseUrl, 'src/a.ts');
    expect(six.r?.project).toEqual([expect.stringMatching(/^tsconfig\.json TS5101 Option 'baseUrl' is deprecated /)]);
    expect(noteOf(await writeThenCheck(await contextFor(six.repo), 'src/b.ts', 'export const b: number = 2;\n'))).toMatch(/^tsc: 1 error\(s\): tsconfig\.json TS5101 Option 'baseUrl' is deprecated /);
  });

  it('types unset: 5.x loads every visible @types package, so a node:test file its project includes is clean; 6.x loads none and records the import', () => {
    const { types: _none, ...noTypes } = MODERN;
    const files = { 'tsconfig.json': project(noTypes, ['src', 'test']), 'src/add.ts': SOLUTION_FILES['src/add.ts'], 'test/add.test.ts': NODE_TEST };
    expect(found('5.9.3', files, 'test/add.test.ts', FAKE_NODE_TYPES).r).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(found('6.0.3', files, 'test/add.test.ts', FAKE_NODE_TYPES).r?.errors[0]).toMatch(/^test\/add\.test\.ts:1:22 TS(2591|2580|2307) /);
  });

  it('noUncheckedSideEffectImports unset: 5.x lets an undeclared stylesheet import pass, 6.x records it', () => {
    const files = { 'tsconfig.json': project({ ...MODERN, strict: true }), 'src/styles.css': 'body { margin: 0; }\n', 'src/main.ts': "import './styles.css';\nexport const ready = true;\n" };
    expect(found('5.9.3', files, 'src/main.ts').r).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(found('6.0.3', files, 'src/main.ts').r?.errors).toEqual(["src/main.ts:1:8 TS2882 Cannot find module or type declarations for side-effect import of './styles.css'."]);
  });

  it('alwaysStrict follows strict in 5.x: a script using a strict-mode reserved word passes with strict unset; strict on, or 6.x, records it', () => {
    // A script (no import or export), so only alwaysStrict decides whether it is strict-mode code.
    const script = { 'src/legacy.ts': 'var static = 1;\nvar total: number = static;\n' };
    const reserved = "src/legacy.ts:1:5 TS1212 Identifier expected. 'static' is a reserved word in strict mode.";
    expect(found('5.9.3', { ...script, 'tsconfig.json': project(MODERN) }, 'src/legacy.ts').r?.errors).toEqual([]);
    expect(found('5.9.3', { ...script, 'tsconfig.json': project({ ...MODERN, strict: true }) }, 'src/legacy.ts').r?.errors[0]).toBe(reserved);
    expect(found('6.0.3', { ...script, 'tsconfig.json': project(MODERN) }, 'src/legacy.ts').r?.errors[0]).toBe(reserved);
  });

  it('libReplacement unset: 5.x takes a lib from an @typescript/lib-* package when one is installed, 6.x ignores it', () => {
    const replaced = {
      '@typescript/lib-dom/package.json': '{ "name": "@typescript/lib-dom", "version": "1.0.0", "types": "index.d.ts" }\n',
      '@typescript/lib-dom/index.d.ts': 'declare const __PINNED_DOM__: string;\n',
    };
    const files = { 'tsconfig.json': project({ ...MODERN, lib: ['ES2022', 'DOM'], strict: true }), 'src/page.ts': 'export const marker: string = __PINNED_DOM__;\n' };
    expect(found('5.9.3', files, 'src/page.ts', replaced).r).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    expect(found('6.0.3', files, 'src/page.ts', replaced).r?.errors).toEqual(["src/page.ts:1:31 TS2304 Cannot find name '__PINNED_DOM__'."]);
  });

  it('target unset: 5.x compiles for ES5 (from a Node module, its matching target), so a private field is an error; 6.x targets the latest', () => {
    const counter = { 'src/counter.ts': 'export class Counter {\n  #n = 0;\n  next(): number {\n    return ++this.#n;\n  }\n}\n' };
    const es5 = 'src/counter.ts:2:3 TS18028 Private identifiers are only available when targeting ECMAScript 2015 and higher.';
    expect(found('5.9.3', { ...counter, 'tsconfig.json': project({ lib: ['ES2022'], noEmit: true, types: [] }) }, 'src/counter.ts').r?.errors).toEqual([es5]);
    expect(found('6.0.3', { ...counter, 'tsconfig.json': project({ lib: ['ES2022'], noEmit: true, types: [] }) }, 'src/counter.ts').r?.errors).toEqual([]);
    expect(found('5.9.3', { ...counter, 'tsconfig.json': project({ module: 'node16', lib: ['ES2022'], noEmit: true, types: [] }) }, 'src/counter.ts').r?.errors).toEqual([]);
  });

  it('module unset: 5.x derives ES2015 from an ES2022 target, which has no import.meta; 6.x derives ES2022', () => {
    const files = { 'tsconfig.json': project({ target: 'ES2022', lib: ['ES2022', 'DOM'], noEmit: true, types: [] }), 'src/where.ts': 'export const here: string = import.meta.url;\n' };
    expect(found('5.9.3', files, 'src/where.ts').r?.errors).toEqual([expect.stringMatching(/^src\/where\.ts:1:29 TS1343 The 'import\.meta' meta-property is only allowed when /)]);
    expect(found('6.0.3', files, 'src/where.ts').r?.errors).toEqual([]);
  });

  it('moduleResolution unset: 5.x resolves an ES2015 module the Classic way (no package.json types), a CommonJS one the Node10 way; 6.x uses Bundler', () => {
    const pkg = { 'tiny-pkg/package.json': '{ "name": "tiny-pkg", "version": "1.0.0", "types": "lib/index.d.ts" }\n', 'tiny-pkg/lib/index.d.ts': 'export declare const size: number;\n' };
    const uses = { 'src/size.ts': "import { size } from 'tiny-pkg';\nexport const doubled: number = size * 2;\n" };
    const esm = { ...uses, 'tsconfig.json': project({ target: 'ES2022', lib: ['ES2022'], noEmit: true, types: [] }) };
    expect(found('5.9.3', esm, 'src/size.ts', pkg).r?.errors).toEqual([expect.stringMatching(/^src\/size\.ts:1:22 TS2792 Cannot find module 'tiny-pkg'\./)]);
    expect(found('6.0.3', esm, 'src/size.ts', pkg).r?.errors).toEqual([]);
    const cjs = { ...uses, 'tsconfig.json': project({ target: 'ES2022', module: 'commonjs', lib: ['ES2022'], noEmit: true, types: [] }) };
    expect(found('5.9.3', cjs, 'src/size.ts', pkg).r?.errors).toEqual([]);
  });

  it('esModuleInterop and allowSyntheticDefaultImports unset: 5.x has neither under CommonJS (synthetic defaults under Bundler); 6.x has both', () => {
    const legacy = "declare module 'legacy' {\n  function run(): number;\n  namespace run {\n    const version: string;\n  }\n  export = run;\n}\n";
    const commonjs = { target: 'ES2020', module: 'commonjs', strict: true, noEmit: true, types: [] };
    const defaultImport = { 'src/legacy.d.ts': legacy, 'src/use.ts': "import run from 'legacy';\nexport const n: number = run();\n" };
    const namespaceCall = { 'src/legacy.d.ts': legacy, 'src/use.ts': "import * as run from 'legacy';\nexport const n: number = run();\n" };
    // A default import of an `export =` module needs allowSyntheticDefaultImports.
    expect(found('5.9.3', { ...defaultImport, 'tsconfig.json': project(commonjs) }, 'src/use.ts').r?.errors).toEqual(["src/use.ts:1:8 TS1259 Module '\"legacy\"' can only be default-imported using the 'esModuleInterop' flag"]);
    expect(found('6.0.3', { ...defaultImport, 'tsconfig.json': project(commonjs) }, 'src/use.ts').r?.errors).toEqual([]);
    expect(found('5.9.3', { ...defaultImport, 'tsconfig.json': project({ ...commonjs, esModuleInterop: true }) }, 'src/use.ts').r?.errors).toEqual([]);
    expect(found('5.9.3', { ...defaultImport, 'tsconfig.json': project({ ...commonjs, module: 'esnext', moduleResolution: 'bundler' }) }, 'src/use.ts').r?.errors).toEqual([]);
    // Calling a namespace import is allowed only without esModuleInterop.
    expect(found('5.9.3', { ...namespaceCall, 'tsconfig.json': project(commonjs) }, 'src/use.ts').r?.errors).toEqual([]);
    expect(found('6.0.3', { ...namespaceCall, 'tsconfig.json': project(commonjs) }, 'src/use.ts').r?.errors).toEqual([expect.stringMatching(/^src\/use\.ts:2:26 TS2349 This expression is not callable\./)]);
  });

  it('5.x has no rootDir check: config/ including ../src with an outDir passes and a real error still shows; 6.x, and a 5.x composite project, record TS6059 as their tsc does', async () => {
    const inSubdirectory = (extra: Record<string, unknown>): Record<string, string> => ({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './config/tsconfig.app.json' }] }),
      'config/tsconfig.app.json': JSON.stringify({ compilerOptions: { ...MODERN, noEmit: undefined, strict: true, outDir: '../dist', ...extra }, include: ['../src'] }),
      'src/a.ts': 'export const a = 1;\n',
    });
    const importsA = "import { a } from './a';\nexport const b: number = a;\n";
    const five = found('5.9.3', inSubdirectory({}), 'src/a.ts');
    expect(five.r).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    const ctx = await contextFor(five.repo);
    expect(await writeThenCheck(ctx, 'src/b.ts', importsA)).toEqual({ decision: 'pass' });
    expect(noteOf(await writeThenCheck(ctx, 'src/b.ts', importsA.replace('b: number', 'b: string')))).toBe("tsc: 1 error(s): src/b.ts:2:14 TS2322 Type 'number' is not assignable to type 'string'.");
    // The twins: TypeScript 6 checks rootDir against the config's directory, and so did 5.x for a composite project.
    for (const [version, extra] of [['6.0.3', {}], ['5.9.3', { composite: true }]] as const) {
      expect(found(version, inSubdirectory(extra), 'src/a.ts').r?.project).toContainEqual(expect.stringMatching(/^config\/tsconfig\.app\.json TS6059 /));
    }
  });
});

describe('typecheck-feedback in place: the existing guarantees', () => {
  it('never blocks and never writes: the file on disk is exactly what the tool wrote', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    const bad = "export const n: number = 'one';\n";
    const v = await writeThenCheck(ctx, 'src/bad.ts', bad);
    expect(v.decision).toBe('record');
    expect(sha((await ctx.workspace.read('src/bad.ts')) ?? '')).toBe(sha(bad));
  });

  it('a check over budget is cancelled and skipped; repeated overruns switch the hook off for the root', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    await callTool(writeFile, { path: 'src/slow.ts', content: "export const n: number = 'one';\n" }, ctx);
    const abs = path.join(repo.root, 'src', 'slow.ts');
    for (let i = 1; i < MAX_OVERRUNS; i += 1) expect(checkInPlace(repo.root, [abs], 0)).toBeNull();
    expect(checkInPlace(repo.root, [abs], 0)).toBeNull();
    expect(await writeThenCheck(ctx, 'src/slow.ts', "export const n: number = 'two';\n")).toEqual({ decision: 'pass' });
  });

  it('past its deadline a warm check is cancelled wherever it stands (a listed file, a file in no project); within it, the same checks complete', () => {
    const repo = makeRepo({ ...SOLUTION_FILES, 'src/late.ts': "export const n: number = 'one';\n" }, { packages: TINY_ENV });
    const listed = path.join(repo.root, 'src', 'late.ts');
    const unlisted = path.join(repo.root, 'test', 'late.test.ts');
    mkdirSync(path.dirname(unlisted), { recursive: true });
    writeFileSync(unlisted, 'export {};\n');
    // Warm: every project's program is built and checked once, so what follows is the warm path a session takes.
    expect(checkInPlace(repo.root, [listed], COLD)?.errors).toEqual(["src/late.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'."]);
    // A deadline already past: the listed file's tiny check would never reach the checker's cancellation points,
    // and the unlisted file's has no type checking at all, so the hook's own deadline checks must cancel them.
    // Each is followed by its twin within the budget, which completes (and resets the overrun count, so two
    // cancellations in a row never switch the root off here).
    expect(checkInPlace(repo.root, [listed], -1)).toBeNull();
    expect(checkInPlace(repo.root, [listed], COLD)?.errors).toEqual(["src/late.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'."]);
    expect(checkInPlace(repo.root, [unlisted], -1)).toBeNull();
    expect(checkInPlace(repo.root, [unlisted], COLD)?.uncovered).toEqual(['test/late.test.ts']);
  });

  it('reads only inside the fence: a file outside the checkout, imported by absolute path, never reaches the note', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const outside = mkdtempSync(path.join(tmpdir(), 'tsfeedback-outside-'));
    cleanups.push(async () => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(path.join(outside, 'secret.ts'), 'export interface Leaked { CANARY_INPLACE_FEEDBACK_51c3: number }\n');
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    const v = await writeThenCheck(ctx, 'src/probe.ts', `import type { Leaked } from '${path.join(outside, 'secret.ts')}';\nexport const n: Leaked = {};\n`);
    expect(noteOf(v)).not.toContain('CANARY_INPLACE_FEEDBACK_51c3');
    expect(noteOf(v)).toMatch(/src\/probe\.ts:1:29 TS2307 /);
  });
});
