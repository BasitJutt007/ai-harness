/**
 * Hook runner. Hooks enforce rules mechanically (hooks, not prompts).
 *
 * - Filtered by event, tool effect and tool name.
 * - First block wins: remaining hooks are skipped.
 * - Fail closed: a hook that throws (or returns garbage) blocks the call.
 * - Every decision is emitted as a RunEvent.
 */
import type {
  HookEvent,
  HookPlugin,
  HookVerdict,
  PluginRecord,
  RunContext,
  ToolCallInfo,
  ToolResult,
} from './types.ts';

export interface HookOutcome {
  blocked: { hook: string; reason: string } | null;
  notes: Array<{ hook: string; note: string }>;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hookApplies(h: HookPlugin, event: HookEvent['event'], call: ToolCallInfo): boolean {
  if (!h.events.includes(event)) return false;
  if (h.effects !== undefined && h.effects.length > 0 && !h.effects.includes(call.effect)) return false;
  if (h.tools !== undefined && h.tools.length > 0 && !h.tools.includes(call.tool)) return false;
  return true;
}

/** Narrow whatever a hook returned to a verdict; anything malformed is treated as a block. */
function normalise(v: unknown): HookVerdict | null {
  if (typeof v !== 'object' || v === null || !('decision' in v)) return null;
  const d: unknown = v.decision;
  if (d === 'pass') return { decision: 'pass' };
  if (d === 'block' && 'reason' in v && typeof v.reason === 'string') return { decision: 'block', reason: v.reason };
  if (d === 'record' && 'note' in v && typeof v.note === 'string') return { decision: 'record', note: v.note };
  return null;
}

async function runHooks(hooks: PluginRecord<HookPlugin>[], event: HookEvent, ctx: RunContext): Promise<HookOutcome> {
  const out: HookOutcome = { blocked: null, notes: [] };
  const call = event.call;
  for (const rec of hooks) {
    const h = rec.plugin;
    if (!hookApplies(h, event.event, call)) continue;
    let verdict: HookVerdict;
    try {
      const raw: unknown = await h.run(event, ctx);
      verdict = normalise(raw) ?? { decision: 'block', reason: `hook ${h.name} returned an invalid verdict` };
    } catch (e) {
      verdict = { decision: 'block', reason: `hook ${h.name} crashed: ${errMsg(e)}` };
    }
    const data = { event: event.event, tool: call.tool, callId: call.id, paths: call.paths };
    if (verdict.decision === 'block') {
      ctx.emit({ kind: 'hook', source: h.name, decision: 'block', message: verdict.reason, data });
      out.blocked = { hook: h.name, reason: verdict.reason };
      return out;
    }
    if (verdict.decision === 'record') {
      ctx.emit({ kind: 'hook', source: h.name, decision: 'record', message: verdict.note, data });
      out.notes.push({ hook: h.name, note: verdict.note });
      continue;
    }
    ctx.emit({ kind: 'hook', source: h.name, decision: 'pass', message: `${event.event} ${call.tool}`, data });
  }
  return out;
}

export async function runPreHooks(
  hooks: PluginRecord<HookPlugin>[],
  call: ToolCallInfo,
  ctx: RunContext,
): Promise<HookOutcome> {
  return runHooks(hooks, { event: 'pre_tool', call }, ctx);
}

export async function runPostHooks(
  hooks: PluginRecord<HookPlugin>[],
  call: ToolCallInfo,
  result: ToolResult,
  ctx: RunContext,
): Promise<HookOutcome> {
  return runHooks(hooks, { event: 'post_tool', call, result }, ctx);
}
