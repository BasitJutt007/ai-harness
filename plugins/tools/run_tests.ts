import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { isTestFile, isTestSupport } from '../lib/red.ts';

const Input = z.object({
  files: z.array(z.string()).optional().describe('Test files, default all'),
});

/**
 * Each requested file must be an existing test file inside the API root. Anything
 * else is refused before the runner starts: an entry such as `--reporter=./x.ts`
 * or `--root=..` would otherwise reach the runner's argv as an option and could
 * forge the report the harness reads its "observed red" from.
 */
async function checkFiles(files: string[], ws: Parameters<typeof toApiRel>[0]): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }> {
  const out: string[] = [];
  for (const f of files) {
    if (f.trim().startsWith('-')) return { ok: false, reason: `"${f}" looks like a runner option; pass test file paths only` };
    const r = toApiRel(ws, f);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (!isTestFile(r.rel)) {
      const what = isTestSupport(r.rel) ? 'is test support code (a helper), not a runnable test' : 'is not a runnable test file';
      return { ok: false, reason: `${r.rel} ${what}; runnable tests are *.test.ts / *.spec.ts: write test/<name>.test.ts` };
    }
    if (!(await ws.exists(r.rel))) return { ok: false, reason: `${r.rel} does not exist` };
    if (!out.includes(r.rel)) out.push(r.rel);
  }
  return { ok: true, files: out };
}

export default defineTool({
  name: 'run_tests',
  description: 'Run tests; a failing test is recorded as observed red, unlocking the source it covers.',
  input: Input,
  effect: 'exec',
  async run(input, ctx) {
    let files: string[] | undefined;
    if (input.files !== undefined && input.files.length > 0) {
      const checked = await checkFiles(input.files, ctx.workspace);
      if (!checked.ok) return { ok: false, summary: `run_tests: ${checked.reason}. Nothing was run.` };
      files = checked.files;
    }
    const report = await ctx.services.runTests(files);
    const red = report.observations.filter((o) => o.validRed).map((o) => o.file);
    const rejected = report.observations.filter((o) => o.status === 'fail' && !o.validRed).map((o) => `${o.file}: ${o.reason}`);
    const lines = [report.summary, ...rejected];
    if (files !== undefined && report.observations.length === 0) {
      lines.push(`no test file was collected for ${files.join(', ')}; check the runner's include pattern`);
    }
    if (red.length > 0) lines.push(`observed red: ${red.join(', ')} (source they cover is now writable)`);
    const summary = lines.join('\n');
    // Baseline (naive) return: the runner's own console output (what a terminal shows), plus
    // the harness notes above; never shorter than the compact summary.
    const raw = report.console === undefined ? summary : [report.console, ...lines.slice(1)].join('\n');
    return { ok: report.ok, summary, raw: raw.length >= summary.length ? raw : summary, data: { totals: report.totals, observations: report.observations, logPath: report.logPath } };
  },
});
