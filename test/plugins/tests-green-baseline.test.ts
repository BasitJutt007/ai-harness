/**
 * tests-green with a run-start baseline (brownfield): cases a repository already had skipped or todo do not
 * block (listed for a human); skips the run introduced, or that cannot be attributed, stay UNPROVEN; failing
 * tests always fail, and the summary says which were already failing at run start.
 */
import { afterEach, describe, expect, it } from 'vitest';
import testsGreen from '../../plugins/gates/tests-green.ts';
import { deserializeState, serializeState } from '../../src/core/run-store.ts';
import { testBaselineOf } from '../../src/core/test-baseline.ts';
import type { TestBaseline, TestCaseResult, TestObservation, TestRunReport } from '../../src/core/plugin-api.ts';
import { brownfieldTask, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const FILE = 'test/legacy.test.ts';
const c = (name: string, status: TestCaseResult['status'], file = FILE): TestCaseResult => ({ file, name, status });

/** A runner report over these case results (plus files that failed to load). */
function report(results: TestCaseResult[], loadErrors: string[] = []): TestRunReport {
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const files = [...new Set(results.map((r) => r.file))];
  const obs = (file: string, status: TestObservation['status']): TestObservation =>
    ({ file, hash: 'h', status, collected: results.filter((r) => r.file === file).length, failed: 0, validRed: false, reason: status, turn: 1, at: '' });
  return {
    ok: passed > 0 && passed === results.length && loadErrors.length === 0,
    totals: { files: files.length + loadErrors.length, tests: results.length, passed, failed },
    observations: [...files.map((f) => obs(f, results.some((r) => r.file === f && r.status === 'fail') ? 'fail' : 'pass')), ...loadErrors.map((f) => obs(f, 'error'))],
    results,
    summary: `tests: ${failed} failed, ${passed} passed (${results.length})`,
    logPath: 'runs/x/logs/vitest.txt',
  };
}

async function gate(now: TestRunReport, baseline?: TestBaseline) {
  const h = await makeHarness({ label: 'tests-green-baseline', task: brownfieldTask(), services: { runTests: async () => now } });
  dirs.push(h.dir);
  if (baseline !== undefined) h.ctx.state.testBaseline = baseline;
  return testsGreen.run(h.ctx, 'finish');
}

const AT_START = testBaselineOf(report([c('runs', 'pass'), c('runs too', 'pass'), c('skipped case', 'skip'), c('todo case', 'todo')]), '2026-10-04T00:00:00Z');

describe('tests-green: skipped/todo cases against the run-start baseline', () => {
  it('cases already skipped or todo at run start do not block: pass, listed as pre-existing for a human', async () => {
    const r = await gate(report([c('runs', 'pass'), c('runs too', 'pass'), c('new case', 'pass', 'test/new.test.ts'), c('skipped case', 'skip'), c('todo case', 'todo')]), AT_START);
    expect(r.status).toBe('pass');
    expect(r.summary).toBe('3/5 tests passed in 2 files; 2 pre-existing skipped (not blocking: skipped or todo at run start)');
    const listed = ['pre-existing skipped (not blocking): test/legacy.test.ts > skipped case', 'pre-existing skipped (not blocking): test/legacy.test.ts > todo case (todo)'];
    expect(r.humanMustVerify).toEqual(listed);
    expect(r.details).toEqual(expect.arrayContaining(listed));
  });

  it('a new skipped or todo case keeps the gate unproven, naming it (the pre-existing ones are still listed)', async () => {
    const r = await gate(report([c('runs', 'pass'), c('runs too', 'pass'), c('skipped case', 'skip'), c('todo case', 'todo'), c('later', 'todo', 'test/new.test.ts')]), AT_START);
    expect(r.status).toBe('unproven');
    expect(r.summary).toBe('3 of 5 tests skipped or todo: 1 introduced by this run (remove .skip/.todo/.only; a skipped test proves nothing); 2 pre-existing (not blocking)');
    expect(r.details).toEqual(expect.arrayContaining(['skipped by this run: test/new.test.ts > later (todo)', 'pre-existing skipped (not blocking): test/legacy.test.ts > skipped case']));
    expect(r.humanMustVerify).toBeUndefined();
  });

  it('a case that ran at run start and is skipped now is introduced by the run', async () => {
    const r = await gate(report([c('runs', 'skip'), c('runs too', 'pass'), c('skipped case', 'skip'), c('todo case', 'todo')]), AT_START);
    expect(r.status).toBe('unproven');
    expect(r.summary).toContain('1 introduced by this run');
    expect(r.details).toContain('skipped by this run: test/legacy.test.ts > runs');
  });

  it('each run-start skip excuses one case of that name: a second copy is introduced', async () => {
    const r = await gate(report([c('runs', 'pass'), c('skipped case', 'skip'), c('skipped case', 'skip'), c('todo case', 'todo')]), AT_START);
    expect(r).toMatchObject({ status: 'unproven', summary: expect.stringContaining('1 introduced by this run') });
  });

  it('a skip the runner did not attribute to a case is never excused', async () => {
    const now = report([c('runs', 'pass'), c('runs too', 'pass')]);
    const unattributed: TestRunReport = { ...now, ok: false, totals: { ...now.totals, tests: 3 } };
    const r = await gate(unattributed, AT_START);
    expect(r).toMatchObject({ status: 'unproven', summary: expect.stringContaining('1 the runner did not attribute to a test case') });
    const noResults: TestRunReport = { ...report([c('runs', 'pass'), c('skipped case', 'skip')]), results: undefined };
    expect((await gate(noResults, AT_START)).status).toBe('unproven');
  });

  it('without a usable baseline every skip stays unproven, and the summary says why', async () => {
    const now = report([c('runs', 'pass'), c('skipped case', 'skip')]);
    const failedBaseline: TestBaseline = { ...AT_START, error: 'tests: runner error (exit 1): config failed to load', skipped: [], failed: [] };
    const r = await gate(now, failedBaseline);
    expect(r.status).toBe('unproven');
    expect(r.summary).toBe('1 of 2 tests skipped or todo (remove .skip/.todo/.only; a skipped test proves nothing); no run-start baseline (tests: runner error (exit 1): config failed to load)');
    expect(await gate(now)).toMatchObject({ status: 'unproven', summary: '1 of 2 tests skipped or todo (remove .skip/.todo/.only; a skipped test proves nothing)' });
  });

  it('a suite whose only cases are pre-existing skips proves nothing: unproven', async () => {
    const r = await gate(report([c('skipped case', 'skip'), c('todo case', 'todo')]), AT_START);
    expect(r).toMatchObject({ status: 'unproven', summary: expect.stringContaining('0 of 2 tests passed') });
  });
});

describe('tests-green: failures against the run-start baseline (always blocking)', () => {
  const FAILING_AT_START = testBaselineOf(report([c('runs', 'pass'), c('flaky clock', 'fail'), c('skipped case', 'skip')], ['test/broken.test.ts']), '2026-10-04T00:00:00Z');

  it('a test failing at run start still fails the gate; the summary says it was already failing', async () => {
    const r = await gate(report([c('runs', 'pass'), c('flaky clock', 'fail'), c('skipped case', 'skip')]), FAILING_AT_START);
    expect(r.status).toBe('fail');
    expect(r.summary).toBe('1 of 3 tests failed in 1 files; it was already failing at run start');
    expect(r.details).toContain('already failing at run start (still blocking): test/legacy.test.ts > flaky clock');
  });

  it('new failures next to pre-existing ones: the summary counts which were already failing', async () => {
    const r = await gate(report([c('runs', 'fail'), c('flaky clock', 'fail'), c('skipped case', 'skip')]), FAILING_AT_START);
    expect(r).toMatchObject({ status: 'fail', summary: '2 of 3 tests failed in 1 files; 1 of them was already failing at run start' });
    expect(r.details).not.toContain('already failing at run start (still blocking): test/legacy.test.ts > runs');
    const fresh = await gate(report([c('runs', 'fail'), c('flaky clock', 'pass')]), FAILING_AT_START);
    expect(fresh).toMatchObject({ status: 'fail', summary: '1 of 2 tests failed in 1 files' });
  });

  it('a file failing to load at run start still fails the gate, and says so', async () => {
    const r = await gate(report([c('runs', 'pass'), c('flaky clock', 'pass')], ['test/broken.test.ts']), FAILING_AT_START);
    expect(r).toMatchObject({ status: 'fail', summary: '1 of 2 test files failed to load (2/2 tests passed); it was already failing to load at run start' });
    expect(r.details).toContain('already failing to load at run start (still blocking): test/broken.test.ts');
  });
});

describe('the baseline in run state', () => {
  it('survives state.json (resume and ship re-run the gates with it); a malformed one is dropped', async () => {
    const h = await makeHarness({ label: 'tests-green-state', task: brownfieldTask() });
    dirs.push(h.dir);
    h.ctx.state.testBaseline = AT_START;
    const round = deserializeState(JSON.parse(JSON.stringify(serializeState(h.ctx.state))));
    expect(round.testBaseline).toEqual(AT_START);
    const bad = { ...serializeState(h.ctx.state), testBaseline: { at: 1, skipped: 'x' } };
    expect(deserializeState(JSON.parse(JSON.stringify(bad))).testBaseline).toBeUndefined();
    expect('testBaseline' in serializeState({ ...h.ctx.state, testBaseline: undefined })).toBe(false);
  });

  it('a report without per-case results gives a baseline that says why it cannot be used', () => {
    const b = testBaselineOf({ ...report([]), results: undefined, summary: 'tests: runner error (timed out): no JSON report\nlog: x' }, 'now');
    expect(b).toMatchObject({ error: 'tests: runner error (timed out): no JSON report', skipped: [], failed: [] });
  });
});
