/**
 * tests-green: the full suite, run fresh by the harness, passes. Honest about
 * what "green" means: every collected test passed, at least one ran, no file
 * failed to load, and nothing was skipped/todo (a skipped test proves nothing).
 *
 * With a run-start baseline (state.testBaseline: brownfield runs measure the target's suite before the
 * agent's first turn), a repository's own history is told apart from what the run did:
 * - a case that was already skipped or todo at run start is "pre-existing skipped": not blocking, listed
 *   in the details and under "human must verify" (test-preservation keeps existing cases as they are, so
 *   the agent could never enable it). A case matches by file and full name, each baseline case excusing
 *   at most one skipped case now.
 * - a skipped/todo case the run introduced (a new one, or one that ran at run start) keeps the gate
 *   UNPROVEN, as does a skip the runner's results cannot attribute to a case.
 * - a failing test, or a file that fails to load, still fails the gate; the summary says which were
 *   already failing at run start.
 * Without a baseline every skip is unproven.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { GateResult, TestBaseline, TestCaseResult, TestRunReport } from '../../src/core/plugin-api.ts';

const MAX_DETAILS = 12;
const MAX_LISTED = 20;

function key(c: Pick<TestCaseResult, 'file' | 'name'>): string {
  return `${c.file}\u0000${c.name}`;
}

function label(c: Pick<TestCaseResult, 'file' | 'name' | 'status'>): string {
  return `${c.file} > ${c.name}${c.status === 'todo' ? ' (todo)' : ''}`;
}

function capped(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`] : lines;
}

interface Skips {
  /** Skipped/todo now and at run start: not blocking. */
  preExisting: TestCaseResult[];
  /** Skipped/todo now but not at run start: the run's doing. */
  introduced: TestCaseResult[];
  /** Skips the runner's per-case results do not account for. */
  unattributed: number;
}

/** Split today's skipped/todo cases by the run-start baseline (a multiset by file and full name). */
function splitSkips(report: TestRunReport, skipped: number, baseline: TestBaseline): Skips {
  const now = (report.results ?? []).filter((r) => r.status === 'skip' || r.status === 'todo');
  const left = new Map<string, number>();
  for (const b of baseline.skipped) left.set(key(b), (left.get(key(b)) ?? 0) + 1);
  const out: Skips = { preExisting: [], introduced: [], unattributed: Math.max(0, skipped - now.length) };
  for (const c of now) {
    const n = left.get(key(c)) ?? 0;
    if (n > 0) {
      left.set(key(c), n - 1);
      out.preExisting.push(c);
    } else {
      out.introduced.push(c);
    }
  }
  return out;
}

/** "; 2 of them were already failing at run start" (empty when none was). */
function alreadyNote(count: number, total: number, what: string): string {
  if (count === 0) return '';
  const who = count === total ? (total === 1 ? 'it was' : `all ${total} were`) : `${count} of them ${count === 1 ? 'was' : 'were'}`;
  return `; ${who} already ${what} at run start`;
}

export default defineGate({
  name: 'tests-green',
  description: "All tests pass when run fresh by the harness's own runner (at least one test, none skipped, every file loads). "
    + 'Brownfield: cases already skipped/todo at run start are reported, not blocking; failing tests always block.',
  phases: ['finish', 'ship'],
  async run(ctx) {
    let report: TestRunReport;
    try {
      report = await ctx.services.runTests();
    } catch (e) {
      return { status: 'unproven', summary: `test runner failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const details = report.summary.split('\n').slice(0, MAX_DETAILS);
    const base: Pick<GateResult, 'details' | 'logPath'> = { details, logPath: report.logPath };
    const { tests, passed, failed, files } = report.totals;
    const loadErrorFiles = report.observations.filter((o) => o.status === 'error').map((o) => o.file);
    const loadErrors = loadErrorFiles.length;
    const skipped = Math.max(0, tests - passed - failed);
    const baseline = ctx.state.testBaseline?.error === undefined ? ctx.state.testBaseline : undefined;
    const noBaseline = ctx.state.testBaseline?.error !== undefined ? `; no run-start baseline (${ctx.state.testBaseline.error})` : '';

    if (failed > 0) {
      const before = new Set((baseline?.failed ?? []).map(key));
      const already = (report.results ?? []).filter((r) => r.status === 'fail' && before.has(key(r)));
      return {
        status: 'fail',
        summary: `${failed} of ${tests} tests failed in ${files} files${alreadyNote(already.length, failed, 'failing')}`,
        details: capped([...details, ...already.map((c) => `already failing at run start (still blocking): ${label(c)}`)], MAX_DETAILS + MAX_LISTED),
        logPath: report.logPath,
      };
    }
    if (loadErrors > 0) {
      const before = new Set(baseline?.loadErrors ?? []);
      const already = loadErrorFiles.filter((f) => before.has(f));
      return {
        status: 'fail',
        summary: `${loadErrors} of ${files} test files failed to load (${passed}/${tests} tests passed)${alreadyNote(already.length, loadErrors, 'failing to load')}`,
        details: [...details, ...already.map((f) => `already failing to load at run start (still blocking): ${f}`)],
        logPath: report.logPath,
      };
    }
    if (tests === 0) return { status: 'unproven', summary: 'no tests ran (an empty suite proves nothing)', ...base };
    if (passed === 0) return { status: 'unproven', summary: `0 of ${tests} tests passed: all skipped or todo (a skipped test proves nothing)`, ...base };

    let preExisting: TestCaseResult[] = [];
    if (skipped > 0) {
      const split = baseline === undefined ? undefined : splitSkips(report, skipped, baseline);
      const blocking = split === undefined ? skipped : split.introduced.length + split.unattributed;
      if (split === undefined || blocking > 0) {
        const pre = split?.preExisting ?? [];
        const head = `${skipped} of ${tests} tests skipped or todo`;
        const advice = '(remove .skip/.todo/.only; a skipped test proves nothing)';
        const which = split === undefined ? [] : [
          ...(split.introduced.length > 0 ? [`${split.introduced.length} introduced by this run`] : []),
          ...(split.unattributed > 0 ? [`${split.unattributed} the runner did not attribute to a test case`] : []),
        ];
        const why = split === undefined
          ? `${head} ${advice}${noBaseline}`
          : `${head}: ${which.join(', ')} ${advice}${pre.length > 0 ? `; ${pre.length} pre-existing (not blocking)` : ''}`;
        return {
          status: 'unproven',
          summary: why,
          details: capped([
            ...details,
            ...(split?.introduced ?? []).map((c) => `skipped by this run: ${label(c)}`),
            ...pre.map((c) => `pre-existing skipped (not blocking): ${label(c)}`),
          ], MAX_DETAILS + MAX_LISTED),
          logPath: report.logPath,
        };
      }
      preExisting = split.preExisting;
    }
    // The runner's ok is false whenever a case did not run: excused only when every such case is pre-existing.
    const excused = preExisting.length > 0 && passed + preExisting.length === tests;
    if (!report.ok && !excused) return { status: 'fail', summary: `the runner reported failure (${passed}/${tests} tests passed in ${files} files)`, ...base };
    if (preExisting.length === 0) return { status: 'pass', summary: `${passed}/${tests} tests passed in ${files} files`, ...base };
    const listed = preExisting.map((c) => `pre-existing skipped (not blocking): ${label(c)}`);
    return {
      status: 'pass',
      summary: `${passed}/${tests} tests passed in ${files} files; ${preExisting.length} pre-existing skipped (not blocking: skipped or todo at run start)`,
      details: capped([...details, ...listed], MAX_DETAILS + MAX_LISTED),
      logPath: report.logPath,
      humanMustVerify: capped(listed, MAX_LISTED),
    };
  },
});
