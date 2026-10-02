/**
 * Context views over ONE canonical transcript.
 *
 * jitView      what the model actually sees (with compactHistory):
 *              - every tool_call input string longer than ELIDE_INPUT_CHARS is elided from
 *                the first replay on: the payload is on disk (or was refused, which the
 *                result says) and the tool result already summarises it;
 *              - the last `keepRecentTurns` turns stay as structured messages (compact tool
 *                summaries, verbatim assistant text);
 *              - older turns fold into a digest appended to the first user message: one
 *                line per tool call (`t<turn> <tool> <short input> -> <first line of result>`,
 *                input strings longer than DIGEST_VALUE_CHARS shown as `<N chars>`), assistant
 *                prose and opaque parts dropped with their turn.
 * baselineView the shadow baseline: raw tool returns everywhere, nothing elided or folded.
 *
 * Both rules are pure functions of (turn index, number of turns) and append-only: input
 * elision never changes after the first replay, and the digest only ever gains lines at
 * its end. So the serialized request prefix (system, tools, brief, digest so far) is stable
 * from turn to turn, which keeps provider-side prompt caching effective.
 */
import type { Message, Part } from './types.ts';

export interface TranscriptTurn {
  turn: number;
  /** As returned by the driver. */
  assistant: Message;
  /** User message with tool_result parts (compact content in JIT mode), or a nudge, or null. */
  results: Message | null;
  /** callId -> raw tool output (for the baseline view). */
  raw: Record<string, string>;
}

/** Digest lines quote at most this many characters of a result's first line. */
export const MAX_STUB_CHARS = 200;
/** Tool-call input strings longer than this are elided in the JIT view. */
export const ELIDE_INPUT_CHARS = 300;
/**
 * Digest lines show input strings up to this length (paths, patterns, rule ids, plan steps);
 * longer ones (file contents, edit find/replace text) become `<N chars>`: the result line
 * already says what the call did, and the payload is on disk.
 */
export const DIGEST_VALUE_CHARS = 80;

/**
 * Placeholder for an elided input string. The path (when any) stays visible in the same
 * input object, and the system prompt says once that large inputs are omitted.
 */
export function omitted(n: number): string {
  return `<omitted ${n} chars>`;
}

/** Tool-call input with every string longer than ELIDE_INPUT_CHARS replaced by a placeholder. */
export function compactToolInput(v: unknown): unknown {
  if (typeof v === 'string') return v.length > ELIDE_INPUT_CHARS ? omitted(v.length) : v;
  if (Array.isArray(v)) return v.map(compactToolInput);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = compactToolInput(x);
    return out;
  }
  return v;
}

/** Digest rendering of one input value: bare when it is a single token, `<N chars>` when long. */
function digestValue(x: unknown): string {
  if (typeof x === 'string') {
    if (x.length > DIGEST_VALUE_CHARS) return `<${x.length} chars>`;
    return /^[^\s"[\]{},=<>]+$/.test(x) ? x : JSON.stringify(x);
  }
  if (Array.isArray(x)) return `[${x.map(digestValue).join(',')}]`;
  if (typeof x === 'object' && x !== null) {
    return `{${Object.entries(x).map(([k, v]) => `${k}:${digestValue(v)}`).join(',')}}`;
  }
  return JSON.stringify(x) ?? String(x);
}

/** Short `key=value` rendering of a tool input for the digest (long strings as `<N chars>`). */
export function digestInput(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input === undefined ? '' : digestValue(input);
  return Object.entries(input)
    .map(([k, x]) => `${k}=${digestValue(x)}`)
    .join(' ');
}

function elideCalls(m: Message): Message {
  if (!m.parts.some((p) => p.type === 'tool_call')) return m;
  return { role: m.role, parts: m.parts.map((p) => (p.type === 'tool_call' ? { ...p, input: compactToolInput(p.input) } : p)) };
}

/** Opening line of the history digest (explains the format once, instead of per stub). */
export const DIGEST_HEADER = 'Earlier turns, one line per tool call (tool, short input, first line of its result; re-run a tool to see more):';

/** First line of a result that carries text (skips blank and rule-only lines), capped. */
export function headline(s: string): string {
  const line = (s.split('\n').find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '').trim().replace(/\s+/g, ' ');
  return line.length > MAX_STUB_CHARS ? `${line.slice(0, MAX_STUB_CHARS)}…` : line;
}

/** Digest lines for one turn: deterministic, depends on that turn only. */
export function digestTurn(t: TranscriptTurn): string[] {
  const results = new Map<string, string>();
  for (const p of t.results?.parts ?? []) if (p.type === 'tool_result') results.set(p.callId, p.content);
  const lines: string[] = [];
  for (const p of t.assistant.parts) {
    if (p.type !== 'tool_call') continue;
    const input = digestInput(p.input);
    const result = results.get(p.id);
    lines.push(`t${t.turn} ${p.name}${input === '' ? '' : ` ${input}`} -> ${result === undefined ? '(no result)' : headline(result)}`);
  }
  if (lines.length === 0) lines.push(`t${t.turn} (no tool call)`);
  return lines;
}

export function jitView(
  first: Message,
  turns: TranscriptTurn[],
  keepRecentTurns: number,
  compactHistory: boolean,
): Message[] {
  if (!compactHistory) {
    const out: Message[] = [first];
    for (const t of turns) {
      out.push(t.assistant);
      if (t.results !== null) out.push(t.results);
    }
    return out;
  }
  const cutoff = Math.max(0, turns.length - Math.max(0, keepRecentTurns));
  const digest = turns.slice(0, cutoff).flatMap(digestTurn);
  const head: Message =
    digest.length === 0 ? first : { role: first.role, parts: [...first.parts, { type: 'text', text: [DIGEST_HEADER, ...digest].join('\n') }] };
  const out: Message[] = [head];
  for (const t of turns.slice(cutoff)) {
    out.push(elideCalls(t.assistant));
    if (t.results !== null) out.push(t.results);
  }
  return out;
}

export function baselineView(first: Message, turns: TranscriptTurn[]): Message[] {
  const out: Message[] = [first];
  for (const t of turns) {
    out.push(t.assistant);
    if (t.results === null) continue;
    out.push({
      role: t.results.role,
      parts: t.results.parts.map((p) => {
        if (p.type !== 'tool_result') return p;
        const raw = t.raw[p.callId];
        return raw === undefined ? p : { ...p, content: raw };
      }),
    });
  }
  return out;
}

function partChars(p: Part): number {
  switch (p.type) {
    case 'text':
      return p.text.length;
    case 'tool_call':
      return p.name.length + (JSON.stringify(p.input) ?? '').length;
    case 'tool_result':
      return p.content.length;
    case 'opaque':
      return (JSON.stringify(p.data) ?? '').length;
  }
}

/** Character footprint of a message list (used for the attribution of savings). */
export function messageChars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) for (const p of m.parts) n += partChars(p);
  return n;
}
