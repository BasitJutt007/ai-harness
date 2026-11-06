/**
 * check_standards: run the standards checks and say what they mean for this task.
 *
 * Greenfield and brownfield strict (the default): the compact report (every failing line and the summary
 * block), as always.
 *
 * Brownfield in baseline mode (`standards: baseline`; every interactive session): the whole-API report of a
 * repository with years of debt would bury the few lines the run must fix under thousands it may not. So
 * the result leads with exactly what the standards GATE blocks on now (the findings this run introduced, in
 * the files it changed and those a change caused elsewhere: the gate's own classification, shared through
 * baselineAssessment, never a copy of it), then one line per rule counting the pre-existing findings it does
 * not block on, without listing them. With nothing introduced it says so plainly. Without a base report to
 * compare with, the compact report follows a line saying the comparison was unavailable. `all: true`
 * appends every failing line of the report. The full report stays the raw return (logged, never shorter).
 */
import { z } from 'zod';
import { defineTool, type CheckReport, type ToolResult } from '../../src/core/plugin-api.ts';
import { baselineAssessment, preExistingByRule, preExistingCountText, type BaselineFindings } from '../gates/standards.ts';

const Input = z.object({
  rules: z.array(z.string()).optional().describe('Default all'),
  // No field note: the tool list rides in every request (file mode's too). A baseline-mode result names it.
  all: z.boolean().optional(),
});

/** Blocking lines listed before "… N more". */
const MAX_BLOCKING = 20;
const MAX_LINE = 300;

/** One line (line breaks become spaces), cut to MAX_LINE characters. */
function line(text: string): string {
  const t = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return t.length <= MAX_LINE ? t : `${t.slice(0, MAX_LINE - 1)}…`;
}

/** The baseline-mode lead: what blocks, the rules still UNPROVEN, and the pre-existing findings counted per rule. */
function baselineLines(f: BaselineFindings, percent: number): string[] {
  const out: string[] = [];
  const pre = f.preExisting.length;
  if (f.blocking.length > 0) {
    out.push(`BLOCKING: ${f.blocking.length} introduced by this run (the standards gate fails until each is fixed):`);
    for (const b of f.blocking.slice(0, MAX_BLOCKING)) out.push(`  ${line(b.detail)}`);
    if (f.blocking.length > MAX_BLOCKING) out.push(`  … ${f.blocking.length - MAX_BLOCKING} more (check_standards { "all": true } lists every failing line)`);
  } else {
    out.push(`nothing this run introduced blocks; ${pre} pre-existing finding${pre === 1 ? ' is' : 's are'} not blocking`);
  }
  for (const u of f.unproven) out.push(`UNPROVEN (never green): ${line(u)}`);
  for (const c of preExistingByRule(f.preExisting)) out.push(`pre-existing, not blocking: ${preExistingCountText(c)}`);
  out.push(`verdict ${percent}% over the whole API (base commit ${f.basePercent ?? '?'}%); only what this run introduced blocks (baseline mode)${pre > 0 ? '; { "all": true } lists every finding' : ''}`);
  return out;
}

export default defineTool({
  name: 'check_standards',
  description: 'Run the standards checks; returns failures and a summary.',
  input: Input,
  effect: 'exec',
  async run(input, ctx): Promise<ToolResult> {
    const report: CheckReport = await ctx.services.runChecks(input.rules ? { rules: input.rules } : {});
    const full = report.text.length >= report.compact.length ? report.text : report.compact;
    const data = { verdict: report.verdict, rules: report.rules };
    const assessed = await baselineAssessment(ctx, report);
    // Greenfield and brownfield strict: the compact report, as always.
    if (assessed === null) return { ok: report.verdict.status === 'pass', summary: report.compact, raw: full, data };

    const { result, findings } = assessed;
    // The gate's own status, never a green the gate would not give.
    const gate = `standards gate now: ${result.status === 'fail' ? 'FAIL' : result.status === 'unproven' ? `UNPROVEN: ${line(result.summary)}` : result.status}`;
    const ok = result.status === 'pass';
    let summary: string;
    if (findings === null) {
      // Decided before any comparison (every rule green, all n/a, or contradicted): the gate's verdict, then the report.
      summary = `${gate}${result.status === 'unproven' ? '' : ` (${line(result.summary)})`}\n${report.compact}`;
    } else if (findings.unavailable !== null) {
      summary = `the comparison with the base commit is unavailable (${line(findings.unavailable)}): violations in files this run changed block, and the others cannot be proven pre-existing. ${gate}\n${report.compact}`;
    } else {
      const lead = [...baselineLines(findings, report.verdict.percent), gate].join('\n');
      summary = input.all === true ? `${lead}\nevery failing line of the report (pre-existing included):\n${report.compact}` : lead;
    }
    return {
      ok,
      summary,
      // The full report stays the raw return (the baseline replay and the logs), after what blocks.
      raw: `${summary}\n\n${full}`,
      data: {
        ...data,
        gate: { status: result.status, summary: result.summary },
        ...(findings !== null ? { blocking: findings.blocking.length, preExisting: findings.preExisting.length } : {}),
      },
    };
  },
});
