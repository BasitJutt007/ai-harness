/**
 * The compacted view must stay a valid request for every driver, with no repair needed:
 *  - every tool_call is answered by its tool_result in the very next message (same order);
 *  - nothing is empty (no empty message, text or tool result);
 *  - the prefix is monotonic: a digested turn's lines never change afterwards;
 *  - opaque parts of digested turns are dropped with their turn (kept in the recent window).
 *
 * The views are fed through every request builder the driver plugins export
 * (`build*Params`, discovered from plugins/drivers so no provider is named here) and the wire
 * structures are checked in both shapes the builders produce: content blocks
 * (tool_use / tool_result) and chat messages (assistant tool_calls + role "tool").
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeTranscript } from '../../plugins/drivers/_wire.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { DIGEST_HEADER, jitView, type TranscriptTurn } from '../../src/core/context.ts';
import type { Message, ModelRequest, Part, ToolSpec } from '../../src/core/types.ts';
import { simulate } from '../token-efficiency/simulate.ts';

type Builder = (req: ModelRequest, model: string) => unknown;
interface NamedBuilder {
  name: string;
  build: Builder;
}

function isBuilder(v: unknown): v is Builder {
  return typeof v === 'function';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function discoverBuilders(): Promise<NamedBuilder[]> {
  const dir = join(HARNESS_ROOT, 'plugins', 'drivers');
  const out: NamedBuilder[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.startsWith('_')).sort()) {
    const mod: unknown = await import(pathToFileURL(join(dir, f)).href);
    if (!isRecord(mod)) continue;
    for (const [name, v] of Object.entries(mod)) {
      if (/^build\w*Params$/.test(name) && isBuilder(v)) out.push({ name: `${f}:${name}`, build: v });
    }
  }
  return out;
}

// ───────────────────────────── wire validators ─────────────────────────────

interface WireStats {
  shape: 'blocks' | 'chat';
  calls: number;
  results: string[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Content-block shape: alternating user/assistant, tool_use answered first in the next user message. */
function checkBlocks(messages: unknown[]): WireStats {
  const results: string[] = [];
  let calls = 0;
  messages.forEach((m, i) => {
    if (!isRecord(m)) throw new Error(`message ${i} is not an object`);
    expect(m['role']).toBe(i % 2 === 0 ? 'user' : 'assistant');
    const content = m['content'];
    if (!Array.isArray(content)) throw new Error(`message ${i} content is not an array`);
    expect(content.length, `message ${i} is empty`).toBeGreaterThan(0);
    for (const b of content) {
      if (!isRecord(b)) throw new Error(`message ${i} has a non-object block`);
      if (b['type'] === 'text') expect(str(b['text']).trim().length, `empty text in message ${i}`).toBeGreaterThan(0);
      if (b['type'] === 'tool_result') {
        expect(m['role']).toBe('user');
        expect(str(b['content']).length, `empty tool_result in message ${i}`).toBeGreaterThan(0);
        results.push(str(b['content']));
      }
      if (b['type'] === 'tool_use') expect(m['role']).toBe('assistant');
    }
    const prev = messages[i - 1];
    const useIds = isRecord(prev) && Array.isArray(prev['content'])
      ? prev['content'].flatMap((b) => (isRecord(b) && b['type'] === 'tool_use' ? [str(b['id'])] : []))
      : [];
    const resultIds = content.flatMap((b) => (isRecord(b) && b['type'] === 'tool_result' ? [str(b['tool_use_id'])] : []));
    // results answer exactly the previous message's calls, in order, and come first
    expect(resultIds, `results in message ${i}`).toEqual(useIds);
    const leading = content.slice(0, useIds.length).map((b) => (isRecord(b) ? b['type'] : undefined));
    expect(leading.every((t) => t === 'tool_result')).toBe(true);
    calls += content.filter((b) => isRecord(b) && b['type'] === 'tool_use').length;
  });
  expect(messages.length % 2, 'ends with a user message').toBe(1);
  return { shape: 'blocks', calls, results };
}

/** Chat shape: each assistant tool_calls message is followed by one role:"tool" message per call, in order. */
function checkChat(messages: unknown[]): WireStats {
  const results: string[] = [];
  let calls = 0;
  let pending: string[] = [];
  messages.forEach((m, i) => {
    if (!isRecord(m)) throw new Error(`message ${i} is not an object`);
    const role = m['role'];
    if (role === 'tool') {
      expect(pending.length, `tool message ${i} answers no pending call`).toBeGreaterThan(0);
      expect(m['tool_call_id']).toBe(pending[0]);
      pending = pending.slice(1);
      expect(str(m['content']).length, `empty tool message ${i}`).toBeGreaterThan(0);
      results.push(str(m['content']));
      return;
    }
    expect(pending, `calls left unanswered before message ${i}`).toEqual([]);
    if (role === 'system' || role === 'developer') {
      expect(i).toBe(0);
      expect(str(m['content']).length).toBeGreaterThan(0);
      return;
    }
    const tc = m['tool_calls'];
    if (role === 'assistant' && Array.isArray(tc) && tc.length > 0) {
      pending = tc.map((c) => (isRecord(c) ? str(c['id']) : ''));
      calls += pending.length;
      for (const c of tc) {
        const fn = isRecord(c) ? c['function'] : undefined;
        expect(isRecord(fn) && str(fn['name']).length > 0).toBe(true);
        expect(() => JSON.parse(isRecord(fn) ? str(fn['arguments']) : '')).not.toThrow();
      }
      return;
    }
    expect(['user', 'assistant']).toContain(role);
    expect(str(m['content']).trim().length, `empty ${String(role)} message ${i}`).toBeGreaterThan(0);
  });
  expect(pending).toEqual([]);
  return { shape: 'chat', calls, results };
}

function checkWire(params: unknown): WireStats {
  if (!isRecord(params) || !Array.isArray(params['messages'])) throw new Error('builder returned no messages array');
  const messages: unknown[] = params['messages'];
  const chat = messages.some((m) => isRecord(m) && (m['role'] === 'system' || m['role'] === 'tool' || m['role'] === 'developer' || 'tool_calls' in m));
  return chat ? checkChat(messages) : checkBlocks(messages);
}

// ───────────────────────────── neutral invariants ─────────────────────────────

function toolCalls(view: Message[]): string[] {
  return view.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : [])));
}

function toolResults(view: Message[]): string[] {
  return view.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_result' ? [p.content] : [])));
}

/** The neutral view already satisfies every invariant (normalization changes nothing). */
function checkNeutral(view: Message[]): void {
  expect(view[0]?.role).toBe('user');
  expect(view[view.length - 1]?.role).toBe('user');
  view.forEach((m, i) => {
    expect(m.parts.length, `message ${i} is empty`).toBeGreaterThan(0);
    if (i > 0) expect(m.role).not.toBe(view[i - 1]?.role);
    for (const p of m.parts) {
      if (p.type === 'text') expect(p.text.trim().length).toBeGreaterThan(0);
      if (p.type === 'tool_result') expect(p.content.length).toBeGreaterThan(0);
    }
    const calls = m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : []));
    if (calls.length === 0) return;
    const next = view[i + 1]?.parts ?? [];
    expect(next.slice(0, calls.length).map((p) => (p.type === 'tool_result' ? p.callId : `not a result: ${p.type}`))).toEqual(calls);
  });
  expect(normalizeTranscript(view)).toEqual(view);
}

// ───────────────────────────── transcripts ─────────────────────────────

const first: Message = { role: 'user', parts: [{ type: 'text', text: 'Task t (greenfield): brief' }] };
const tools: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'run_tests', description: 'Run tests.', inputSchema: { type: 'object', properties: {} } },
];

/** Varied turns: several calls per turn, opaque reasoning parts, error results, a nudge-only turn. */
function syntheticTurns(n: number): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (let t = 1; t <= n; t += 1) {
    if (t % 5 === 0) {
      out.push({
        turn: t,
        assistant: { role: 'assistant', parts: [{ type: 'text', text: `prose only ${t}` }] },
        results: { role: 'user', parts: [{ type: 'text', text: 'Use a tool or call finish.' }] },
        raw: {},
      });
      continue;
    }
    const calls: Part[] = [
      { type: 'opaque', driver: 'some-driver', data: { type: 'reasoning', turn: t } },
      { type: 'text', text: `step ${t}` },
      { type: 'tool_call', id: `a${t}`, name: 'write_file', input: { path: `src/f${t}.ts`, content: `export const v${t} = 1;\n`.repeat(40) } },
    ];
    if (t % 2 === 0) calls.push({ type: 'tool_call', id: `b${t}`, name: 'run_tests', input: {} });
    const results: Part[] = [{ type: 'tool_result', callId: `a${t}`, content: `wrote src/f${t}.ts (new, 40 lines)`, isError: false }];
    if (t % 2 === 0) results.push({ type: 'tool_result', callId: `b${t}`, content: `tests: 1 failed, 2 passed (3)\nFAIL test/a.test.ts > case ${t}`, isError: t % 4 === 0 });
    out.push({ turn: t, assistant: { role: 'assistant', parts: calls }, results: { role: 'user', parts: results }, raw: {} });
  }
  return out;
}

let builders: NamedBuilder[] = [];
beforeAll(async () => {
  builders = await discoverBuilders();
});

function throughBuilders(view: Message[], reqTools: ToolSpec[], system = 'system prompt'): void {
  const req: ModelRequest = { system, messages: view, tools: reqTools, maxOutputTokens: 1000 };
  const wantCalls = toolCalls(view).length;
  const wantResults = toolResults(view);
  for (const b of builders) {
    const stats = checkWire(b.build(req, 'test-model'));
    expect(stats.calls, b.name).toBe(wantCalls);
    // every result is the view's own (nothing synthesized, nothing dropped)
    expect(stats.results, b.name).toEqual(wantResults);
  }
}

describe('jitView output is a valid request for every driver', () => {
  it('discovers the request builders of the driver plugins, in both wire shapes', () => {
    const turns = syntheticTurns(4);
    const view = jitView(first, turns, 2, true);
    const shapes = new Set(builders.map((b) => checkWire(b.build({ system: 's', messages: view, tools, maxOutputTokens: 100 }, 'm')).shape));
    expect(builders.length).toBeGreaterThanOrEqual(2);
    expect([...shapes].sort()).toEqual(['blocks', 'chat']);
  });

  it('holds for every prefix of a varied transcript, keepRecentTurns 0..3, compacted or not', () => {
    const all = syntheticTurns(12);
    for (const keep of [0, 1, 2, 3]) {
      for (const compact of [true, false]) {
        for (let k = 0; k <= all.length; k += 1) {
          const view = jitView(first, all.slice(0, k), keep, compact);
          checkNeutral(view);
          throughBuilders(view, tools);
        }
      }
    }
  });

  it('drops opaque parts with their digested turn and keeps them in the recent window', () => {
    const all = syntheticTurns(9);
    for (const keep of [1, 2]) {
      const view = jitView(first, all, keep, true);
      const opaque = view.flatMap((m) => m.parts.filter((p) => p.type === 'opaque'));
      const recent = all.slice(-keep).flatMap((t) => t.assistant.parts.filter((p) => p.type === 'opaque'));
      expect(opaque).toEqual(recent);
      // the head is the brief plus the digest: no opaque, no tool parts
      expect(view[0]?.parts.every((p) => p.type === 'text')).toBe(true);
    }
  });

  it('has a monotonic prefix: digest lines of older turns never change as the run grows', () => {
    const all = syntheticTurns(12);
    for (const keep of [1, 2]) {
      let prevDigest: string[] = [];
      for (let k = 1; k <= all.length; k += 1) {
        const head = jitView(first, all.slice(0, k), keep, true)[0];
        const digestPart = head?.parts[1];
        const lines = digestPart !== undefined && digestPart.type === 'text' ? digestPart.text.split('\n') : [];
        if (lines.length > 0) expect(lines[0]).toBe(DIGEST_HEADER);
        expect(lines.slice(0, prevDigest.length)).toEqual(prevDigest);
        expect(head?.parts[0]).toEqual(first.parts[0]);
        prevDigest = lines;
      }
      // every earlier tool call is named in the digest by turn and tool
      for (const t of all.slice(0, -keep)) {
        for (const p of t.assistant.parts) if (p.type === 'tool_call') expect(prevDigest.some((l) => l.startsWith(`t${t.turn} ${p.name}`))).toBe(true);
      }
    }
  });

  it('holds for every request the real loop sent in the 40-turn simulation (keepRecentTurns 1 and 2)', async () => {
    for (const keep of [1, 2]) {
      const sim = await simulate({ keepRecentTurns: keep });
      expect(sim.requests).toHaveLength(40);
      for (const req of sim.requests) {
        checkNeutral(req.messages);
        throughBuilders(req.messages, req.tools, req.system);
      }
    }
  }, 120_000);
});
