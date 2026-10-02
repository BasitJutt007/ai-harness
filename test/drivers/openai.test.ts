import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions/completions';
import type { ChatModel } from 'openai/resources/shared';
import plugin, {
  COMPAT_SUFFIX,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  STANDARD_SHAPE,
  adjustShape,
  countChatPayload,
  createOpenAIDriver,
  fromOpenAIResponse,
  isModelUnavailable,
  mapOpenAIStop,
  parseArguments,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIClient,
} from '../../plugins/drivers/openai.ts';
import { MISSING_RESULT } from '../../plugins/drivers/_wire.ts';
import type { Message, ModelRequest, ToolSpec } from '../../src/core/plugin-api.ts';

type Finish = ChatCompletion.Choice['finish_reason'];

function completion(
  content: string | null,
  toolCalls: ChatCompletionMessageToolCall[] | undefined,
  finish: Finish,
  usage: ChatCompletion['usage'] | null = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_tokens_details: { cached_tokens: 128 } },
): ChatCompletion {
  const message: ChatCompletion.Choice['message'] = { role: 'assistant', content, refusal: null };
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  const c: ChatCompletion = { id: 'cmpl_1', object: 'chat.completion', created: 0, model: 'gpt-6-astra-2026', choices: [{ index: 0, finish_reason: finish, logprobs: null, message }] };
  if (usage !== null && usage !== undefined) c.usage = usage;
  return c;
}

function call(id: string, name: string, args: unknown): ChatCompletionMessageToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function fakeClient(responses: Array<ChatCompletion | Error>): { client: OpenAIClient; sent: ChatCompletionCreateParamsNonStreaming[] } {
  const sent: ChatCompletionCreateParamsNonStreaming[] = [];
  return {
    sent,
    client: {
      chat: {
        completions: {
          async create(body) {
            sent.push(structuredClone(body));
            const r = responses.shift();
            if (r === undefined) throw new Error('no fake response left');
            if (r instanceof Error) throw r;
            return r;
          },
        },
      },
    },
  };
}

function apiError(status: number, message: string, param: string | null = null, code: string | null = null): Error {
  return OpenAI.APIError.generate(status, { error: { message, type: 'invalid_request_error', param, code } }, undefined, new Headers());
}

const env = { OPENAI_API_KEY: 'test-key' };
const READ: ToolSpec = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };

const request: ModelRequest = {
  system: 'be terse',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'task brief' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'opaque', driver: 'claude', data: { type: 'thinking', thinking: 'x', signature: 'y' } },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_call', id: 'call_a', name: 'read_file', input: { path: 'src/app.ts' } },
        { type: 'tool_call', id: 'call_b', name: 'outline', input: { path: 'src/x.ts' } },
      ],
    },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'hook note' },
        { type: 'tool_result', callId: 'call_a', content: '1: export {}', isError: false },
        { type: 'tool_result', callId: 'call_b', content: 'no such file', isError: true },
      ],
    },
  ],
  tools: [READ],
  maxOutputTokens: 3000,
};

describe('openai driver', () => {
  it('is a driver plugin, requires the key and picks the model from flag, env, then default', () => {
    expect(plugin.kind).toBe('driver');
    expect(plugin.name).toBe('openai');
    expect(() => plugin.create({ options: {}, env: {}, harnessRoot: '/x' })).toThrow('OPENAI_API_KEY is not set');
    const f = fakeClient([]);
    expect(createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client).model).toBe('gpt-5.5');
    expect(createOpenAIDriver({ options: {}, env: { ...env, HARNESS_OPENAI_MODEL: 'm-env' }, harnessRoot: '/x' }, () => f.client).model).toBe('m-env');
    expect(createOpenAIDriver({ model: 'm-flag', options: {}, env, harnessRoot: '/x' }, () => f.client).model).toBe('m-flag');
  });

  it('defaults only to model ids the installed SDK knows', () => {
    const known: ChatModel[] = ['gpt-5.5', 'gpt-5'];
    expect([...DEFAULT_MODELS]).toEqual(known);
    expect(DEFAULT_MODEL).toBe('gpt-5.5');
  });

  it('translates messages to the chat wire format, ignoring foreign opaque parts', () => {
    expect(toOpenAIMessages(request.system, request.messages)).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'task brief' },
      {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } },
          { id: 'call_b', type: 'function', function: { name: 'outline', arguments: '{"path":"src/x.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '1: export {}' },
      { role: 'tool', tool_call_id: 'call_b', content: 'no such file' },
      { role: 'user', content: 'hook note' },
    ]);
  });

  it('answers every tool call before other content, even when the transcript is malformed', () => {
    const msgs: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } }, { type: 'tool_call', id: 'c2', name: 'read_file', input: { path: 'b' } }] },
      { role: 'user', parts: [{ type: 'text', text: 'note' }, { type: 'tool_result', callId: 'c2', content: '', isError: false }] },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'ghost', content: 'late', isError: true }] },
      { role: 'assistant', parts: [{ type: 'opaque', driver: 'openai', data: {} }] },
    ];
    expect(toOpenAIMessages('', msgs)).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: MISSING_RESULT },
      { role: 'tool', tool_call_id: 'c2', content: '(no output)' },
      { role: 'user', content: 'note\n[result of tool call ghost (error)]\nlate' },
    ]);
  });

  it('sends exact bodies over a realistic 3-turn tool conversation', async () => {
    const big = 'export const app = 1;\n'.repeat(30);
    const f = fakeClient([
      completion(null, [call('call_1', 'write_file', { path: 'src/app.ts', content: big }), call('call_2', 'read_file', { path: 'src/missing.ts' })], 'tool_calls'),
      completion('Running tests.', [call('call_3', 'run_tests', {})], 'tool_calls'),
      completion('All green.', undefined, 'stop'),
    ]);
    const driver = createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
    const WRITE: ToolSpec = { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } };
    const RUN: ToolSpec = { name: 'run_tests', description: 'Run tests', inputSchema: { type: 'object' } };
    const tools = [READ, WRITE, RUN];
    const user1: Message = { role: 'user', parts: [{ type: 'text', text: 'Build the API.' }] };
    const req = (messages: Message[]): ModelRequest => ({ system: 'sys', messages, tools, maxOutputTokens: 8000 });

    const r1 = await driver.complete(req([user1]));
    expect(r1.stop).toBe('tool_calls');
    const results1: Message = {
      role: 'user',
      parts: [
        { type: 'tool_result', callId: 'call_1', content: 'wrote src/app.ts (+30 -0)', isError: false },
        { type: 'tool_result', callId: 'call_2', content: 'no such file: src/missing.ts', isError: true },
        { type: 'text', text: 'note: src/app.ts is not covered by a test yet' },
      ],
    };
    // a foreign opaque part stored by another driver must never reach this wire
    const asst1: Message = { role: 'assistant', parts: [{ type: 'opaque', driver: 'claude', data: { type: 'thinking', thinking: '', signature: 's' } }, ...r1.parts] };
    const r2 = await driver.complete(req([user1, asst1, results1]));
    const results2: Message = { role: 'user', parts: [{ type: 'tool_result', callId: 'call_3', content: 'FAIL 1/3\n  creates', isError: false }] };
    // turn 3: turn 1 compacted (write payload elided, results one-lined)
    const asst1Compact: Message = {
      role: 'assistant',
      parts: r1.parts.map((p) => (p.type === 'tool_call' && p.id === 'call_1' ? { ...p, input: { path: 'src/app.ts', content: `<omitted ${big.length} chars>` } } : p)),
    };
    const results1Compact: Message = {
      role: 'user',
      parts: results1.parts.map((p) => (p.type === 'tool_result' ? { ...p, content: `${p.content} [compacted]` } : p)),
    };
    const r3 = await driver.complete(req([user1, asst1Compact, results1Compact, { role: 'assistant', parts: r2.parts }, results2]));
    expect(r3).toEqual({ parts: [{ type: 'text', text: 'All green.' }], stop: 'end_turn', usage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 128 }, model: 'gpt-6-astra-2026' });

    const common = { model: 'gpt-5.5', max_completion_tokens: 8000, tools: toOpenAITools(tools), tool_choice: 'auto' };
    expect(toOpenAITools([RUN])).toEqual([{ type: 'function', function: { name: 'run_tests', description: 'Run tests', parameters: { type: 'object', properties: {} } } }]);
    const sys = { role: 'system', content: 'sys' };
    const u1 = { role: 'user', content: 'Build the API.' };
    const a1 = (content: string) => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.ts', content }) } },
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/missing.ts"}' } },
      ],
    });
    const t1 = (suffix: string) => [
      { role: 'tool', tool_call_id: 'call_1', content: `wrote src/app.ts (+30 -0)${suffix}` },
      { role: 'tool', tool_call_id: 'call_2', content: `no such file: src/missing.ts${suffix}` },
      { role: 'user', content: 'note: src/app.ts is not covered by a test yet' },
    ];
    const a2 = { role: 'assistant', content: 'Running tests.', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] };
    expect(f.sent).toEqual([
      { ...common, messages: [sys, u1] },
      { ...common, messages: [sys, u1, a1(big), ...t1('')] },
      { ...common, messages: [sys, u1, a1(`<omitted ${big.length} chars>`), ...t1(' [compacted]'), a2, { role: 'tool', tool_call_id: 'call_3', content: 'FAIL 1/3\n  creates' }] },
    ]);
  });

  it('turns invalid JSON arguments into __invalid_json', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments('{"a":')).toEqual({ __invalid_json: '{"a":' });
    const r = fromOpenAIResponse(completion('hmm', [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: 'not json' } }], 'tool_calls'));
    expect(r.parts).toEqual([
      { type: 'text', text: 'hmm' },
      { type: 'tool_call', id: 'c1', name: 'read_file', input: { __invalid_json: 'not json' } },
    ]);
  });

  it('maps finish reasons, refusals and missing usage', () => {
    expect(mapOpenAIStop('stop')).toBe('end_turn');
    expect(mapOpenAIStop('tool_calls')).toBe('tool_calls');
    expect(mapOpenAIStop('length')).toBe('max_tokens');
    expect(mapOpenAIStop('content_filter')).toBe('refusal');
    const r = fromOpenAIResponse(completion('done', undefined, 'stop', null));
    expect(r.stop).toBe('end_turn');
    expect(r.parts).toEqual([{ type: 'text', text: 'done' }]);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    const noCache = fromOpenAIResponse(completion('x', undefined, 'length', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }));
    expect(noCache.stop).toBe('max_tokens');
    expect(noCache.usage.cachedInputTokens).toBe(0);
    const refused = completion(null, undefined, 'stop');
    const choice = refused.choices[0];
    if (choice !== undefined) choice.message.refusal = 'I cannot help with that.';
    expect(fromOpenAIResponse(refused).stop).toBe('refusal');
    expect(fromOpenAIResponse(completion(null, [call('c', 'read_file', {})], 'stop')).stop).toBe('tool_calls');
    expect(fromOpenAIResponse({ ...completion('x', undefined, 'stop'), choices: [] }).stop).toBe('error');
  });

  it('counts the chat payload locally and deterministically', async () => {
    const f = fakeClient([]);
    const driver = createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
    expect(driver.tokenCounter).toBe('js-tiktoken o200k_base (local, OpenAI chat format)');
    const a = await driver.countTokens(request);
    const b = await driver.countTokens(request);
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(b);
    expect(countChatPayload({ messages: [] })).toBe(3);
    const bigger = await driver.countTokens({ ...request, system: request.system + ' and precise'.repeat(50) });
    expect(bigger).toBeGreaterThan(a);
    expect(f.sent).toHaveLength(0);
  });

  describe('400 downgrade', () => {
    const ok = completion('fine', undefined, 'stop');

    it('switches to max_tokens when max_completion_tokens is rejected, for the rest of the session', async () => {
      const f = fakeClient([
        apiError(400, "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead.", 'max_completion_tokens', 'unsupported_parameter'),
        ok,
        ok,
      ]);
      const driver = createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await driver.complete(request);
      await driver.complete(request);
      expect(f.sent.map((b) => [b.max_completion_tokens, b.max_tokens])).toEqual([
        [3000, undefined],
        [undefined, 3000],
        [undefined, 3000],
      ]);
      expect(driver.model).toBe(`gpt-5.5${COMPAT_SUFFIX}`);
      // apart from the token parameter, the retried body is identical
      const [first, second] = f.sent;
      if (first === undefined || second === undefined) throw new Error('missing bodies');
      const { max_completion_tokens: _a, ...restFirst } = first;
      const { max_tokens: _b, ...restSecond } = second;
      expect(restSecond).toEqual(restFirst);
    });

    it('clamps to the output ceiling, drops tool_choice, moves instructions to the developer role and loosens schemas', () => {
      const s1 = adjustShape(apiError(400, 'max_tokens is too large: 64000. This model supports at most 32768 completion tokens, whereas you provided 64000.', 'max_tokens'), STANDARD_SHAPE, 64000);
      expect(s1).toEqual({ ...STANDARD_SHAPE, ceiling: 32768 });
      const s2 = adjustShape(apiError(400, "Invalid value for 'tool_choice'.", 'tool_choice'), STANDARD_SHAPE, 100);
      expect(s2).toEqual({ ...STANDARD_SHAPE, omitToolChoice: true });
      const s3 = adjustShape(apiError(400, "Unsupported value: 'messages[0].role' does not support 'system' with this model.", 'messages[0].role'), STANDARD_SHAPE, 100);
      expect(s3).toEqual({ ...STANDARD_SHAPE, systemRole: 'developer' });
      const s4 = adjustShape(apiError(400, "Invalid schema for function 'read_file': 'maximum' is not permitted.", 'tools[0].function.parameters'), STANDARD_SHAPE, 100);
      expect(s4).toEqual({ ...STANDARD_SHAPE, looseSchemas: true });
      // nothing to change → no adjustment
      expect(adjustShape(apiError(400, "This model's maximum context length is 400000 tokens."), STANDARD_SHAPE, 100)).toBeUndefined();
      expect(adjustShape(apiError(429, 'Rate limit reached'), STANDARD_SHAPE, 100)).toBeUndefined();
      expect(adjustShape(apiError(400, "Invalid value for 'tool_choice'.", 'tool_choice'), { ...STANDARD_SHAPE, omitToolChoice: true }, 100)).toBeUndefined();
    });

    it('applies each adjustment to the request body', async () => {
      const f = fakeClient([
        apiError(400, "Invalid value for 'tool_choice'.", 'tool_choice'),
        apiError(400, "Unsupported value: 'messages[0].role' does not support 'system' with this model.", 'messages[0].role'),
        ok,
      ]);
      const driver = createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await driver.complete(request);
      const last = f.sent[2];
      expect(last !== undefined && 'tool_choice' in last).toBe(false);
      expect(last?.messages[0]).toEqual({ role: 'developer', content: 'be terse' });
      expect(last?.tools).toEqual(toOpenAITools([READ]));
    });

    it('propagates a 400 it cannot fix, without retrying', async () => {
      const f = fakeClient([apiError(400, "This model's maximum context length is 400000 tokens.", 'messages', 'context_length_exceeded')]);
      const driver = createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await expect(driver.complete(request)).rejects.toThrow(/maximum context length/);
      expect(f.sent).toHaveLength(1);
      expect(driver.model).toBe('gpt-5.5');
    });

    it('falls back along the default models when the account cannot use one, but never overrides a chosen model', async () => {
      const notFound = (): Error => apiError(404, 'The model `gpt-5.5` does not exist or you do not have access to it.', null, 'model_not_found');
      expect(isModelUnavailable(notFound())).toBe(true);
      expect(isModelUnavailable(apiError(400, "Unsupported value: 'tool_choice' is not supported with this model."))).toBe(false);
      const f = fakeClient([notFound(), ok, ok]);
      const driver = createOpenAIDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await driver.complete(request);
      await driver.complete(request);
      expect(f.sent.map((b) => b.model)).toEqual(['gpt-5.5', 'gpt-5', 'gpt-5']);
      expect(driver.model).toBe('gpt-5');

      const g = fakeClient([notFound()]);
      const chosen = createOpenAIDriver({ model: 'my-model', options: {}, env, harnessRoot: '/x' }, () => g.client);
      await expect(chosen.complete(request)).rejects.toThrow(/does not exist/);
      expect(g.sent).toHaveLength(1);
    });
  });
});
