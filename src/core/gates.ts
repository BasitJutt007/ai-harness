/**
 * Gate runner. Gates decide completion deterministically; the agent never does.
 *
 * ok iff no gate is fail/unproven and at least one gate passed.
 * A gate that throws is UNPROVEN (never green). A gate that does not apply to the
 * task kind is reported as n/a and not run.
 */
import type { GatePhase, GatePlugin, GateResult, GateStatus, PluginRecord, RunContext } from './types.ts';

export type NamedGateResult = GateResult & { gate: string };

export interface GateOutcome {
  ok: boolean;
  results: NamedGateResult[];
  /** One line per gate. */
  text: string;
  /** Gate lines plus detail lines of failing/unproven gates (what the model sees on a refusal). */
  compact: string;
}

const STATUSES: readonly GateStatus[] = ['pass', 'fail', 'unproven', 'n/a'];
const MAX_DETAILS = 12;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalise(name: string, v: unknown): GateResult {
  if (typeof v !== 'object' || v === null || !('status' in v) || !('summary' in v)) {
    return { status: 'unproven', summary: `gate ${name} returned an invalid result` };
  }
  const status = STATUSES.find((s) => s === v.status);
  if (status === undefined || typeof v.summary !== 'string') {
    return { status: 'unproven', summary: `gate ${name} returned an invalid result` };
  }
  const r: GateResult = { status, summary: v.summary };
  if ('details' in v && Array.isArray(v.details)) r.details = v.details.filter((d): d is string => typeof d === 'string');
  if ('logPath' in v && typeof v.logPath === 'string') r.logPath = v.logPath;
  if ('humanMustVerify' in v && Array.isArray(v.humanMustVerify)) {
    r.humanMustVerify = v.humanMustVerify.filter((d): d is string => typeof d === 'string');
  }
  if ('failing' in v && typeof v.failing === 'number' && Number.isInteger(v.failing) && v.failing >= 0) r.failing = v.failing;
  return r;
}

export function gateLine(r: NamedGateResult): string {
  return `gate  ${r.gate.padEnd(14)} ${r.status.padEnd(9)} ${r.summary}`;
}

export function formatGates(results: NamedGateResult[], withDetails: boolean): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(gateLine(r));
    if (!withDetails || r.status === 'pass' || r.status === 'n/a') continue;
    const details = r.details ?? [];
    for (const d of details.slice(0, MAX_DETAILS)) lines.push(`    ${d}`);
    if (details.length > MAX_DETAILS) lines.push(`    … ${details.length - MAX_DETAILS} more`);
    if (r.logPath !== undefined) lines.push(`    log: ${r.logPath}`);
  }
  return lines.join('\n');
}

/**
 * Failing units of a gate run: per fail/unproven gate, the units it reports failing (`failing`),
 * else its detail lines, at least 1. The loop compares it between finish attempts (progress).
 */
export function failingUnits(results: GateResult[]): number {
  let n = 0;
  for (const r of results) {
    if (r.status !== 'fail' && r.status !== 'unproven') continue;
    n += Math.max(1, r.failing ?? r.details?.length ?? 0);
  }
  return n;
}

export function gatesOk(results: GateResult[]): boolean {
  const bad = results.some((r) => r.status === 'fail' || r.status === 'unproven');
  return !bad && results.some((r) => r.status === 'pass');
}

export async function runGates(
  gates: PluginRecord<GatePlugin>[],
  ctx: RunContext,
  phase: GatePhase,
): Promise<GateOutcome> {
  const results: NamedGateResult[] = [];
  for (const rec of gates) {
    const g = rec.plugin;
    if (!g.phases.includes(phase)) continue;
    let r: GateResult;
    if (g.appliesTo !== undefined && !g.appliesTo.includes(ctx.task.kind)) {
      r = { status: 'n/a', summary: `not applicable to ${ctx.task.kind} tasks` };
    } else {
      try {
        r = normalise(g.name, await g.run(ctx, phase));
      } catch (e) {
        r = { status: 'unproven', summary: `gate ${g.name} crashed: ${errMsg(e)}` };
      }
    }
    const named: NamedGateResult = { gate: g.name, ...r };
    results.push(named);
    ctx.emit({
      kind: 'gate',
      source: g.name,
      decision: r.status === 'pass' || r.status === 'n/a' ? 'pass' : 'block',
      message: `${phase}: ${r.status} ${r.summary}`,
      data: { phase, status: r.status, details: r.details, logPath: r.logPath },
    });
  }
  return {
    ok: gatesOk(results),
    results,
    text: formatGates(results, false),
    compact: formatGates(results, true),
  };
}
