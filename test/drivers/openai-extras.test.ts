/**
 * Per-tool-call provider extras (real-model finding F2): an OpenAI-compatible endpoint (here
 * Gemini's) attaches `extra_content` (a thought signature) to a tool call and rejects the next
 * request with a 400 ("missing thought_signature") unless that field is echoed back on the call.
 * The openai driver keeps such fields as its own OpaquePart next to the call and merges them
 * back on replay. Through the core's compaction (input elision, digest of old turns) no extras
 * outlive their call and no replayed call is left without its result.
 */
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions/completions';
import { z } from 'zod';
import { createOpenAIDriver, fromOpenAIResponse, isToolCallExtras, toOpenAIMessages, type OpenAIClient } from '../../plugins/drivers/openai.ts';
import { jitView, type TranscriptTurn } from '../../src/core/context.ts';
import { runAgent } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { Message, Part, ToolPlugin } from '../../src/core/plugin-api.ts';
import { fakeCtx, fakeStore, firstMessage, specs } from '../core-loop/fakes.ts';

const sig = (id: string): Record<string, unknown> => ({ extra_content: { google: { thought_signature: `sig-${id}` } } });

function toolCall(id: string, name: string, args: unknown, extras?: Record<string, unknown>): ChatCompletionMessageToolCall {
  const base: ChatCompletionMessageToolCall = { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  return extras === undefined ? base : Object.assign(base, extras);
}

function completion(calls: ChatCompletionMessageToolCall[], content: string | null = null): ChatCompletion {
  const message: ChatCompletion.Choice['message'] = { role: 'assistant', content, refusal: null };
  if (calls.length > 0) message.tool_calls = calls;
  return {
    id: 'cmpl',
    object: 'chat.completion',
    created: 0,
    model: 'gemini-3-flash-preview',
    choices: [{ index: 0, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop', logprobs: null, message }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

describe('capture and replay', () => {
  it('captures fields beyond id/type/function as an opaque part next to the call, and nothing for a plain call', () => {
    const r = fromOpenAIResponse(completion([toolCall('c1', 'read_file', { path: 'a' }, sig('c1')), toolCall('c2', 'read_file', { path: 'b' })]));
    expect(r.parts).toEqual([
      { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } },
      { type: 'opaque', driver: 'openai', data: { toolCallExtras: { id: 'c1', extras: sig('c1') } } },
      { type: 'tool_call', id: 'c2', name: 'read_file', input: { path: 'b' } },
    ]);
    expect(isToolCallExtras(r.parts[1]?.type === 'opaque' ? r.parts[1].data : null)).toBe(true);
    expect(isToolCallExtras({ toolCallExtras: { id: 1, extras: {} } })).toBe(false);
    expect(isToolCallExtras({ toolCallExtras: { id: 'x', extras: [] } })).toBe(false);
  });

  it('merges the extras back into their own call; the neutral id/type/function always win', () => {
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } },
          { type: 'opaque', driver: 'openai', data: { toolCallExtras: { id: 'c1', extras: { ...sig('c1'), id: 'forged', function: { name: 'x', arguments: '{}' } } } } },
          { type: 'opaque', driver: 'claude', data: { toolCallExtras: { id: 'c2', extras: sig('foreign') } } },
          { type: 'tool_call', id: 'c2', name: 'read_file', input: { path: 'b' } },
        ],
      },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: 'A', isError: false }, { type: 'tool_result', callId: 'c2', content: 'B', isError: false }] },
    ];
    const wire = toOpenAIMessages('sys', messages);
    const asst = wire.find((m) => m.role === 'assistant');
    expect(asst).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { ...sig('c1'), id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
      ],
    });
    // no opaque content reaches the wire as text
    expect(JSON.stringify(wire)).not.toContain('toolCallExtras');
  });

  it('through jitView compaction: digested calls take their extras with them; every replayed call has its result', () => {
    const turns: TranscriptTurn[] = [1, 2, 3, 4, 5].map((n) => {
      const id = `c${n}`;
      const parts: Part[] = [
        { type: 'tool_call', id, name: 'write_file', input: { path: `src/f${n}.ts`, content: 'x'.repeat(400) } },
        { type: 'opaque', driver: 'openai', data: { toolCallExtras: { id, extras: sig(id) } } },
      ];
      return { turn: n, assistant: { role: 'assistant', parts }, results: { role: 'user', parts: [{ type: 'tool_result', callId: id, content: `wrote src/f${n}.ts`, isError: false }] }, raw: {} };
    });
    const view = jitView(firstMessage(), turns, 2, true);
    const wire = toOpenAIMessages('sys', view);
    const calls = wire.flatMap((m) => (m.role === 'assistant' && m.tool_calls !== undefined ? m.tool_calls : []));
    expect(calls.map((c) => c.id)).toEqual(['c4', 'c5']);
    for (const c of calls) {
      expect(c).toMatchObject(sig(c.id)); // each kept call carries exactly its own extras
      expect(c.type === 'function' ? c.function.arguments : '').toContain('<omitted 400 chars>'); // input elided, extras kept
    }
    const answered = wire.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
    expect(answered).toEqual(['c4', 'c5']);
    expect(JSON.stringify(wire)).not.toMatch(/sig-c[123]/); // no orphan extras of digested calls
  });
});

/**
 * A fake client that behaves like the endpoint: it signs the FIRST tool call of every response
 * (as the real one does for parallel calls) and answers 400 when a later request replays a
 * signed call without its exact extra field, or a call that was never issued, or a call
 * without a tool result.
 */
function signingClient(turns: Array<Array<{ name: string; input: Record<string, unknown> }>>): {
  client: OpenAIClient;
  sent: ChatCompletionCreateParamsNonStreaming[];
  rejections: string[];
} {
  const sent: ChatCompletionCreateParamsNonStreaming[] = [];
  const rejections: string[] = [];
  const issued = new Map<string, string | null>();
  let served = 0;
  const reject = (why: string): Error => {
    rejections.push(why);
    return OpenAI.APIError.generate(400, { error: { message: why, type: 'invalid_request_error', param: null, code: null } }, undefined, new Headers());
  };
  return {
    sent,
    rejections,
    client: {
      chat: {
        completions: {
          async create(body) {
            sent.push(structuredClone(body));
            const pending = new Set<string>();
            for (const m of body.messages) {
              if (m.role === 'tool') pending.delete(m.tool_call_id);
              if (m.role !== 'assistant' || m.tool_calls === undefined) continue;
              if (pending.size > 0) throw reject(`tool calls without a result: ${[...pending].join(',')}`);
              for (const c of m.tool_calls) {
                if (!issued.has(c.id)) throw reject(`unknown tool call id ${c.id}`);
                const want = issued.get(c.id) ?? null;
                const got = JSON.stringify('extra_content' in c ? c.extra_content : null);
                if (want !== null && got !== want) throw reject(`Function call is missing a thought_signature in functionCall parts (${c.id})`);
                pending.add(c.id);
              }
            }
            if (pending.size > 0) throw reject(`tool calls without a result: ${[...pending].join(',')}`);
            served += 1;
            const calls = (turns[served - 1] ?? []).map((c, i) => {
              const id = `call_${served}_${i}`;
              const extras = i === 0 ? sig(id) : undefined;
              issued.set(id, extras === undefined ? null : JSON.stringify(extras['extra_content']));
              return toolCall(id, c.name, c.input, extras);
            });
            return completion(calls, calls.length === 0 ? 'done' : null);
          },
        },
      },
    },
  };
}

describe('round trip through the real loop with a signing endpoint', () => {
  it('negative control: without the extras (the pre-fix driver) the endpoint rejects the second request', async () => {
    const endpoint = signingClient([[{ name: 'read_file', input: { path: 'src/a.ts' } }], []]);
    const driver = createOpenAIDriver({ model: 'gemini-3-flash-preview', options: {}, env: { OPENAI_API_KEY: 'test' }, harnessRoot: '/x' }, () => endpoint.client);
    const r1 = await driver.complete({ system: 'S', messages: [firstMessage()], tools: [], maxOutputTokens: 100 });
    const stripped = r1.parts.filter((p) => p.type !== 'opaque');
    const results: Message = { role: 'user', parts: [{ type: 'tool_result', callId: 'call_1_0', content: 'A', isError: false }] };
    await expect(driver.complete({ system: 'S', messages: [firstMessage(), { role: 'assistant', parts: stripped }, results], tools: [], maxOutputTokens: 100 })).rejects.toThrow(/missing a thought_signature/);
    await expect(driver.complete({ system: 'S', messages: [firstMessage(), { role: 'assistant', parts: r1.parts }, results], tools: [], maxOutputTokens: 100 })).resolves.toMatchObject({ stop: 'end_turn' });
  });

  it('every request is accepted over 6 turns of compaction; each kept call echoes its own signature', async () => {
    const files = new Map([['src/a.ts', 'export const a = 1;'], ['src/b.ts', 'export const b = 2;']]);
    const read: ToolPlugin<{ path: string }> = {
      kind: 'tool',
      name: 'read_file',
      description: 'read',
      input: z.object({ path: z.string() }),
      effect: 'read',
      async run(i) {
        return { ok: true, summary: `${i.path} (lines 1-1 of 1)\n1| ${files.get(i.path) ?? ''}` };
      },
    };
    const write: ToolPlugin<{ path: string; content: string }> = {
      kind: 'tool',
      name: 'write_file',
      description: 'write',
      input: z.object({ path: z.string(), content: z.string() }),
      effect: 'write',
      paths: (i) => [i.path],
      async run(i) {
        files.set(i.path, i.content);
        return { ok: true, summary: `wrote ${i.path}` };
      },
    };
    const tools = [read, write].map((t) => t as ToolPlugin<unknown>);
    const script = [
      [{ name: 'read_file', input: { path: 'src/a.ts' } }, { name: 'read_file', input: { path: 'src/b.ts' } }],
      [{ name: 'write_file', input: { path: 'src/c.ts', content: 'y'.repeat(500) } }],
      [{ name: 'read_file', input: { path: 'src/a.ts' } }],
      [{ name: 'read_file', input: { path: 'src/c.ts' } }, { name: 'write_file', input: { path: 'src/a.ts', content: 'export const a = 3;' } }],
      [{ name: 'read_file', input: { path: 'src/a.ts' } }],
      [{ name: 'read_file', input: { path: 'src/b.ts' } }],
    ];
    const endpoint = signingClient(script);
    const driver = createOpenAIDriver({ model: 'gemini-3-flash-preview', options: {}, env: { OPENAI_API_KEY: 'test' }, harnessRoot: '/x' }, () => endpoint.client);
    const { ctx, logs } = fakeCtx({ tools });
    const r = await runAgent({
      driver,
      ctx,
      store: fakeStore(logs),
      ledger: new TokenLedger({ runId: 'r', task: 't', driver: 'openai', model: 'm', counter: 'local', mode: 'jit' }),
      first: firstMessage(),
      system: 'S',
      baselineSystem: 'S+F',
      tools: specs(tools),
      maxTurns: 8,
      maxOutputTokens: 100,
      retryDelaysMs: [],
    });
    expect(endpoint.rejections).toEqual([]);
    expect(r.status).not.toBe('error');
    expect(endpoint.sent.length).toBeGreaterThanOrEqual(7);
    // the last request replays only the kept turns' calls (keepRecentTurns 2), each with its own signature
    const last = endpoint.sent[6];
    const calls = (last?.messages ?? []).flatMap((m) => (m.role === 'assistant' && m.tool_calls !== undefined ? m.tool_calls : []));
    expect(calls.map((c) => c.id)).toEqual(['call_5_0', 'call_6_0']);
    for (const c of calls) expect(c).toMatchObject(sig(c.id));
  });
});
