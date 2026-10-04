/**
 * Order dependence, with the harness's REAL runner (vitest, sandboxed): an appended exact-count case
 * fails only because earlier cases of its file left records in a module-level store. run_tests re-runs
 * up to two failing cases alone (the runner's name filter, same sandbox, env and fd-3 channel) and names
 * the ones that pass alone. Those re-runs are diagnostic only: never an observation, never red or green.
 * The jest wiring and the "exactly that one case ran" check are covered with recorded reports.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/core/exec.ts';
import { createServices } from '../../src/core/services.ts';
import type { TestRunnerInfo } from '../../src/core/target.ts';
import { caseNameFilter, MAX_ISOLATED_CASES, orderDependenceNote, REPORT_CHANNEL, runTargetTests } from '../../src/core/testing.ts';
import type { Exec, ExecOptions, LogStore } from '../../src/core/types.ts';
import runTestsTool from '../../plugins/tools/run_tests.ts';
import { brownfieldTask, callTool, emptyRegistry, HARNESS_ROOT, makeHarness, makeTmp, removeTmp } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

/** A tiny API whose store lives at module level: every case of a test file shares it. */
const STORE = [
  'export interface Item {',
  '  id: number;',
  '  name: string;',
  '}',
  'const items: Item[] = [];',
  'export function addItem(name: string): Item {',
  '  const item = { id: items.length + 1, name };',
  '  items.push(item);',
  '  return item;',
  '}',
  'export function listItems(): Item[] {',
  '  return [...items];',
  '}',
  '',
].join('\n');
const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'order-api', type: 'module', private: true }),
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
  'src/store.ts': STORE,
};

const FILE = 'test/items.test.ts';
const HEAD = "import { describe, expect, it } from 'vitest';\nimport { addItem, listItems } from '../src/store.ts';\n";
const testCase = (title: string, body: string): string => `  it(${JSON.stringify(title)}, () => {\n    ${body}\n  });\n`;
const block = (title: string, cases: string[]): string => `describe(${JSON.stringify(title)}, () => {\n${cases.join('')}});\n`;
/** The cases the file had: each creates a record and never removes it. */
const EXISTING = block('items', [
  testCase('adds an item', "expect(addItem('a').name).toBe('a');"),
  testCase('adds another', "expect(addItem('b').name).toBe('b');"),
]);
/** Titles full of regex metacharacters: the name filter must select this case and nothing else. */
const SUITE = 'listing (all) items?';
const LEAKY = 'lists only its own record (count === 1)? costs $1/2 [a.b*] +^{x}|\\ end';
/** Exact count on the shared store: 1 alone, more after the cases above. */
const leaky = (title: string): string => testCase(title, "addItem('c');\n    expect(listItems()).toHaveLength(1);");
/** Fails alone too: addItem never rejects an empty name. */
const GENUINE = testCase('rejects an empty name', "expect(() => addItem('')).toThrow();");
/** Passing cases a loose filter would also select: a longer title, the same title in another suite. */
const DECOYS = [
  block(SUITE, [testCase(`${LEAKY} (again)`, "expect(addItem('d').name).toBe('d');")]),
  block('other', [testCase(LEAKY, 'expect(listItems().length).toBeGreaterThan(0);')]),
];

const JEST: TestRunnerInfo = { kind: 'jest', name: 'jest 29.7.0', supported: true, bin: '/opt/jest/bin/jest.js', version: '29.7.0', origin: 'target', evidence: 'test' };
const NODE_TEST: TestRunnerInfo = { kind: 'node-test', name: 'node:test', supported: true, evidence: 'test' };

interface RunnerCall {
  args: string[];
  opts: ExecOptions;
}

/** A brownfield harness over BASE + `files` with the real, sandboxed runner; every runner start is recorded. */
async function harness(files: Record<string, string>) {
  const calls: RunnerCall[] = [];
  const spy: Exec = (cmd, args, opts) => {
    calls.push({ args, opts });
    return exec(cmd, args, opts);
  };
  const logNames: string[] = [];
  const h = await makeHarness({ label: 'order-dependence', task: brownfieldTask(), files: { ...BASE, ...files }, exec });
  dirs.push(h.dir);
  const logs: LogStore = { write: async (name) => { logNames.push(name); return `runs/run-1/logs/${name}.txt`; } };
  h.ctx.services = createServices({ ws: h.ws, registry: emptyRegistry(), state: h.ctx.state, logs, exec: spy, harnessRoot: HARNESS_ROOT });
  const runTests = async (only?: string[]) => callTool(runTestsTool, only === undefined ? {} : { files: only }, h.ctx);
  return { ...h, calls, logNames, runTests };
}

const NOTE = 'passes when run alone';
const count = (text: string, part: string): number => text.split(part).length - 1;

describe('run_tests: a failing case that passes alone is named as order-dependent (real runner)', () => {
  it('the appended exact-count case gets the note; the genuine failure does not; the re-runs are not observations', async () => {
    const h = await harness({ [FILE]: HEAD + EXISTING + block(SUITE, [GENUINE, leaky(LEAKY)]) + DECOYS.join('') });
    const res = await h.runTests([FILE]);

    expect(res.ok).toBe(false);
    expect(res.summary).toContain('tests: 2 failed, 4 passed (6) in 1 files');
    // a, b and the empty name the genuine case added before it: 4 records, where the case alone sees 1
    expect(res.summary).toMatch(/FAIL test\/items\.test\.ts > listing \(all\) items\? > lists only .* end: expected .* to have a length of 1 but got 4/);
    expect(res.summary).toContain(orderDependenceNote(FILE, [SUITE, LEAKY]));
    expect(orderDependenceNote(FILE, [SUITE, LEAKY])).toBe(`${FILE} > ${SUITE} > ${LEAKY}: passes when run alone, fails after the other tests in this file: `
      + 'it depends on test order (shared state, e.g. a module-level store, is not reset between tests). '
      + 'Do not assume an empty store; assert only on the records this test created.');
    // the genuine failure was re-run alone too (2 failing cases, cap 2) and failed again: no note for it
    expect(count(res.summary, NOTE)).toBe(1);
    expect(res.raw).toContain(orderDependenceNote(FILE, [SUITE, LEAKY]));

    // exactly one observation for this run: the full file, as it ran with the other cases
    expect(h.ctx.state.tests).toHaveLength(1);
    expect(h.ctx.state.tests[0]).toMatchObject({ file: FILE, status: 'fail', collected: 6, failed: 2 });

    // the full run, then each failing case alone: the same command, sandbox, env and fd-3 channel, plus a name filter
    expect(h.calls).toHaveLength(1 + MAX_ISOLATED_CASES);
    expect(h.logNames).toEqual(['vitest', 'vitest-alone', 'vitest-alone']);
    const [full, ...alone] = h.calls;
    if (full === undefined) throw new Error('no runner call');
    expect(full.args.some((a) => a.startsWith('--testNamePattern'))).toBe(false);
    for (const c of alone) {
      expect(c.args.filter((a) => !a.startsWith('--testNamePattern='))).toEqual(full.args);
      expect(c.args.filter((a) => a.startsWith('--testNamePattern='))).toHaveLength(1);
      expect(c.args).toContain(`--outputFile.json=${REPORT_CHANNEL}`);
      expect(c.args.at(-1)).toBe(FILE);
      expect(c.opts.channel).toBe(true);
      const tmp = c.opts.sandbox?.writable[0] ?? '';
      expect(c.opts.sandbox).toEqual({ writable: [tmp], network: 'localhost' });
      expect(c.opts.env).toMatchObject({ TMPDIR: tmp, TMP: tmp, TEMP: tmp });
      expect(c.opts.env?.['HOME']?.startsWith(tmp)).toBe(true);
      expect(Object.keys(c.opts.env ?? {}).sort()).toEqual(Object.keys(full.opts.env ?? {}).sort());
      expect(c.opts.cwd).toBe(full.opts.cwd);
      expect(tmp).not.toBe(full.opts.sandbox?.writable[0]);
    }
  });

  it('re-runs at most two failing cases', async () => {
    const titles = ['counts one (a)', 'counts one (b)', 'counts one (c)'];
    const h = await harness({ [FILE]: HEAD + EXISTING + block(SUITE, titles.map(leaky)) });
    const res = await h.runTests([FILE]);
    expect(res.summary).toContain('tests: 3 failed, 2 passed (5) in 1 files');
    expect(h.calls).toHaveLength(1 + MAX_ISOLATED_CASES);
    expect(count(res.summary, NOTE)).toBe(MAX_ISOLATED_CASES);
    expect(res.summary).toContain(orderDependenceNote(FILE, [SUITE, 'counts one (a)']));
    expect(res.summary).toContain(orderDependenceNote(FILE, [SUITE, 'counts one (b)']));
    expect(h.ctx.state.tests).toHaveLength(1);
  });

  it('runs nothing extra when nothing fails, for a file that failed to load, or when the caller does not ask (gates)', async () => {
    const h = await harness({
      'test/green.test.ts': HEAD + EXISTING,
      'test/broken.test.ts': `${HEAD}it('x', () => {\n  const = ;\n});\n`,
      [FILE]: HEAD + EXISTING + block(SUITE, [leaky(LEAKY)]),
    });
    const green = await h.runTests(['test/green.test.ts']);
    expect(green.ok).toBe(true);
    expect(h.calls).toHaveLength(1);

    // a load error has no case to isolate: only the failing case of the other file is re-run
    h.calls.length = 0;
    const mixed = await h.runTests(['test/broken.test.ts', FILE]);
    expect(mixed.summary).toContain('ERROR test/broken.test.ts');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.args.at(-1)).toBe(FILE);
    expect(mixed.summary).toContain(orderDependenceNote(FILE, [SUITE, LEAKY]));

    // a gate's run (no isolateFailures) records its observations and never re-runs a case
    h.calls.length = 0;
    const before = h.ctx.state.tests.length;
    const gate = await h.ctx.services.runTests([FILE]);
    expect(gate.totals.failed).toBe(1);
    expect(gate.diagnosis).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    expect(h.ctx.state.tests).toHaveLength(before + 1);
  });
});

describe('the case name filter', () => {
  it('escapes every regex metacharacter and anchors the full name, describe titles included', () => {
    const pattern = (runner: TestRunnerInfo | undefined): string => {
      const opt = caseNameFilter(runner, [SUITE, LEAKY])?.[0] ?? '';
      expect(opt.startsWith('--testNamePattern=')).toBe(true);
      return opt.slice('--testNamePattern='.length);
    };
    // vitest 4+ joins the titles with ' > ', older vitest with ' '
    const vitest = new RegExp(pattern(undefined));
    expect(vitest.test(`${SUITE} > ${LEAKY}`)).toBe(true);
    expect(vitest.test(`${SUITE} ${LEAKY}`)).toBe(true);
    for (const other of [LEAKY, `${SUITE} > ${LEAKY} (again)`, `other > ${LEAKY}`, `x${SUITE} > ${LEAKY}`, `${SUITE} > ${LEAKY.replace('a.b', 'axb')}`]) {
      expect(vitest.test(other), other).toBe(false);
    }
    // jest: titles joined with ' ', matched case-insensitively
    const jest = new RegExp(pattern(JEST), 'i');
    expect(jest.test(`${SUITE} ${LEAKY}`)).toBe(true);
    expect(jest.test(`${SUITE} > ${LEAKY}`)).toBe(false);
    expect(jest.test(`other ${LEAKY}`)).toBe(false);
    // node:test has no safe name filter
    expect(caseNameFilter(NODE_TEST, [SUITE, LEAKY])).toBeNull();
    expect(caseNameFilter(undefined, [])).toBeNull();
  });
});

type Case = [titles: string[], status: string];
/** A runner JSON report (vitest/jest shape) for FILE under `root`. */
function reportOf(root: string, cases: Case[], message = ''): string {
  return JSON.stringify({
    testResults: [{
      name: join(root, FILE),
      status: cases.some(([, s]) => s === 'failed') || message !== '' ? 'failed' : 'passed',
      message,
      assertionResults: cases.map(([titles, status]) => ({
        ancestorTitles: titles.slice(0, -1),
        title: titles.at(-1) ?? '',
        status,
        failureMessages: status === 'failed' ? ['AssertionError: expected 3 to be 1'] : [],
      })),
    }],
  });
}

interface Reply {
  code: number;
  channel: string;
  timedOut?: boolean;
}

/** Recorded runs: the full run fails LEAKY after one passing case, then each re-run answers `alone`. */
async function recorded(runner: TestRunnerInfo | undefined, alone: (root: string) => Reply) {
  const root = await makeTmp('order-dependence-recorded');
  dirs.push(root);
  const calls: RunnerCall[] = [];
  const fake: Exec = async (_cmd, args, opts) => {
    calls.push({ args, opts });
    const r = calls.length === 1 ? { code: 1, channel: reportOf(root, [[['items', 'adds an item'], 'passed'], [[SUITE, LEAKY], 'failed']]) } : alone(root);
    return { code: r.code, stdout: '', stderr: '', channel: r.channel, durationMs: 1, timedOut: r.timedOut ?? false };
  };
  const logs: LogStore = { write: async (name) => `(memory)/${name}` };
  const report = await runTargetTests({ root, files: [FILE], exec: fake, harnessRoot: HARNESS_ROOT, logs, turn: 1, isolateFailures: true, ...(runner !== undefined ? { runner } : {}) });
  return { report, calls };
}

describe('order dependence with recorded reports', () => {
  it('jest: the name filter goes before --runTestsByPath, and a case that passes alone is named', async () => {
    const { report, calls } = await recorded(JEST, (root) => ({ code: 0, channel: reportOf(root, [[['items', 'adds an item'], 'pending'], [[SUITE, LEAKY], 'passed']]) }));
    expect(calls).toHaveLength(2);
    const args = calls[1]?.args ?? [];
    const at = args.findIndex((a) => a.startsWith('--testNamePattern='));
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(args.indexOf('--runTestsByPath'));
    expect(args.slice(args.indexOf('--runTestsByPath'))).toEqual(['--runTestsByPath', FILE]);
    expect(args).toEqual(expect.arrayContaining(['--json', `--outputFile=${REPORT_CHANNEL}`]));
    expect(calls[1]?.opts.channel).toBe(true);
    expect(report.diagnosis).toEqual([orderDependenceNote(FILE, [SUITE, LEAKY])]);
    expect(report.observations).toHaveLength(1);
  });

  it('no note unless exactly that case ran and passed in a clean isolated run', async () => {
    const refusals: Array<(root: string) => Reply> = [
      // the filter selected a second case too
      (root) => ({ code: 0, channel: reportOf(root, [[['items', 'adds an item'], 'passed'], [[SUITE, LEAKY], 'passed']]) }),
      // it selected nothing
      (root) => ({ code: 0, channel: reportOf(root, [[['items', 'adds an item'], 'skipped'], [[SUITE, LEAKY], 'skipped']]) }),
      // it fails alone too
      (root) => ({ code: 1, channel: reportOf(root, [[['items', 'adds an item'], 'skipped'], [[SUITE, LEAKY], 'failed']]) }),
      // the run errored although the case passed (e.g. an unhandled error), or broke outside the case
      (root) => ({ code: 1, channel: reportOf(root, [[['items', 'adds an item'], 'skipped'], [[SUITE, LEAKY], 'passed']]) }),
      (root) => ({ code: 0, channel: reportOf(root, [[['items', 'adds an item'], 'skipped'], [[SUITE, LEAKY], 'passed']], 'afterAll hook failed') }),
      // no report, or timed out
      () => ({ code: 1, channel: '' }),
      (root) => ({ code: 0, channel: reportOf(root, [[[SUITE, LEAKY], 'passed']]), timedOut: true }),
    ];
    for (const alone of refusals) {
      const { report, calls } = await recorded(undefined, alone);
      expect(calls).toHaveLength(2);
      expect(report.diagnosis).toBeUndefined();
      expect(report.summary).not.toContain(NOTE);
    }
    const ok = await recorded(undefined, (root) => ({ code: 0, channel: reportOf(root, [[['items', 'adds an item'], 'skipped'], [[SUITE, LEAKY], 'passed']]) }));
    expect(ok.report.diagnosis).toEqual([orderDependenceNote(FILE, [SUITE, LEAKY])]);
  });

  it('node:test (no safe name filter): no re-run at all', async () => {
    const { report, calls } = await recorded(NODE_TEST, () => ({ code: 0, channel: '' }));
    expect(report.totals.failed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(report.diagnosis).toBeUndefined();
  });
});
