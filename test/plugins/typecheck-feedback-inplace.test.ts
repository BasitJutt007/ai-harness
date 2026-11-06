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
import typecheckFeedback, { checkInPlace, MAX_OVERRUNS } from '../../plugins/hooks/typecheck-feedback.ts';
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

  it("the project's other files are part of its program: an ambient module declaration in src/ applies (the root-config twin reports TS2307)", async () => {
    const repo = makeRepo({ ...SOLUTION_FILES, 'src/assets.d.ts': "declare module '*.svg' {\n  const url: string;\n  export default url;\n}\n" }, { packages: TINY_ENV });
    const usesLogo = "import logo from './logo.svg';\nexport const src: string = logo;\n";
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'add.ts')], COLD)?.errors).toEqual([]);
    expect(await writeThenCheck(ctx, 'src/logo-src.ts', usesLogo)).toEqual({ decision: 'pass' });
    const fileMode = await contextFor(repo, { fileMode: true });
    expect(noteOf(await writeThenCheck(fileMode, 'src/logo-src.ts', usesLogo))).toMatch(/src\/logo-src\.ts:1:18 TS2307 /);
  });

  it('a file outside every include that a project file imports is in that program: its error is recorded; an unimported one is not', async () => {
    const repo = makeRepo({ ...SOLUTION_FILES, 'src/main.ts': "import { label } from '../shared/label';\nexport const shown: string = label;\n", 'shared/label.ts': "export const label: string = 'ok';\n" }, { packages: TINY_ENV });
    const ctx = await contextFor(repo);
    expect(checkInPlace(repo.root, [path.join(repo.root, 'src', 'main.ts')], COLD)?.errors).toEqual([]);
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

  it('reads only inside the fence: a file outside the checkout, imported by absolute path, never reaches the note', async () => {
    const repo = makeRepo(SOLUTION_FILES, { packages: TINY_ENV });
    const outside = mkdtempSync(path.join(tmpdir(), 'tsfeedback-outside-'));
    cleanups.push(async () => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(path.join(outside, 'secret.ts'), 'export interface Leaked { CANARY_INPLACE_FEEDBACK_51c3: number }\n');
    const ctx = await contextFor(repo);
    const v = await writeThenCheck(ctx, 'src/probe.ts', `import type { Leaked } from '${path.join(outside, 'secret.ts')}';\nexport const n: Leaked = {};\n`);
    expect(noteOf(v)).not.toContain('CANARY_INPLACE_FEEDBACK_51c3');
    expect(noteOf(v)).toMatch(/src\/probe\.ts:1:29 TS2307 /);
  });
});
