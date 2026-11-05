/**
 * The session's verdict: what the gates say about the work in the working tree, computed fresh by
 * the harness and never taken from the model's prose (it runs after the model's finish was accepted,
 * and on /gates).
 *
 *   DONE      every required finish gate passes (run fresh, with the required list: a missing or n/a
 *             gate is UNPROVEN), and nothing about the session itself is unproven: an approved item is
 *             bound, the working tree has a change, agent code ran confined, the target profile has no
 *             unsupported part, the standards report was produced.
 *   NOT DONE  at least one gate failed.
 *   UNPROVEN  no gate failed, but something could not be proven.
 * The reasons and what a human must verify come with every verdict (run.ts honesty helpers).
 */
import { requiredGates, runGates, type NamedGateResult } from '../core/gates.ts';
import { honesty, runUnprovenItems, standardsLine, type Honesty } from '../core/run.ts';
import { isolationHonesty, type IsolationInfo } from '../core/sandbox.ts';
import type { CheckReport, RunContext } from '../core/types.ts';

export type VerdictKind = 'DONE' | 'NOT DONE' | 'UNPROVEN';

export interface SessionVerdict {
  kind: VerdictKind;
  /** What keeps it from DONE (empty when DONE). */
  reasons: string[];
  gates: NamedGateResult[];
  gatesOk: boolean;
  standards: string;
  honesty: Honesty;
  humanMustVerify: string[];
  /** The item the verdict is about (null: none was approved). */
  item: { slug: string; contractHash: string } | null;
  /** Repository paths with a change against the session's start commit, when the verdict was taken. */
  changed: string[];
  trigger: 'finish' | 'gates';
  at: string;
}

export interface VerdictInputs {
  ctx: RunContext;
  isolation: IsolationInfo;
  /** The target profile's unsupported parts (or why there is no profile). */
  targetNotes: string[];
  /** Repository paths changed against the start commit (the working tree the gates judge). */
  changed: string[];
  trigger: 'finish' | 'gates';
}

/** Run every required finish gate fresh, then the checks, and decide. */
export async function computeVerdict(v: VerdictInputs): Promise<SessionVerdict> {
  const { ctx } = v;
  const at = new Date().toISOString();
  const item = ctx.item === undefined ? null : { slug: ctx.item.slug, contractHash: ctx.item.contractHash };
  const final = await runGates(ctx.registry.gates, ctx, 'finish', { required: requiredGates(ctx.task, 'finish', ctx.stack) });
  let report: CheckReport | null = null;
  try {
    report = await ctx.services.runChecks();
  } catch {
    report = null;
  }
  const session: string[] = [];
  if (item === null) session.push('no approved contract is bound to this session: nothing is complete without one');
  if (v.changed.length === 0) session.push('the working tree has no change against the session start commit: there is no work to complete');
  const runUnproven = [...session, ...runUnprovenItems({ isolation: v.isolation, targetNotes: v.targetNotes, checksCrashed: report === null })];
  const h = honesty(ctx.task, final.results, report, v.targetNotes.map((t) => `target: ${t}`));
  const iso = isolationHonesty(v.isolation);
  (iso.proven ? h.proven : h.unproven).push(iso.line);
  for (const s of session) h.unproven.push(`session: ${s}`);
  const failed = final.results.filter((r) => r.status === 'fail');
  const unprovenGates = final.results.filter((r) => r.status === 'unproven');
  let kind: VerdictKind;
  let reasons: string[];
  if (final.ok && runUnproven.length === 0) {
    kind = 'DONE';
    reasons = [];
  } else if (failed.length > 0) {
    kind = 'NOT DONE';
    reasons = [...failed.map((r) => `gate ${r.gate} failed: ${r.summary}`), ...unprovenGates.map((r) => `gate ${r.gate} UNPROVEN: ${r.summary}`), ...runUnproven];
  } else {
    kind = 'UNPROVEN';
    reasons = [...unprovenGates.map((r) => `gate ${r.gate} UNPROVEN: ${r.summary}`), ...runUnproven];
    if (reasons.length === 0) reasons.push('no gate passed: nothing proves the work');
  }
  return {
    kind,
    reasons,
    gates: final.results,
    gatesOk: final.ok,
    standards: standardsLine(report, false, ctx.task.kind, ctx.task.kind === 'brownfield' ? ctx.task.standards : undefined),
    honesty: h,
    humanMustVerify: h.humanMustVerify,
    item,
    changed: v.changed,
    trigger: v.trigger,
    at,
  };
}

/** The verdict as run.json records it (gate statuses, not their detail). */
export function verdictRecord(v: SessionVerdict): Record<string, unknown> {
  return {
    kind: v.kind,
    at: v.at,
    trigger: v.trigger,
    item: v.item,
    reasons: v.reasons,
    gates: Object.fromEntries(v.gates.map((g) => [g.gate, g.status])),
    gateSummaries: v.gates.map((g) => ({ gate: g.gate, status: g.status, summary: g.summary })),
    standards: v.standards,
    changed: v.changed,
    honesty: v.honesty,
  };
}
