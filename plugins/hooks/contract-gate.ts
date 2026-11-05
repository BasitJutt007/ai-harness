/**
 * contract-gate (pre, write + finish): the human-yes gate. The contract is proposed to the
 * stakeholder, and their yes must be a typed terminal turn after that proposal, about this exact
 * contract text, in their own words: an entry the harness's terminal reader wrote to
 * items/<slug>/ledger.jsonl. Assistant text, tool output and hook output never enter the ledger as
 * human turns, so they can never count; a reply on a pipe, a reply before the proposal or to an
 * older one, and an ambiguous reply ("yes but ...") do not count either.
 *
 * Blocks every write until the yes exists, and holds the Stop: a finish request is refused, and the
 * refusal lists each "yes" it saw that did not count, including ones in this run's tool output and
 * assistant text, with why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalVerdict, contractVerdict, defineHook, itemPaths, pointWhenRunDirectly, readLedger } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';

// Run on its own this file enforces nothing (hooks act inside a run): say how to check the gate instead.
pointWhenRunDirectly(import.meta.url, "contract-gate is a harness hook: it blocks edits and holds finish inside a run. To check an item's human-yes gate now: harness gate human-yes <slug> [--repo <dir>]");

const YES = /\b(yes|approved?|lgtm|go ahead|ship it)\b/i;

interface TranscriptLine {
  turn?: number;
  assistant?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  results?: Array<{ type?: string; content?: string; callId?: string }> | null;
}

/**
 * A tool result without the harness's own text in it. A hook's refusal ("BLOCKED by contract-gate:
 * contract-gate: edit refused: no stakeholder yes ..."), the finish gates' verdict and a hook's note
 * are written by the harness, not by the tool: their "yes" ("no stakeholder yes") is not a tool saying
 * yes, and labelling it so would misreport what the run did.
 */
export function withoutHarnessText(content: string): string {
  if (/^(BLOCKED by [\w-]+:|FINISH REFUSED|FINISH ACCEPTED)/.test(content)) return '';
  return content.split('\n').filter((l) => !/^BLOCKED by [\w-]+: /.test(l) && !/^\[[\w-]+\] /.test(l)).join('\n');
}

/** Every "yes" in this run's own transcript (assistant text, tool calls, tool output): none of it is a stakeholder turn. */
export function yesOutsideHumanTurns(ctx: RunContext): string[] {
  let text: string;
  try {
    text = readFileSync(join(ctx.run.runDir, 'transcript.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const seen: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let t: TranscriptLine;
    try {
      t = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const turn = t.turn ?? '?';
    for (const p of t.assistant ?? []) {
      if (p.type === 'text' && YES.test(p.text ?? '')) seen.push(`turn ${turn}: assistant text says "yes" (assistant text never counts)`);
      if (p.type === 'tool_call' && YES.test(JSON.stringify(p.input ?? ''))) seen.push(`turn ${turn}: a ${p.name ?? 'tool'} call carries "yes" (tool input never counts)`);
    }
    for (const p of t.results ?? []) {
      if (p.type === 'tool_result' && YES.test(withoutHarnessText(p.content ?? ''))) seen.push(`turn ${turn}: tool output says "yes" (tool output never counts)`);
      if (p.type === 'text' && YES.test((p as { text?: string }).text ?? '')) seen.push(`turn ${turn}: harness or hook text says "yes" (hook output never counts)`);
    }
  }
  return [...new Set(seen)].slice(0, 6);
}

export default defineHook({
  name: 'contract-gate',
  description: "Blocks every edit, and holds finish (the Stop), until the stakeholder's yes is a typed terminal turn after the proposal of this exact contract text.",
  events: ['pre_tool'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    const isStop = call.tool === 'finish';
    if (call.effect !== 'write' && !isStop) return { decision: 'pass' };
    const what = isStop ? 'Stop held' : 'edit refused';
    const item = ctx.item;
    if (item === undefined) return { decision: 'block', reason: `contract-gate: ${what}: this run is bound to no backlog item, so there is no proposal a stakeholder could have approved.` };
    const paths = itemPaths(item.root, item.slug);
    const c = contractVerdict(paths);
    if (!c.ok || c.parse === null) return { decision: 'block', reason: `contract-gate: ${what}: ${c.reason}.` };
    const v = approvalVerdict(readLedger(paths.ledger), c.parse.hash);
    if (v.ok && c.parse.hash === item.contractHash) return { decision: 'pass' };
    const reason = v.ok ? `the approved contract changed after this run started` : v.reason;
    const extra = isStop ? yesOutsideHumanTurns(ctx) : [];
    const tail = extra.length > 0 ? ` Seen in this run but not counted: ${extra.join('; ')}.` : '';
    return { decision: 'block', reason: `contract-gate: ${what}: no stakeholder yes for ${item.slug}: ${reason}.${tail} Only ${v.stakeholder ?? 'the stakeholder'} typing a reply at a terminal (harness item reply ${item.slug}) can approve.` };
  },
});
