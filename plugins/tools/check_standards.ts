/**
 * check_standards: run the standards checks and say what they mean for this task.
 *
 * Greenfield and brownfield strict (the default): the compact report (the failing lines, its first
 * violations, and the summary block), as always.
 *
 * Brownfield in baseline mode (`standards: baseline`; every interactive session): the whole-API report of a
 * repository with years of debt would bury the few lines the run must fix under thousands it may not. So
 * the result leads with exactly what the standards GATE blocks on now (the findings this run introduced, in
 * the files it changed and those a change caused elsewhere: the gate's own classification, shared through
 * baselineAssessment, never a copy of it), then one line per rule counting the pre-existing findings it does
 * not block on, without listing them. With nothing introduced it says so plainly. Without a base report to
 * compare with, the compact report follows a line saying the comparison was unavailable. By default it lists
 * the first MAX_BLOCKING blocking lines and counts the rest; `all: true` lists every blocking line (no cap:
 * each is something the run must fix), then the compact report (pre-existing included; the report itself
 * lists its first violations and counts the rest). The full report stays the raw return (logged, never
 * shorter).
 *
 * With `rules` (a subset) the same classification covers only those rules. The gate checks every rule, so
 * such a call never states the gate's verdict: it says what blocks among the rules it checked and that the
 * gate was not judged; `ok` is those rules' own result (as a subset's verdict is in strict mode), never the
 * gate's. Only a call over every rule says "standards gate now", and its `ok` is the gate's own status.
 */
import { z } from 'zod';
import { defineTool, type CheckReport, type GateResult, type ToolResult } from '../../src/core/plugin-api.ts';
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

/** A result's status as a line ends with it: FAIL, UNPROVEN with why, or pass. */
function statusText(r: GateResult): string {
  return r.status === 'fail' ? 'FAIL' : r.status === 'unproven' ? `UNPROVEN: ${line(r.summary)}` : r.status;
}

/**
 * The baseline-mode lead: what blocks, the rules still UNPROVEN, and the pre-existing findings counted per
 * rule. `subset`: the rules a call checked (null: every rule), named wherever a line would otherwise speak
 * for the whole API. `all`: every blocking line, none held back (else the first MAX_BLOCKING and a count).
 */
function baselineLines(f: BaselineFindings, percent: number, subset: string[] | null, all: boolean): string[] {
  const out: string[] = [];
  const pre = f.preExisting.length;
  const within = subset !== null ? ' in the rules this call checked' : '';
  if (f.blocking.length > 0) {
    out.push(`BLOCKING: ${f.blocking.length} introduced by this run${within} (the standards gate fails until each is fixed):`);
    for (const b of all ? f.blocking : f.blocking.slice(0, MAX_BLOCKING)) out.push(`  ${line(b.detail)}`);
    if (!all && f.blocking.length > MAX_BLOCKING) out.push(`  … ${f.blocking.length - MAX_BLOCKING} more (the same call with "all": true lists every blocking line)`);
  } else {
    out.push(`nothing this run introduced${within} blocks; ${pre} pre-existing finding${pre === 1 ? ' is' : 's are'} not blocking`);
  }
  for (const u of f.unproven) out.push(`UNPROVEN (never green): ${line(u)}`);
  for (const c of preExistingByRule(f.preExisting)) out.push(`pre-existing, not blocking: ${preExistingCountText(c)}`);
  const over = subset === null ? `over the whole API (base commit ${f.basePercent ?? '?'}%)` : `over the rules this call checked (${subset.join(', ')})`;
  const more = !all && pre > 0 ? '; "all": true adds the report\'s failing lines, pre-existing included' : '';
  out.push(`verdict ${percent}% ${over}; only what this run introduced blocks (baseline mode)${more}`);
  return out;
}

/** The compact report under its heading: what it is, and that it lists only its first violations when it does. */
function reportLines(report: CheckReport): string {
  const cut = /\n\s*… \d+ more violations/.test(report.compact) ? '; it lists the first violations and counts the rest' : '';
  return `the standards report's failing lines (pre-existing included${cut}):\n${report.compact}`;
}

export default defineTool({
  name: 'check_standards',
  description: 'Run the standards checks; returns failures and a summary.',
  input: Input,
  effect: 'exec',
  async run(input, ctx): Promise<ToolResult> {
    // An empty list selects every rule (selectChecks): only a non-empty one is a subset.
    const subset = input.rules !== undefined && input.rules.length > 0 ? input.rules : null;
    const report: CheckReport = await ctx.services.runChecks(input.rules ? { rules: input.rules } : {});
    const full = report.text.length >= report.compact.length ? report.text : report.compact;
    const data = { verdict: report.verdict, rules: report.rules };
    const assessed = await baselineAssessment(ctx, report, { subset: subset !== null });
    // Greenfield and brownfield strict: the compact report, as always.
    if (assessed === null) return { ok: report.verdict.status === 'pass', summary: report.compact, raw: full, data };

    const { result, findings } = assessed;
    // Every rule: the gate's own status, never a green the gate would not give. A subset: what the gate's
    // classification says of those rules, and plainly that the gate (every rule) was not judged.
    const verdict = subset === null
      ? `standards gate now: ${statusText(result)}`
      : `the rules this call checked (${subset.join(', ')}): ${statusText(result)}. The standards gate checks every rule and was not judged by this call: check_standards without "rules" says what it blocks on`;
    const ok = result.status === 'pass';
    let summary: string;
    if (findings === null) {
      // Decided before any comparison (every rule green, all n/a, or contradicted): the verdict, then the report.
      summary = `${verdict}${result.status === 'unproven' ? '' : ` (${line(result.summary)})`}\n${report.compact}`;
    } else if (findings.unavailable !== null) {
      summary = `the comparison with the base commit is unavailable (${line(findings.unavailable)}): violations in files this run changed block, and the others cannot be proven pre-existing. ${verdict}\n${report.compact}`;
    } else {
      const all = input.all === true;
      const lead = [...baselineLines(findings, report.verdict.percent, subset, all), verdict].join('\n');
      summary = all ? `${lead}\n${reportLines(report)}` : lead;
    }
    return {
      ok,
      summary,
      // The full report stays the raw return (the baseline replay and the logs), after what blocks.
      raw: `${summary}\n\n${full}`,
      data: {
        ...data,
        // The gate's status only from a call over every rule; a subset records its own result instead.
        ...(subset === null ? { gate: { status: result.status, summary: result.summary } } : { subset: { rules: subset, status: result.status, summary: result.summary } }),
        ...(findings !== null ? { blocking: findings.blocking.length, preExisting: findings.preExisting.length } : {}),
      },
    };
  },
});
