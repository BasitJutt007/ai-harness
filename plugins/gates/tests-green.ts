/**
 * tests-green: the full suite, run fresh by the harness, passes. Honest about
 * what "green" means: every collected test passed, at least one ran, no file
 * failed to load, and nothing was skipped/todo (a skipped test proves nothing).
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { GateResult, TestRunReport } from '../../src/core/plugin-api.ts';

export default defineGate({
  name: 'tests-green',
  description: "All tests pass when run fresh by the harness's own runner (at least one test, none skipped, every file loads).",
  phases: ['finish', 'ship'],
  async run(ctx) {
    let report: TestRunReport;
    try {
      report = await ctx.services.runTests();
    } catch (e) {
      return { status: 'unproven', summary: `test runner failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const details = report.summary.split('\n').slice(0, 12);
    const base: Pick<GateResult, 'details' | 'logPath'> = { details, logPath: report.logPath };
    const { tests, passed, failed, files } = report.totals;
    const loadErrors = report.observations.filter((o) => o.status === 'error').length;
    const skipped = Math.max(0, tests - passed - failed);
    if (failed > 0) return { status: 'fail', summary: `${failed} of ${tests} tests failed in ${files} files`, ...base };
    if (loadErrors > 0) return { status: 'fail', summary: `${loadErrors} of ${files} test files failed to load (${passed}/${tests} tests passed)`, ...base };
    if (tests === 0) return { status: 'unproven', summary: 'no tests ran (an empty suite proves nothing)', ...base };
    if (passed === 0) return { status: 'unproven', summary: `0 of ${tests} tests passed: all skipped or todo (a skipped test proves nothing)`, ...base };
    if (skipped > 0) {
      return { status: 'unproven', summary: `${skipped} of ${tests} tests skipped or todo (remove .skip/.todo/.only; a skipped test proves nothing)`, ...base };
    }
    if (!report.ok) return { status: 'fail', summary: `the runner reported failure (${passed}/${tests} tests passed in ${files} files)`, ...base };
    return { status: 'pass', summary: `${passed}/${tests} tests passed in ${files} files`, ...base };
  },
});
