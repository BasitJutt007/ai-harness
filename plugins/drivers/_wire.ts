/**
 * Wire helpers shared by the model drivers. Not a plugin (the leading underscore keeps the
 * registry from loading it); provider-neutral on purpose.
 *
 *  - normalizeTranscript: one canonical, always-valid shape of the neutral transcript
 *    (alternating roles, every tool call answered right after it, no empty content).
 *  - toolSchema: a tool's JSON Schema in the conservative shape every function-calling
 *    API accepts (root type "object" with properties, no root combinators, no "$schema").
 *  - errorInfo: status / message / param / code of a thrown SDK error, duck-typed.
 */
import type { JsonSchema, Message, Part, ToolCallPart, ToolResultPart } from '../../src/core/plugin-api.ts';

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ───────────────────────────── transcript ─────────────────────────────

/** Content of a synthesized result for a tool call the transcript never answered. */
export const MISSING_RESULT = 'error: no result was recorded for this tool call';
/** Content sent instead of an empty tool result. */
export const EMPTY_RESULT = '(no output)';
/** Opening user text when a transcript would otherwise start with the assistant. */
export const START_TEXT = '(conversation start)';
/** Closing user text when a transcript would otherwise end with the assistant. */
export const CONTINUE_TEXT = 'Continue.';

function allowed(role: Message['role'], p: Part): boolean {
  switch (p.type) {
    case 'text':
      return p.text.trim().length > 0;
    case 'tool_call':
    case 'opaque':
      return role === 'assistant';
    case 'tool_result':
      return role === 'user';
  }
}

function withContent(r: ToolResultPart): ToolResultPart {
  return r.content.length > 0 ? r : { ...r, content: EMPTY_RESULT };
}

/**
 * Canonical transcript for any request:
 *  1. parts filtered by `keep`, empty/whitespace text and misplaced parts dropped, empty messages dropped;
 *  2. consecutive same-role messages merged;
 *  3. every assistant message with tool calls is followed by ONE user message whose first parts
 *     are the results for exactly those calls, in call order (a missing result is synthesized
 *     as an error, a duplicate or foreign one is not sent as a result);
 *  4. a tool result that answers no immediately preceding call becomes plain text;
 *  5. the transcript starts and ends with a user message.
 */
export function normalizeTranscript(messages: Message[], keep: (p: Part) => boolean = () => true): Message[] {
  const merged: Message[] = [];
  for (const m of messages) {
    const parts = m.parts.filter((p) => keep(p) && allowed(m.role, p));
    if (parts.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === m.role) last.parts.push(...parts);
    else merged.push({ role: m.role, parts: [...parts] });
  }

  const out: Message[] = [];
  for (let i = 0; i < merged.length; i += 1) {
    const m = merged[i];
    if (m === undefined) continue;
    if (m.role === 'user') {
      out.push({ role: 'user', parts: m.parts.map(orphanToText) });
      continue;
    }
    out.push(m);
    const calls = m.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
    if (calls.length === 0) continue;
    const next = merged[i + 1];
    const following = next !== undefined && next.role === 'user' ? next.parts : [];
    if (following.length > 0) i += 1;
    const results = new Map<string, ToolResultPart>();
    const rest: Part[] = [];
    const ids = new Set(calls.map((c) => c.id));
    for (const p of following) {
      if (p.type === 'tool_result' && ids.has(p.callId) && !results.has(p.callId)) results.set(p.callId, withContent(p));
      else rest.push(orphanToText(p));
    }
    const answered = new Set<string>();
    const ordered: ToolResultPart[] = [];
    for (const c of calls) {
      if (answered.has(c.id)) continue;
      answered.add(c.id);
      ordered.push(results.get(c.id) ?? { type: 'tool_result', callId: c.id, content: MISSING_RESULT, isError: true });
    }
    out.push({ role: 'user', parts: [...ordered, ...rest] });
  }

  const first = out[0];
  if (first !== undefined && first.role === 'assistant') out.unshift({ role: 'user', parts: [{ type: 'text', text: START_TEXT }] });
  const last = out[out.length - 1];
  if (last !== undefined && last.role === 'assistant') out.push({ role: 'user', parts: [{ type: 'text', text: CONTINUE_TEXT }] });
  return out;
}

function orphanToText(p: Part): Part {
  if (p.type !== 'tool_result') return p;
  return { type: 'text', text: `[result of tool call ${p.callId}${p.isError ? ' (error)' : ''}]\n${p.content.length > 0 ? p.content : EMPTY_RESULT}` };
}

// ───────────────────────────── tool schemas ─────────────────────────────

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  [k: string]: unknown;
}

/** Keywords kept by the loose schema form (used after a provider rejected a full schema). */
const LOOSE_KEYS = new Set(['type', 'properties', 'items', 'required', 'description', 'enum', 'anyOf', 'additionalProperties', '$defs', '$ref', 'default']);

function loosen(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(loosen);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'properties' || k === '$defs') {
      // keys here are property names, not keywords
      if (isRecord(x)) out[k] = Object.fromEntries(Object.entries(x).map(([n, s]) => [n, loosen(s)]));
    } else if (k === 'oneOf' && !('anyOf' in v)) {
      out['anyOf'] = loosen(x);
    } else if (LOOSE_KEYS.has(k)) {
      out[k] = loosen(x);
    }
  }
  return out;
}

/**
 * Merge root-level combinator branches into one object: properties are united; required is
 * the intersection across anyOf/oneOf branches (any one may apply) and the union across
 * allOf branches (all apply).
 */
function flattenRootCombinators(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const alternatives: unknown[] = [];
  const conjuncts: unknown[] = [];
  for (const [k, v] of Object.entries(s)) {
    if ((k === 'anyOf' || k === 'oneOf') && Array.isArray(v)) alternatives.push(...v);
    else if (k === 'allOf' && Array.isArray(v)) conjuncts.push(...v);
    else out[k] = v;
  }
  if (alternatives.length === 0 && conjuncts.length === 0) return out;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : []);
  const props: Record<string, unknown> = isRecord(out['properties']) ? { ...out['properties'] } : {};
  const required = new Set(strings(out['required']));
  const absorb = (b: unknown): void => {
    if (isRecord(b) && isRecord(b['properties'])) for (const [n, p] of Object.entries(b['properties'])) if (!(n in props)) props[n] = p;
  };
  for (const b of conjuncts) {
    absorb(b);
    if (isRecord(b)) for (const r of strings(b['required'])) required.add(r);
  }
  let common: string[] | undefined;
  for (const b of alternatives) {
    absorb(b);
    const req = isRecord(b) ? strings(b['required']) : [];
    common = common === undefined ? req : common.filter((r) => req.includes(r));
  }
  for (const r of common ?? []) required.add(r);
  out['properties'] = props;
  if (required.size > 0) out['required'] = [...required];
  else delete out['required'];
  return out;
}

/**
 * A tool's input schema in the shape function-calling APIs accept at the root:
 * `type: "object"` with a `properties` object, no `$schema`, no root anyOf/oneOf/allOf
 * (their branches are merged; the core validates the real input with zod anyway).
 * `loose` additionally keeps only widely supported keywords.
 */
export function toolSchema(schema: JsonSchema, loose = false): ObjectSchema {
  let s: Record<string, unknown> = { ...schema };
  delete s['$schema'];
  s = flattenRootCombinators(s);
  if (loose) {
    const l = loosen(s);
    s = isRecord(l) ? l : {};
  }
  const properties = isRecord(s['properties']) ? s['properties'] : {};
  return { ...s, type: 'object', properties };
}

// ───────────────────────────── errors ─────────────────────────────

export interface ErrorInfo {
  status: number | undefined;
  /** Message plus the JSON error body, for keyword matching. */
  text: string;
  param: string | undefined;
  code: string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Duck-typed view of an SDK API error (works for real SDK errors and plain test doubles). */
export function errorInfo(e: unknown): ErrorInfo {
  if (!isRecord(e) && !(e instanceof Error)) return { status: undefined, text: String(e), param: undefined, code: undefined };
  const rec: Record<string, unknown> = isRecord(e) ? e : {};
  const status = typeof rec['status'] === 'number' ? rec['status'] : undefined;
  const message = e instanceof Error ? e.message : (str(rec['message']) ?? '');
  let body = '';
  try {
    body = rec['error'] === undefined ? '' : (JSON.stringify(rec['error']) ?? '');
  } catch {
    body = '';
  }
  const errBody = isRecord(rec['error']) ? rec['error'] : {};
  const param = str(rec['param']) ?? str(errBody['param']);
  const code = str(rec['code']) ?? str(errBody['code']);
  return { status, text: `${message}\n${body}${param !== undefined ? `\nparam: ${param}` : ''}`, param, code };
}

/** Largest output-token value a "too many output tokens" rejection names, if any. */
export function outputTokenCeiling(text: string): number | undefined {
  const patterns = [/max_(?:completion_)?tokens[^0-9]{0,40}\d+\s*>\s*(\d+)/i, /at most (\d+) (?:output|completion) tokens/i];
  if (!/max_(?:completion_)?tokens|output tokens|completion tokens/i.test(text)) return undefined;
  for (const re of patterns) {
    const m = re.exec(text);
    const n = m?.[1] === undefined ? NaN : Number(m[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}
