/**
 * Driver.stream: the same request as complete(), the reply's text passed on as it arrives, and the
 * same ModelResponse at the end; the same downgrade steps, clamps and error classification apply.
 * Fake SDK clients (and the real SDKs with only `fetch` replaced, serving server-sent events); never live.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { BetaContentBlock, BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Message as PlainMessage, MessageCreateParamsNonStreaming as PlainCreateParams } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions';
import { CLIENT_OPTIONS as CLAUDE_OPTIONS, COMPAT_SUFFIX as CLAUDE_COMPAT, buildClaudeParams, createClaudeDriver, fromClaudeResponse, type ClaudeClient, type ClaudeStream } from '../../plugins/drivers/claude.ts';
import { CLIENT_OPTIONS as OPENAI_OPTIONS, accumulateStream, buildOpenAIParams, createOpenAIDriver, fromOpenAIResponse, streamingCall, type OpenAIClient } from '../../plugins/drivers/openai.ts';
import { createScriptedDriver } from '../../plugins/drivers/scripted.ts';
import { errorKindOf, retryAfterMs } from '../../src/core/loop.ts';
import type { ModelRequest, ModelResponse, ToolSpec } from '../../src/core/plugin-api.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';

const READ: ToolSpec = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const req: ModelRequest = { system: 'be terse', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], tools: [READ], maxOutputTokens: 4000 };

function collect(): { deltas: string[]; on: (d: string) => void } {
  const deltas: string[] = [];
  return { deltas, on: (d) => deltas.push(d) };
}

// ───────────────────────────── Claude ─────────────────────────────

function betaMessage(content: BetaContentBlock[], stop: BetaMessage['stop_reason'] = 'end_turn'): BetaMessage {
  return {
    id: 'msg_1',
    container: null,
    content,
    context_management: null,
    diagnostics: null,
    model: 'claude-opus-5-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: stop,
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 4,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 10,
      iterations: null,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function plainMessage(text: string): PlainMessage {
  return {
    id: 'msg_2',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    diagnostics: null,
    model: 'claude-opus-5-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, input_tokens: 10, output_tokens: 5, output_tokens_details: null, server_tool_use: null, service_tier: null },
  };
}

/** A MessageStream stand-in: emits `deltas` on `text` when finalMessage() is awaited, then resolves (or rejects). */
function fakeStream<M>(deltas: string[], end: M | Error): ClaudeStream<M> {
  let listener: ((d: string, snap: string) => void) | undefined;
  return {
    on(_event, l) {
      listener = l;
      return this;
    },
    async finalMessage() {
      let snap = '';
      for (const d of deltas) {
        snap += d;
        listener?.(d, snap);
      }
      if (end instanceof Error) throw end;
      return end;
    },
  };
}

type Step<M> = { deltas: string[]; end: M | Error };

function claudeClient(beta: Array<Step<BetaMessage>>, plain: Array<Step<PlainMessage>> = []) {
  const sent: { beta: MessageCreateParamsNonStreaming[]; plain: PlainCreateParams[]; signals: Array<AbortSignal | undefined> } = { beta: [], plain: [], signals: [] };
  const client: ClaudeClient = {
    beta: {
      messages: {
        create: async () => {
          throw new Error('complete() must not be used by stream()');
        },
        stream(params, options) {
          sent.beta.push(structuredClone(params));
          sent.signals.push(options?.signal);
          const s = beta.shift();
          if (s === undefined) throw new Error('no fake beta stream left');
          return fakeStream(s.deltas, s.end);
        },
      },
    },
    messages: {
      create: async () => {
        throw new Error('complete() must not be used by stream()');
      },
      stream(params) {
        sent.plain.push(structuredClone(params));
        const s = plain.shift();
        if (s === undefined) throw new Error('no fake plain stream left');
        return fakeStream(s.deltas, s.end);
      },
      countTokens: async () => ({ input_tokens: 1 }),
    },
  };
  return { client, sent };
}

function anthropicError(status: number, message: string): Error {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers());
}

const claudeEnv = { ANTHROPIC_API_KEY: 'test-key' };

describe('claude driver: stream', () => {
  it('passes each text delta on and resolves to what complete() returns for the same message, from the same request', async () => {
    const msg = betaMessage([
      { type: 'text', text: 'Reading the file.', citations: null },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'src/a.ts' }, caller: { type: 'direct' } },
    ], 'tool_use');
    const f = claudeClient([{ deltas: ['Read', 'ing the', ' file.'], end: msg }]);
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => f.client);
    const c = collect();
    const res = await d.stream?.(req, undefined, c.on);
    expect(c.deltas).toEqual(['Read', 'ing the', ' file.']);
    expect(res).toEqual(fromClaudeResponse(msg));
    expect(f.sent.beta[0]).toEqual(buildClaudeParams(req, 'claude-opus-5-5', 'high'));
  });

  it('the abort signal reaches the SDK stream', async () => {
    const f = claudeClient([{ deltas: ['ok'], end: betaMessage([{ type: 'text', text: 'ok', citations: null }]) }]);
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => f.client);
    const ac = new AbortController();
    await d.stream?.(req, ac.signal, () => undefined);
    expect(f.sent.signals[0]).toBe(ac.signal);
  });

  it('steps down a tier on an extras rejection, as complete() does (plain endpoint, compat model)', async () => {
    const f = claudeClient([{ deltas: [], end: anthropicError(400, 'thinking.adaptive is not supported on this model') }], [{ deltas: ['Hi'], end: plainMessage('Hi') }]);
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => f.client);
    const c = collect();
    const res = await d.stream?.(req, undefined, c.on);
    expect(res?.parts).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(c.deltas).toEqual(['Hi']);
    expect(f.sent.plain).toHaveLength(1);
    expect(d.model).toBe(`claude-opus-5-5${CLAUDE_COMPAT}`);
  });

  it('clamps max_tokens to the ceiling a 400 names, as complete() does', async () => {
    const ok = betaMessage([{ type: 'text', text: 'ok', citations: null }]);
    const f = claudeClient([{ deltas: [], end: anthropicError(400, 'max_tokens: 4000 > 2048, which is the maximum allowed number of output tokens for claude-opus-5-5') }, { deltas: ['ok'], end: ok }]);
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => f.client);
    await d.stream?.(req, undefined, () => undefined);
    expect(f.sent.beta.map((p) => p.max_tokens)).toEqual([4000, 2048]);
  });

  it('a context overflow or a rate limit thrown by the stream reads exactly as one thrown by complete()', async () => {
    const overflow = anthropicError(400, 'prompt is too long: 210000 tokens > 200000 maximum');
    const f = claudeClient([{ deltas: [], end: overflow }]);
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => f.client);
    const thrown = await d.stream?.(req, undefined, () => undefined).then(() => null, (e: unknown) => e);
    expect(thrown).toBe(overflow);
    expect(errorKindOf(d, thrown)).toBe('context_overflow');
    expect(f.sent.beta).toHaveLength(1); // never resent unchanged: the loop shrinks it

    const limited = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers({ 'retry-after': '7' }));
    const g = claudeClient([{ deltas: [], end: limited }]);
    const d2 = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => g.client);
    const e2 = await d2.stream?.(req, undefined, () => undefined).then(() => null, (e: unknown) => e);
    expect(retryAfterMs(d2, e2)).toBe(7000);
  });

  it('a client seam without stream(): completes and passes the whole text once', async () => {
    const msg = betaMessage([{ type: 'text', text: 'All of it.', citations: null }]);
    const client: ClaudeClient = {
      beta: { messages: { create: async () => msg } },
      messages: { create: async () => plainMessage('x'), countTokens: async () => ({ input_tokens: 1 }) },
    };
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, () => client);
    const c = collect();
    expect(await d.stream?.(req, undefined, c.on)).toEqual(fromClaudeResponse(msg));
    expect(c.deltas).toEqual(['All of it.']);
  });

  it('through the real SDK (only fetch replaced): server-sent events become deltas and the same response', async () => {
    const events: Array<[string, unknown]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_9', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: 3 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Look' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_9', name: 'read_file', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"src/a.ts"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      const sse = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const d = createClaudeDriver({ options: {}, env: claudeEnv, harnessRoot: '/x' }, (apiKey) => new Anthropic({ apiKey, ...CLAUDE_OPTIONS, fetch }));
    const c = collect();
    const res = await d.stream?.(req, undefined, c.on);
    expect(c.deltas).toEqual(['Look', 'ing.']);
    expect(res).toEqual({
      parts: [{ type: 'text', text: 'Looking.' }, { type: 'tool_call', id: 'tu_9', name: 'read_file', input: { path: 'src/a.ts' } }],
      stop: 'tool_calls',
      usage: { inputTokens: 15, outputTokens: 9, cachedInputTokens: 3 },
      model: 'claude-opus-5-5',
    });
    expect(bodies[0]).toMatchObject({ stream: true, model: 'claude-opus-5-5', max_tokens: 4000 });
  });
});

// ───────────────────────────── OpenAI ─────────────────────────────

function chunk(delta: ChatCompletionChunk.Choice['delta'], finish: ChatCompletionChunk.Choice['finish_reason'] = null): ChatCompletionChunk {
  return { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.6-luna', choices: [{ index: 0, delta, finish_reason: finish }] };
}
const USAGE: NonNullable<ChatCompletionChunk['usage']> = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_tokens_details: { cached_tokens: 64 } };
const usageChunk: ChatCompletionChunk = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.6-luna', choices: [], usage: USAGE };

async function* iterate(chunks: Array<ChatCompletionChunk | Error>): AsyncGenerator<ChatCompletionChunk> {
  for (const c of chunks) {
    if (c instanceof Error) throw c;
    yield c;
  }
}

function openAIClient(streams: Array<Array<ChatCompletionChunk | Error> | Error>) {
  const sent: ChatCompletionCreateParamsStreaming[] = [];
  const client: OpenAIClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('complete() must not be used by stream()');
        },
        async createStreaming(body) {
          sent.push(structuredClone(body));
          const s = streams.shift();
          if (s === undefined) throw new Error('no fake stream left');
          if (s instanceof Error) throw s;
          return iterate(s);
        },
      },
    },
  };
  return { client, sent };
}

function openAIError(status: number, message: string, code: string | null = null): Error {
  return OpenAI.APIError.generate(status, { error: { message, type: 'invalid_request_error', param: null, code } }, undefined, new Headers());
}

const openaiEnv = { OPENAI_API_KEY: 'test-key' };

/** The ChatCompletion the chunks below stand for (what a non-streaming call would have returned). */
const WHOLE: ChatCompletion = {
  id: 'c1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-5.6-luna',
  choices: [{
    index: 0,
    finish_reason: 'tool_calls',
    logprobs: null,
    message: {
      role: 'assistant',
      content: 'Reading it.',
      refusal: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
        // a gateway's extra field on the call (carried back verbatim, as complete() does)
        Object.assign({ id: 'call_b', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"src/b.ts"}' } }, { extra_content: { google: { thought_signature: 'sig' } } }),
      ],
    },
  }],
  usage: USAGE,
};

const CHUNKS: ChatCompletionChunk[] = [
  chunk({ role: 'assistant', content: 'Read' }),
  chunk({ content: 'ing it.' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"src/a.ts"}' } }] }),
  chunk({ tool_calls: [Object.assign({ index: 1, id: 'call_b', type: 'function' as const, function: { name: 'read_file', arguments: '' } }, { extra_content: { google: { thought_signature: 'sig' } } })] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"src/b.ts"}' } }] }),
  chunk({}, 'tool_calls'),
  usageChunk,
];

describe('openai driver: stream', () => {
  it('asks for usage, passes each content delta on, and resolves to what complete() returns for the whole reply', async () => {
    const f = openAIClient([CHUNKS]);
    const d = createOpenAIDriver({ options: {}, env: openaiEnv, model: 'gpt-5.6-luna', harnessRoot: '/x' }, () => f.client);
    const c = collect();
    const res = await d.stream?.(req, undefined, c.on);
    expect(c.deltas).toEqual(['Read', 'ing it.']);
    expect(res).toEqual(fromOpenAIResponse(WHOLE));
    expect(res?.parts.filter((p) => p.type === 'opaque')).toEqual([{ type: 'opaque', driver: 'openai', data: { toolCallExtras: { id: 'call_b', extras: { extra_content: { google: { thought_signature: 'sig' } } } } } }]);
    expect(f.sent[0]).toEqual({ ...buildOpenAIParams(req, 'gpt-5.6-luna'), stream: true, stream_options: { include_usage: true } });
  });

  it('a stream without its usage chunk is an error, never a reply whose spend went uncounted', async () => {
    await expect(accumulateStream(iterate(CHUNKS.slice(0, -1)), () => undefined)).rejects.toThrow(/without its usage chunk/);
  });

  it('a stream that ends before a finish reason is an error (an interrupted reply is never used)', async () => {
    await expect(accumulateStream(iterate([chunk({ content: 'half' }), usageChunk]), () => undefined)).rejects.toThrow(/before the reply finished/);
    await expect(accumulateStream(iterate([]), () => undefined)).rejects.toThrow(/before the reply finished/);
  });

  it('a gateway that omits finish_reason (no key at all) has not finished either; the same stream with one has (the twin)', async () => {
    const omitted = (c: ChatCompletionChunk): ChatCompletionChunk => ({ ...c, choices: c.choices.map(({ finish_reason: _f, ...rest }) => rest as ChatCompletionChunk.Choice) });
    const half = [omitted(chunk({ content: 'half' })), omitted(chunk({ content: ' a reply' })), usageChunk];
    await expect(accumulateStream(iterate(half), () => undefined)).rejects.toThrow(/before the reply finished/);
    const whole = await accumulateStream(iterate([...half.slice(0, 2), chunk({}, 'stop'), usageChunk]), () => undefined);
    expect(fromOpenAIResponse(whole)).toMatchObject({ stop: 'end_turn', parts: [{ type: 'text', text: 'half a reply' }] });
  });

  it('a refusal streams in as a refusal, as complete() reads it', async () => {
    const res = fromOpenAIResponse(await accumulateStream(iterate([chunk({ refusal: "I can't" }), chunk({ refusal: ' help.' }, 'stop'), usageChunk]), () => undefined));
    expect(res.stop).toBe('refusal');
  });

  it('applies the same 400 adjustment as complete() (max_completion_tokens -> max_tokens) and resends', async () => {
    const f = openAIClient([openAIError(400, "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead."), CHUNKS]);
    const d = createOpenAIDriver({ options: {}, env: openaiEnv, model: 'gpt-5.6-luna', harnessRoot: '/x' }, () => f.client);
    await d.stream?.(req, undefined, () => undefined);
    expect(f.sent[0]?.max_completion_tokens).toBe(4000);
    expect(f.sent[1]?.max_tokens).toBe(4000);
    expect(f.sent[1]?.max_completion_tokens).toBeUndefined();
    expect(d.model).toBe('gpt-5.6-luna (compat)');
  });

  it('a context overflow thrown by the stream reads as one thrown by complete() and is not resent', async () => {
    const overflow = openAIError(400, "This model's maximum context length is 8192 tokens.", 'context_length_exceeded');
    const f = openAIClient([overflow]);
    const d = createOpenAIDriver({ options: {}, env: openaiEnv, model: 'gpt-5.6-luna', harnessRoot: '/x' }, () => f.client);
    const thrown = await d.stream?.(req, undefined, () => undefined).then(() => null, (e: unknown) => e);
    expect(errorKindOf(d, thrown)).toBe('context_overflow');
    expect(f.sent).toHaveLength(1);
  });

  it('a client seam that cannot stream: complete(), then the whole text once', async () => {
    const client: OpenAIClient = { chat: { completions: { create: async () => ({ ...WHOLE, choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'Hello.', refusal: null } }] }) } } };
    expect(streamingCall(client)).toBeUndefined();
    const d = createOpenAIDriver({ options: {}, env: openaiEnv, model: 'gpt-5.6-luna', harnessRoot: '/x' }, () => client);
    const c = collect();
    expect((await d.stream?.(req, undefined, c.on))?.parts).toEqual([{ type: 'text', text: 'Hello.' }]);
    expect(c.deltas).toEqual(['Hello.']);
  });

  it('through the real SDK (only fetch replaced): the create overload streams server-sent events', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      const sse = `${CHUNKS.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const d = createOpenAIDriver({ options: {}, env: openaiEnv, model: 'gpt-5.6-luna', harnessRoot: '/x' }, (apiKey) => new OpenAI({ apiKey, ...OPENAI_OPTIONS, fetch }));
    const c = collect();
    const res = await d.stream?.(req, undefined, c.on);
    expect(c.deltas).toEqual(['Read', 'ing it.']);
    expect(res).toEqual(fromOpenAIResponse(WHOLE));
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: 'gpt-5.6-luna' });
  });
});

// ───────────────────────────── scripted ─────────────────────────────

describe('scripted driver: stream', () => {
  it("replays the same turn and delivers its text in one chunk", async () => {
    const opts = { options: { script: 'fixtures/scripted/users-api.json' }, env: {}, harnessRoot: HARNESS_ROOT };
    const a = createScriptedDriver(opts);
    const b = createScriptedDriver(opts);
    const c = collect();
    const streamed: ModelResponse | undefined = await a.stream?.(req, undefined, c.on);
    const completed = await b.complete(req);
    expect(streamed).toEqual(completed);
    const text = completed.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    expect(c.deltas).toEqual(text.length > 0 ? [text] : []);
  });
});
