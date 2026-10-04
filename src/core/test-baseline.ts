/**
 * The target's own test results at run start (brownfield runs): the full suite, run once with the
 * harness's runner before the agent's first turn and kept in RunState.testBaseline (state.json).
 * It is never recorded as a test observation: nothing in it is evidence of what the agent did.
 *
 * tests-green uses it to tell what a repository already had from what the run introduced: a case
 * that was skipped or todo at run start is "pre-existing skipped" (not blocking, listed for a human;
 * test-preservation keeps existing cases as they are, so the agent could never enable it), while a
 * new skipped/todo case, or one that ran at run start and is skipped now, still blocks. A case that
 * was already failing at run start still fails the gate; the baseline only lets it say so.
 */
import { z } from 'zod';
import { runVitest } from './testing.ts';
import type { Exec, LogStore, TestBaseline, TestRunReport } from './types.ts';

/** The baseline a run-start report gives; `error` when the runner produced no per-case results. */
export function testBaselineOf(report: TestRunReport, at: string): TestBaseline {
  const base = { at, totals: { ...report.totals }, logPath: report.logPath };
  if (report.results === undefined) {
    return { ...base, error: (report.summary.split('\n')[0] ?? '').trim() || 'the test runner produced no results', skipped: [], failed: [], loadErrors: [] };
  }
  return {
    ...base,
    skipped: report.results.filter((r) => r.status === 'skip' || r.status === 'todo').map((r) => ({ ...r })),
    failed: report.results.filter((r) => r.status === 'fail').map((r) => ({ ...r })),
    loadErrors: report.observations.filter((o) => o.status === 'error').map((o) => o.file).sort(),
    files: report.observations.map((o) => o.file).sort(),
  };
}

/** Run the API's whole suite now (before the agent's first turn) and keep what the gates need of it. */
export async function measureTestBaseline(opts: { root: string; exec: Exec; harnessRoot: string; logs: LogStore }): Promise<TestBaseline> {
  const at = new Date().toISOString();
  try {
    return testBaselineOf(await runVitest({ ...opts, turn: 0 }), at);
  } catch (e) {
    return {
      at,
      error: `the test runner failed: ${e instanceof Error ? e.message : String(e)}`,
      totals: { files: 0, tests: 0, passed: 0, failed: 0 },
      skipped: [],
      failed: [],
      loadErrors: [],
    };
  }
}

/** One line for the run's events. */
export function describeTestBaseline(b: TestBaseline): string {
  if (b.error !== undefined) return `test baseline at run start unavailable: ${b.error}`;
  const { tests, passed, files } = b.totals;
  const extra = [
    ...(b.skipped.length > 0 ? [`${b.skipped.length} skipped/todo`] : []),
    ...(b.failed.length > 0 ? [`${b.failed.length} failing`] : []),
    ...(b.loadErrors.length > 0 ? [`${b.loadErrors.length} files failing to load`] : []),
  ];
  return `test baseline at run start: ${passed}/${tests} tests passed in ${files} files${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
}

const CaseShape = z.object({ file: z.string(), name: z.string(), status: z.enum(['pass', 'fail', 'skip', 'todo']) });
const BaselineShape = z.object({
  at: z.string(),
  error: z.string().optional(),
  totals: z.object({ files: z.number(), tests: z.number(), passed: z.number(), failed: z.number() }),
  skipped: z.array(CaseShape),
  failed: z.array(CaseShape),
  loadErrors: z.array(z.string()),
  files: z.array(z.string()).optional(),
  logPath: z.string().optional(),
});

/** A baseline read back from state.json, or undefined when absent or malformed. */
export function parseTestBaseline(v: unknown): TestBaseline | undefined {
  const parsed = BaselineShape.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}
