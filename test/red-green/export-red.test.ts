/**
 * The export-red deadlock, with the harness's REAL runner (node:test through tsx, sandboxed) on a small
 * React + Vite TypeScript app in the OS temp dir (outside the harness checkout).
 *
 * A test imports a module-private function: it cannot load ("does not provide an export named"), a load
 * failure is no red for a file that existed at run start, and only adding `export` lets the test load. The
 * observed-red hook lets exactly that write through while the file is locked (an export-only edit), unlocks
 * nothing with it, and the revert check compares against the run-start content WITH that export, so the
 * proof still needs the case to fail there on an assertion. Every allowance is paired with its refusal:
 * export plus any other change, a new exported declaration, a re-export, a removed export, a JSX pragma
 * comment, a second file in the same call that is not export-only, a behaviour edit after the export without a
 * red. A file that only gained exports is never green, even next to a proven fix (a new export can change what
 * code reading the module as a whole does: here a registry built from `import * as`); putting it back to its
 * run-start content is allowed while it is locked. The same flow runs in file mode (the twin of in place). The
 * revert rule itself (a load-only failure is no flip) is pinned in revert-base.test.ts.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import { EXPORT_ONLY_KEY, exportOnlyRecords, exportOnlySinceStart, lockState, unlockedSources } from '../../plugins/lib/red.ts';
import editFileTool from '../../plugins/tools/edit_file.ts';
import runTestsTool from '../../plugins/tools/run_tests.ts';
import writeFileTool from '../../plugins/tools/write_file.ts';
import { exec } from '../../src/core/exec.ts';
import { saveInitial } from '../../src/core/initial.ts';
import type { GateResult, HookVerdict, RunContext, ToolCallInfo } from '../../src/core/plugin-api.ts';
import { createServices } from '../../src/core/services.ts';
import { computeTargetProfile, setActiveLayout } from '../../src/core/target.ts';
import { brownfieldTask, callInfo, callTool, emptyRegistry, HARNESS_ROOT, makeHarness, removeTmp, sha } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  setActiveLayout(undefined);
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const API_FILE = 'src/store/x/api.ts';
const API = [
  'export interface Page {',
  '  items: string[];',
  '  next: string | null;',
  '}',
  '',
  'const FIRST: Page = { items: [], next: null };',
  '',
  'function appendPage(prev: Page, page: Page): Page {',
  '  return { items: [...page.items], next: page.next };',
  '}',
  '',
  'export async function loadMore(prev: Page, fetchPage: (cursor: string) => Promise<Page>): Promise<Page> {',
  '  if (prev.next === null) return prev;',
  '  return appendPage(prev, await fetchPage(prev.next));',
  '}',
  '',
  'export function reset(): Page {',
  '  return FIRST;',
  '}',
  '',
].join('\n');
const BUG = 'return { items: [...page.items], next: page.next };';
const FIX = 'return { items: [...prev.items, ...page.items], next: page.next };';

/** A React + Vite TypeScript app with no test runner declared: node:test through tsx. */
const APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'pager-web', private: true, type: 'module', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^7.0.0', typescript: '^5.0.0' } }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }, null, 2),
  'index.html': '<div id="app"></div><script type="module" src="/src/main.ts"></script>\n',
  'src/main.ts': "import { reset } from './store/x/api';\n\ndocument.querySelector('#app')?.append(String(reset().items.length));\n",
  [API_FILE]: API,
};

const TEST_FILE = 'test/merge.test.ts';
const MERGE_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendPage } from '../src/store/x/api';",
  '',
  "test('appending a page keeps the items already loaded', () => {",
  "  assert.deepEqual(appendPage({ items: ['a'], next: 'c2' }, { items: ['b'], next: null }).items, ['a', 'b']);",
  '});',
  '',
].join('\n');

const OUTSIDE = realpathSync(tmpdir());

/** A run over APP (its run-start snapshot kept), in place (a session) unless `fileMode`, with the real runner and services. */
async function harness(opts: { fileMode?: boolean; extra?: Record<string, string> } = {}) {
  const files = { ...APP, ...opts.extra };
  const h = await makeHarness({ label: 'export-red', task: brownfieldTask(), files, exec, under: OUTSIDE });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(files)) h.ctx.state.initialHashes.set(rel, sha(content));
  await saveInitial(h.ctx.run.runDir, new Map(Object.entries(files)));
  const profile = await computeTargetProfile({ apiRoot: h.ws.root, repoRoot: h.dir, harnessRoot: HARNESS_ROOT, ...(opts.fileMode === true ? {} : { inPlace: true }) });
  expect(profile.runner).toMatchObject({ kind: 'node-test', supported: true });
  const services = createServices({ ws: h.ws, registry: emptyRegistry(), state: h.ctx.state, logs: h.ctx.logs, exec, harnessRoot: HARNESS_ROOT, runDir: h.ctx.run.runDir, profile });
  const ctx: RunContext = {
    ...h.ctx,
    services,
    runner: profile.runner,
    ...(opts.fileMode === true ? {} : { inPlace: { repoTop: h.dir, branch: 'fix/pages' } }),
  };
  /** A call through the observed-red hook, as the loop does it: blocked, or written. */
  const through = async (call: ToolCallInfo): Promise<HookVerdict> => {
    const verdict = await observedRedHook.run({ event: 'pre_tool', call }, ctx);
    if (verdict.decision !== 'block') {
      for (const p of call.paths) {
        const next = call.preview?.get(p);
        if (typeof next === 'string') await h.ws.write(p, next);
      }
    }
    return verdict;
  };
  const write = (path: string, content: string) => through(callInfo(writeFileTool, { path, content }));
  const edit = (path: string, find: string, replace: string) => through(callInfo(editFileTool, { path, find, replace }, h.ws));
  const runTests = (files: string[]) => callTool(runTestsTool, { files }, ctx);
  const gate = (): Promise<GateResult> => observedRedGate.run(ctx, 'finish');
  const latest = (file: string) => ctx.state.tests.filter((o) => o.file === file).at(-1);
  return { ...h, ctx, services, through, write, edit, runTests, gate, latest };
}

const reason = (v: HookVerdict): string => (v.decision === 'block' ? v.reason : '');
const note = (v: HookVerdict): string => (v.decision === 'record' ? v.note : '');
const exportedApi = API.replace('function appendPage', 'export function appendPage');

/** Up to the deadlock: the agent's test is written and ran, and fails to load on the missing export. */
async function deadlocked(opts: { fileMode?: boolean } = {}) {
  const h = await harness(opts);
  expect((await h.write(TEST_FILE, MERGE_TEST)).decision).toBe('pass');
  const res = await h.runTests([TEST_FILE]);
  return { h, res };
}

describe('the deadlock and its way out, in place (a session)', () => {
  it('the test fails to load; run_tests shows the load error and the lock names the export way out', async () => {
    const { h, res } = await deadlocked();
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'error', validRed: false, missingExport: { module: '../src/store/x/api', name: 'appendPage' } });
    expect(res.summary).toMatch(/ERROR test\/merge\.test\.ts: suite error: SyntaxError: The requested module '\.\.\/src\/store\/x\/api' does not provide an export named 'appendPage'/);
    expect(res.summary).toContain("test/merge.test.ts failed to load: the module '../src/store/x/api' it imports does not export appendPage. If that module declares appendPage, add `export` to that declaration (an export-only edit is allowed even while the file is locked)");
    // The fix itself (export AND the new body in one write) is refused: locked, and not export-only.
    const v = await h.write(API_FILE, exportedApi.replace(BUG, FIX));
    expect(v.decision).toBe('block');
    expect(reason(v)).toContain(`test/merge.test.ts failed to load: it imports appendPage from ${API_FILE}, which declares appendPage but does not export it, and a load failure is not a red for a file that existed at run start.`);
    expect(reason(v)).toContain(`Next: add \`export\` to the existing declaration of appendPage in ${API_FILE}. An export-only edit`);
    expect(reason(v)).toContain('Then run_tests { "files": ["test/merge.test.ts"] } to observe the case fail on an assertion');
    expect(reason(v)).toMatch(/This write is not export-only: line 8 \(`export function appendPage\(prev: Page, page: Page\): Page \{`\) changes more than adding `export`/);
    expect(await h.ws.read(API_FILE)).toBe(API);
  }, 120_000);

  it('export-only edit allowed while locked, recorded, unlocking nothing -> red on an assertion -> fix -> green -> the gate proves the flip against the export-only base', async () => {
    const { h } = await deadlocked();
    const exp = await h.edit(API_FILE, 'function appendPage', 'export function appendPage');
    expect(exp.decision).toBe('record');
    expect(note(exp)).toContain(`observed-red: export-only edit of ${API_FILE} allowed while it is locked (exports appendPage; nothing else changed). It unlocks nothing`);
    expect(await h.ws.read(API_FILE)).toBe(exportedApi);
    expect(exportOnlyRecords(h.ctx.state)).toEqual([{ file: API_FILE, from: sha(API), to: sha(exportedApi), names: ['appendPage'] }]);
    expect(unlockedSources(h.ctx.state).has(API_FILE)).toBe(false);
    // Still locked: the behaviour edit right after the export, without a red, is refused.
    const early = await h.edit(API_FILE, BUG, FIX);
    expect(early.decision).toBe('block');
    expect(reason(early)).toMatch(/^observed-red: src\/store\/x\/api\.ts is locked/);
    // The test now loads and fails on its assertion: a red at its current content.
    const red = await h.runTests([TEST_FILE]);
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'fail', validRed: true });
    expect(red.summary).toContain('observed red: test/merge.test.ts');
    expect((await h.edit(API_FILE, BUG, FIX)).decision).toBe('pass');
    expect(unlockedSources(h.ctx.state).has(API_FILE)).toBe(true);
    const green = await h.runTests([TEST_FILE]);
    expect(green.ok).toBe(true);
    const g = await h.gate();
    expect(g, JSON.stringify(g)).toMatchObject({ status: 'pass' });
    expect(g.summary).toContain('1 changed source files went red -> green');
    expect(g.summary).toContain(`the reverted copies kept the exports the run added (${API_FILE}: appendPage)`);
  }, 180_000);

  it('the revert check: with the export-only base the reverted copy runs and FAILS ON AN ASSERTION (counts); the current copy passes', async () => {
    const { h } = await deadlocked();
    await h.edit(API_FILE, 'function appendPage', 'export function appendPage');
    await h.runTests([TEST_FILE]);
    await h.edit(API_FILE, BUG, FIX);
    const diff = await h.services.runTestsReverted([TEST_FILE], [API_FILE]);
    expect(diff.exportsKept).toEqual({ [API_FILE]: ['appendPage'] });
    const rev = diff.reverted.observations.find((o) => o.file === TEST_FILE);
    const cur = diff.current.observations.find((o) => o.file === TEST_FILE);
    expect(cur?.cases?.map((c) => c.status)).toEqual(['pass']);
    // Not a load error: the case ran against the run-start behaviour and its assertion failed.
    expect(rev).toMatchObject({ status: 'fail' });
    expect(rev?.cases?.map((c) => c.status)).toEqual(['fail']);
  }, 180_000);
});

describe('twins that stay locked: export plus anything else', () => {
  const refusals: Array<[string, string, RegExp]> = [
    ['export plus a changed body', exportedApi.replace(BUG, FIX), /line 8 .*changes more than adding `export`/],
    ['export plus a changed constant', exportedApi.replace('const FIRST: Page = { items: [], next: null };', 'export const FIRST: Page = { items: [], next: \'x\' };'), /line 6 .*changes more than adding `export`/],
    ['a new exported declaration', `${API}export function prependPage(prev: Page, page: Page): Page {\n  return appendPage(page, prev);\n}\n`, /adds a new declaration/],
    ['export * from', `${API}export * from '../../main';\n`, /re-exports from another module/],
    ['removing an export, next to the added one', exportedApi.replace('export function reset', 'function reset'), /changes more than adding `export`/],
  ];
  for (const [name, content, why] of refusals) {
    it(`refused: ${name} (the lock reason says why it is not export-only); nothing is recorded`, async () => {
      const { h } = await deadlocked();
      const v = await h.write(API_FILE, content);
      expect(v.decision).toBe('block');
      expect(reason(v)).toMatch(/^observed-red: src\/store\/x\/api\.ts is locked/);
      expect(reason(v)).toMatch(new RegExp(`This write is not export-only: [^\\n]*${why.source}`));
      expect(await h.ws.read(API_FILE)).toBe(API);
      expect(h.ctx.state.scratch.has(EXPORT_ONLY_KEY)).toBe(false);
    }, 120_000);
  }

  it('a call that writes two locked files passes only when both are export-only (the twin: one is not, nothing is written or recorded)', async () => {
    const other = 'src/store/x/format.ts';
    const FORMAT = "export const sep = ', ';\nfunction join(items: string[]): string {\n  return items.join(sep);\n}\n";
    const h = await harness({ extra: { [other]: FORMAT, 'test/format.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sep } from '../src/store/x/format';\ntest('sep', () => assert.equal(sep, ', '));\n" } });
    const call = (contents: Record<string, string>): ToolCallInfo => ({ id: 'm1', tool: 'multi_write', effect: 'write', input: {}, paths: Object.keys(contents), preview: new Map(Object.entries(contents)) });
    const mixed = await h.through(call({ [API_FILE]: exportedApi, [other]: FORMAT.replace('function join', 'export function join').replace("join(sep)", "join(' ')") }));
    expect(mixed.decision).toBe('block');
    expect(reason(mixed)).toMatch(/^observed-red: src\/store\/x\/format\.ts is locked[\s\S]*This write is not export-only/);
    expect(h.ctx.state.scratch.has(EXPORT_ONLY_KEY)).toBe(false);
    expect(await h.ws.read(API_FILE)).toBe(API);
    const both = await h.through(call({ [API_FILE]: exportedApi, [other]: FORMAT.replace('function join', 'export function join') }));
    expect(both.decision).toBe('record');
    expect(exportOnlyRecords(h.ctx.state).map((r) => r.file).sort()).toEqual([other, API_FILE].sort());
  }, 120_000);

  it('a test importing a name the file does not declare: the lock says an export-only edit cannot add it (no guess)', async () => {
    const h = await harness();
    await h.write(TEST_FILE, MERGE_TEST.replace(/appendPage/g, 'prependPage'));
    await h.runTests([TEST_FILE]);
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'error', missingExport: { name: 'prependPage' } });
    const v = await h.write(API_FILE, exportedApi.replace(BUG, FIX));
    expect(v.decision).toBe('block');
    expect(reason(v)).toContain(`it imports prependPage from ${API_FILE}, which has no top-level declaration of prependPage to export (an export-only edit can only export what already exists)`);
    expect(reason(v)).not.toContain('Next: add `export`');
    // An export-only edit is still allowed whatever the test imports: it changes none of the file's own code.
    expect((await h.write(API_FILE, exportedApi)).decision).toBe('record');
  }, 120_000);

  it('a JSX pragma comment next to the export is refused on a locked component (it redirects every JSX element); the plain export is the twin that passes', async () => {
    const row = 'src/ui/Row.tsx';
    const ROW = "import { reset } from '../store/x/api';\n\nfunction h(..._a: unknown[]): string {\n  return 'HIJACKED';\n}\n\nfunction Row() {\n  return <li>{reset().items.length}</li>;\n}\n\nexport const used = [h, Row].length;\n";
    const h = await harness({ extra: { [row]: ROW } });
    expect((await lockState(h.ctx, row)).unlocked).toBe(false);
    const pragma = await h.write(row, `/** @jsxRuntime classic */\n/** @jsx h */\n${ROW.replace('function Row', 'export function Row')}`);
    expect(pragma.decision).toBe('block');
    expect(reason(pragma)).toMatch(/This write is not export-only: line 3 [^\n]*adds the comment `\/\*\* @jsxRuntime classic \*\/`: builds obey some comments/);
    expect(await h.ws.read(row)).toBe(ROW);
    expect((await h.write(row, ROW.replace('function Row', 'export function Row'))).decision).toBe('record');
  }, 120_000);
});

describe('a file that only gained exports is never green', () => {
  /** A file read as a whole: src/main.ts builds its commands from the module namespace (Object.keys). */
  const COMMANDS_FILE = 'src/store/x/commands.ts';
  const COMMANDS = "export function save(): string {\n  return 'saved';\n}\n\nfunction wipeAll(): string {\n  return 'wiped';\n}\n\nexport const size = wipeAll.length;\n";
  const REGISTRY = { [COMMANDS_FILE]: COMMANDS, 'src/main.ts': "import * as commands from './store/x/commands';\n\nfor (const name of Object.keys(commands)) document.querySelector('#app')?.append(name);\n" };

  it('export-only edits alone (a red seen, no fix): UNPROVEN "no source change to prove", naming the file and what it exports', async () => {
    const { h } = await deadlocked();
    expect((await h.edit(API_FILE, 'function appendPage', 'export function appendPage')).decision).toBe('record');
    await h.runTests([TEST_FILE]);
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'fail', validRed: true });
    expect(exportOnlySinceStart(h.ctx.state, API_FILE, sha(exportedApi))).toEqual(['appendPage']);
    const g = await h.gate();
    expect(g).toMatchObject({ status: 'unproven', summary: 'no source change to prove: the only source changes are exports of declarations the files already had' });
    expect(g.details?.join('\n')).toContain(`unproven: ${API_FILE}: only gained exports since run start (appendPage): none of its own code changed, but a new export can change what code that reads the module as a whole does`);
    expect(g.humanMustVerify).toEqual([`${API_FILE}: verify by hand that exporting appendPage changes nothing for code that reads the module as a whole, or put ${API_FILE} back to its run-start content (allowed while it is locked)`]);
  }, 120_000);

  it('next to a proven fix, a locked file that only gained an export read through a namespace (a new command in the registry) makes the gate UNPROVEN, by name', async () => {
    const h = await harness({ extra: REGISTRY });
    // The legit flow on api.ts: export-only, red on an assertion, fix, green.
    await h.write(TEST_FILE, MERGE_TEST);
    await h.runTests([TEST_FILE]);
    expect((await h.edit(API_FILE, 'function appendPage', 'export function appendPage')).decision).toBe('record');
    await h.runTests([TEST_FILE]);
    expect((await h.edit(API_FILE, BUG, FIX)).decision).toBe('pass');
    expect((await h.runTests([TEST_FILE])).ok).toBe(true);
    // commands.ts is locked (no covering test); exporting wipeAll adds a command to src/main.ts's registry.
    expect((await lockState(h.ctx, COMMANDS_FILE)).unlocked).toBe(false);
    expect((await h.edit(COMMANDS_FILE, 'function wipeAll', 'export function wipeAll')).decision).toBe('record');
    const g = await h.gate();
    expect(g.status, JSON.stringify(g)).toBe('unproven');
    expect(g.summary).toContain('1 changed source files went red -> green');
    expect(g.summary).toContain(`; but ${COMMANDS_FILE} only gained exports, which no test proves; verify by hand or put it back to the run-start content`);
    expect(g.details?.join('\n')).toContain(`${COMMANDS_FILE}: only gained exports since run start (wipeAll)`);
    // The way out: put it back to its run-start content (allowed while it is locked); the gate is then green.
    const back = await h.write(COMMANDS_FILE, COMMANDS);
    expect(back.decision).toBe('record');
    expect(note(back)).toBe(`observed-red: ${COMMANDS_FILE} is back at its run-start content (it had only gained exports since run start), allowed while it is locked; it has no change left to prove.`);
    expect(await h.gate()).toMatchObject({ status: 'pass' });
  }, 240_000);

  it('twins of the way back, refused while locked: the run-start content plus one more change, and the run-start content over a change that was not export-only', async () => {
    const h = await harness({ extra: REGISTRY });
    expect((await h.edit(COMMANDS_FILE, 'function wipeAll', 'export function wipeAll')).decision).toBe('record');
    const almost = await h.write(COMMANDS_FILE, COMMANDS.replace("return 'wiped'", "return 'gone'"));
    expect(almost.decision).toBe('block');
    expect(reason(almost)).toMatch(/^observed-red: src\/store\/x\/commands\.ts is locked/);
    // Changed behind the hook (no record): its run-start content is not an undo of export-only edits.
    await h.ws.write(COMMANDS_FILE, COMMANDS.replace("return 'saved'", "return 'kept'"));
    expect((await h.write(COMMANDS_FILE, COMMANDS)).decision).toBe('block');
  }, 120_000);

  it('twin: the same content written behind the hook (no record) is a change that did not pass the hook (fail)', async () => {
    const { h } = await deadlocked();
    await h.ws.write(API_FILE, exportedApi);
    await h.runTests([TEST_FILE]);
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'fail', validRed: true });
    expect(exportOnlySinceStart(h.ctx.state, API_FILE, sha(exportedApi))).toBeNull();
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.join('\n')).toContain(`${API_FILE}: changed without passing the observed-red hook`);
  }, 120_000);
});

describe('how a test reaches a function the module does not have yet (documented in plugins/lib/red.ts)', () => {
  it('a namespace import: the case fails on a TypeError, a red; the new function is written and proven like any behaviour (the named-import twin fails to load: see above)', async () => {
    const h = await harness();
    const ns = [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import * as api from '../src/store/x/api';",
      '',
      "test('prepending a page puts its items first', () => {",
      "  assert.deepEqual((api as unknown as { prependPage: (a: unknown, b: unknown) => { items: string[] } }).prependPage({ items: ['a'], next: null }, { items: ['b'], next: null }).items, ['b', 'a']);",
      '});',
      '',
    ].join('\n');
    await h.write(TEST_FILE, ns);
    await h.runTests([TEST_FILE]);
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'fail', validRed: true });
    expect(h.latest(TEST_FILE)?.missingExport).toBeUndefined();
    const added = `${API}export function prependPage(prev: Page, page: Page): Page {\n  return { items: [...page.items, ...prev.items], next: prev.next };\n}\n`;
    expect((await h.write(API_FILE, added)).decision).toBe('pass');
    expect((await h.runTests([TEST_FILE])).ok).toBe(true);
    expect(await h.gate()).toMatchObject({ status: 'pass' });
  }, 180_000);
});

describe('file mode (the twin of in place): the same deadlock, the same way out', () => {
  it('export-only edit while locked -> red on an assertion -> fix -> green -> the gate passes with the export-only base', async () => {
    const { h, res } = await deadlocked({ fileMode: true });
    expect(h.ctx.inPlace).toBeUndefined();
    expect(res.summary).toContain("does not provide an export named 'appendPage'");
    expect((await h.write(API_FILE, exportedApi.replace(BUG, FIX))).decision).toBe('block');
    expect((await h.edit(API_FILE, 'function appendPage', 'export function appendPage')).decision).toBe('record');
    expect((await h.edit(API_FILE, BUG, FIX)).decision).toBe('block');
    await h.runTests([TEST_FILE]);
    expect(h.latest(TEST_FILE)).toMatchObject({ status: 'fail', validRed: true });
    expect((await h.edit(API_FILE, BUG, FIX)).decision).toBe('pass');
    expect((await h.runTests([TEST_FILE])).ok).toBe(true);
    const g = await h.gate();
    expect(g, JSON.stringify(g)).toMatchObject({ status: 'pass' });
    expect(g.summary).toContain(`the reverted copies kept the exports the run added (${API_FILE}: appendPage)`);
  }, 180_000);
});

describe('an unprovable-tier file keeps today\'s behaviour', () => {
  it('in place without a supported runner the edit passes with the UNPROVEN note, and is not recorded as export-only', async () => {
    const h = await harness();
    const ctx: RunContext = { ...h.ctx, runner: { kind: 'vitest', name: 'karma', supported: false, reason: 'unsupported test runner karma' } };
    const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: API_FILE, content: exportedApi }) }, ctx);
    expect(v.decision).toBe('record');
    expect(note(v)).toBe(`observed-red: no test can prove ${API_FILE} (logic, but unsupported test runner karma). The edit is allowed, but the verdict will be UNPROVEN for it and a human must verify it by hand.`);
    expect(h.ctx.state.scratch.has(EXPORT_ONLY_KEY)).toBe(false);
  });
});
