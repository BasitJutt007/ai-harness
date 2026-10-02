/**
 * Local token counting with the o200k_base BPE (js-tiktoken). Helper module, not a plugin.
 *
 * Used by drivers whose provider has no token-counting endpoint, and by the offline
 * scripted driver. The encoder is built once and cached for the process.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type { ModelRequest, Part } from '../../src/core/plugin-api.ts';

let cached: Tiktoken | undefined;

/** The shared o200k_base encoder (created lazily, then reused). */
export function encoder(): Tiktoken {
  if (cached === undefined) cached = new Tiktoken(o200kBase);
  return cached;
}

/** Token count of a plain string. Special-token text is encoded as ordinary text (never throws). */
export function countText(s: string): number {
  if (s.length === 0) return 0;
  return encoder().encode(s, [], []).length;
}

/** Text a part contributes to a request. */
export function serializePart(p: Part): string {
  switch (p.type) {
    case 'text':
      return p.text;
    case 'tool_call':
      return `${p.id} ${p.name} ${JSON.stringify(p.input ?? null)}`;
    case 'tool_result':
      return `${p.callId} ${p.content}`;
    case 'opaque':
      return JSON.stringify(p.data ?? null);
  }
}

/** Per-message framing overhead (role markers) and reply priming, chat-format convention. */
export const MESSAGE_OVERHEAD = 3;
export const REPLY_PRIMING = 3;

/** Provider-neutral estimate of the input tokens of a request: system + messages + tool specs. */
export function countRequest(req: ModelRequest): number {
  let total = countText(req.system) + REPLY_PRIMING;
  for (const m of req.messages) {
    total += MESSAGE_OVERHEAD + countText(m.role);
    for (const p of m.parts) total += countText(serializePart(p));
  }
  if (req.tools.length > 0) total += countText(JSON.stringify(req.tools));
  return total;
}
