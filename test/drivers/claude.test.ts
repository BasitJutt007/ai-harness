import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaStopReason,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  Message as PlainMessage,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming as PlainCreateParams,
} from '@anthropic-ai/sdk/resources/messages/messages';
import plugin, {
  BETAS,
  COMPAT_SUFFIX,
  buildClaudeParams,
  createClaudeDriver,
  fromClaudeResponse,
  isExtrasRejection,
  mapClaudeStop,
  toClaudeMessages,
  toClaudeTools,
  type ClaudeClient,
} from '../../plugins/drivers/claude.ts';
import { CONTINUE_TEXT, MISSING_RESULT } from '../../plugins/drivers/_wire.ts';
import type { Message, ModelRequest, Part, ToolSpec } from '../../src/core/plugin-api.ts';

interface Turn {
  assistant: Message;
  results: Message;
}

/** Stand-in for the core's history compaction: older turns get elided inputs and one-line results. */
const ELIDED = (n: number): string => `<omitted ${n} chars>`;
function compactPart(p: Part): Part {
  if (p.type === 'tool_result') return { ...p, content: `${p.content.split('\n')[0] ?? ''} [compacted]` };
  if (p.type === 'tool_call' && typeof p.input === 'object' && p.input !== null) {
    return { ...p, input: Object.fromEntries(Object.entries(p.input).map(([k, v]) => [k, typeof v === 'string' && v.length > 400 ? ELIDED(v.length) : v])) };
  }
  return p;
}
function historyView(first: Message, turns: Turn[], keep: number): Message[] {
  const out: Message[] = [first];
  turns.forEach((t, i) => {
    const old = i < turns.length - keep;
    for (const m of [t.assistant, t.results]) out.push(old ? { role: m.role, parts: m.parts.map(compactPart) } : m);
  });
  return out;
}

function betaMessage(content: BetaContentBlock[], stop: BetaStopReason | null, usage: Partial<BetaMessage['usage']> = {}): BetaMessage {
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
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 10,
      iterations: null,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...usage,
    },
  };
}

/** A plain-endpoint response built from a beta one (same fields the driver reads). */
function plainMessage(m: BetaMessage): PlainMessage {
  const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return {
    id: m.id,
    container: null,
    content: [{ type: 'text', text, citations: null }],
    diagnostics: null,
    model: m.model,
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

type BetaStep = BetaMessage | Error;

interface Fake {
  client: ClaudeClient;
  created: MessageCreateParamsNonStreaming[];
  plain: PlainCreateParams[];
  counted: MessageCountTokensParams[];
}

function fakeClient(responses: BetaStep[], plainResponses: PlainMessage[] = []): Fake {
  const created: MessageCreateParamsNonStreaming[] = [];
  const plain: PlainCreateParams[] = [];
  const counted: MessageCountTokensParams[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        async create(params) {
          created.push(structuredClone(params));
          const r = responses.shift();
          if (r === undefined) throw new Error('no fake response left');
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
    messages: {
      async create(params) {
        plain.push(structuredClone(params));
        const r = plainResponses.shift();
        if (r === undefined) throw new Error('no fake plain response left');
        return r;
      },
      async countTokens(params) {
        counted.push(structuredClone(params));
        return { input_tokens: 1234 };
      },
    },
  };
  return { client, created, plain, counted };
}

function apiError(status: number, message: string): Error {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers());
}

const env = { ANTHROPIC_API_KEY: 'test-key' };
const thinking = { type: 'thinking', thinking: 'reasoning…', signature: 'sig-abc' };

const READ: ToolSpec = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const WRITE: ToolSpec = {
  name: 'write_file',
  description: 'Write a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
};
const RUN: ToolSpec = { name: 'run_tests', description: 'Run tests', inputSchema: { type: 'object' } };

const request = (messages: Message[]): ModelRequest => ({ system: 'be terse', messages, tools: [READ], maxOutputTokens: 4000 });

describe('claude driver', () => {
  it('is a driver plugin and requires the key', () => {
    expect(plugin.kind).toBe('driver');
    expect(plugin.name).toBe('claude');
    expect(() => plugin.create({ options: {}, env: {}, harnessRoot: '/x' })).toThrow('ANTHROPIC_API_KEY is not set');
  });

  it('picks the model from flag, env, then default', () => {
    const f = fakeClient([]);
    expect(createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client).model).toBe('claude-opus-5-5');
    expect(createClaudeDriver({ options: {}, env: { ...env, HARNESS_CLAUDE_MODEL: 'm-env' }, harnessRoot: '/x' }, () => f.client).model).toBe('m-env');
    expect(createClaudeDriver({ model: 'm-flag', options: {}, env: { ...env, HARNESS_CLAUDE_MODEL: 'm-env' }, harnessRoot: '/x' }, () => f.client).model).toBe('m-flag');
    expect(() => createClaudeDriver({ options: {}, env: { ...env, HARNESS_CLAUDE_EFFORT: 'turbo' }, harnessRoot: '/x' }, () => f.client)).toThrow(/HARNESS_CLAUDE_EFFORT/);
  });

  it('builds the full request with every documented parameter', () => {
    const p = buildClaudeParams({ system: 'sys', messages: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], tools: [READ, RUN], maxOutputTokens: 0 }, 'claude-opus-5-5', 'high');
    expect(p).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system: 'sys',
      tools: [
        { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'run_tests', description: 'Run tests', input_schema: { type: 'object', properties: {} } },
      ],
      tool_choice: { type: 'auto' },
    });
    // no tools → no tools / tool_choice; no system → no system
    const bare = buildClaudeParams({ system: '', messages: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], tools: [], maxOutputTokens: 100 }, 'm', 'low');
    expect('tools' in bare).toBe(false);
    expect('tool_choice' in bare).toBe(false);
    expect('system' in bare).toBe(false);
  });

  it('sends exact bodies over a realistic 3-turn tool conversation', async () => {
    const big = 'export const app = 1;\n'.repeat(30); // > 400 chars → elided once compacted
    const f = fakeClient([
      betaMessage(
        [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'text', text: 'Writing and checking.', citations: null },
          { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'src/app.ts', content: big }, caller: { type: 'direct' } },
          { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'src/missing.ts' }, caller: { type: 'direct' } },
        ],
        'tool_use',
        { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 70 },
      ),
      betaMessage(
        [
          { type: 'redacted_thinking', data: 'opaque-1' },
          { type: 'thinking', thinking: '', signature: 'sig-2' },
          { type: 'tool_use', id: 'toolu_3', name: 'run_tests', input: {}, caller: { type: 'direct' } },
        ],
        'tool_use',
        { input_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 120, output_tokens: 20 },
      ),
      betaMessage(
        [
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: null } },
          { type: 'thinking', thinking: '', signature: 'sig-3' },
          { type: 'text', text: 'All green.', citations: null },
        ],
        'end_turn',
      ),
    ]);
    const driver = createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
    const tools = [READ, WRITE, RUN];
    const first: Message = { role: 'user', parts: [{ type: 'text', text: 'Build the API.' }] };
    const turns: Turn[] = [];
    const req = (): ModelRequest => ({ system: 'sys', messages: historyView(first, turns, 1), tools, maxOutputTokens: 8000 });

    // turn 1
    const r1 = await driver.complete(req());
    expect(r1.stop).toBe('tool_calls');
    expect(r1.usage).toEqual({ inputTokens: 1000, outputTokens: 70, cachedInputTokens: 0 });
    turns.push({
      assistant: { role: 'assistant', parts: r1.parts },
      results: {
        role: 'user',
        parts: [
          { type: 'tool_result', callId: 'toolu_1', content: 'wrote src/app.ts (+30 -0)', isError: false },
          { type: 'tool_result', callId: 'toolu_2', content: 'no such file: src/missing.ts\nuse list_files to see what exists', isError: true },
          { type: 'text', text: 'note: src/app.ts is not covered by a test yet' },
        ],
      },
    });

    // turn 2
    const r2 = await driver.complete(req());
    turns.push({
      assistant: { role: 'assistant', parts: r2.parts },
      results: { role: 'user', parts: [{ type: 'tool_result', callId: 'toolu_3', content: 'FAIL 1/3\n  users.test.ts > creates', isError: false }] },
    });

    // turn 3 (turn 1 now compacted)
    const r3 = await driver.complete(req());
    expect(r3.stop).toBe('end_turn');
    expect(r3.parts.map((p) => p.type)).toEqual(['opaque', 'opaque', 'text']);

    const common = {
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      betas: BETAS,
      fallbacks: 'default',
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system: 'sys',
      tools: toClaudeTools(tools),
      tool_choice: { type: 'auto' },
    };
    const user1 = { role: 'user', content: [{ type: 'text', text: 'Build the API.' }] };
    const asst1 = (content: string) => ({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'Writing and checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'src/app.ts', content } },
        { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'src/missing.ts' } },
      ],
    });
    const results1 = (firstResult: string, second: string) => ({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: firstResult, is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: second, is_error: true },
        { type: 'text', text: 'note: src/app.ts is not covered by a test yet' },
      ],
    });
    const asst2 = {
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'opaque-1' },
        { type: 'thinking', thinking: '', signature: 'sig-2' },
        { type: 'tool_use', id: 'toolu_3', name: 'run_tests', input: {} },
      ],
    };
    const results2 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'FAIL 1/3\n  users.test.ts > creates', is_error: false }] };

    expect(f.created).toHaveLength(3);
    expect(f.created[0]).toEqual({ ...common, messages: [user1] });
    expect(f.created[1]).toEqual({ ...common, messages: [user1, asst1(big), results1('wrote src/app.ts (+30 -0)', 'no such file: src/missing.ts\nuse list_files to see what exists')] });
    expect(f.created[2]).toEqual({
      ...common,
      messages: [
        user1,
        asst1(ELIDED(big.length)),
        results1('wrote src/app.ts (+30 -0) [compacted]', 'no such file: src/missing.ts [compacted]'),
        asst2,
        results2,
      ],
    });
  });

  it('round-trips tool calls, tool results and own opaque blocks', async () => {
    const f = fakeClient([
      betaMessage(
        [
          { type: 'thinking', thinking: 'plan', signature: 's1' },
          { type: 'text', text: 'Reading.', citations: null },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/app.ts' }, caller: { type: 'direct' } },
        ],
        'tool_use',
        { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 7 },
      ),
    ]);
    const driver = createClaudeDriver({ options: {}, env: { ...env, HARNESS_CLAUDE_EFFORT: 'medium' }, harnessRoot: '/x' }, () => f.client);
    const res = await driver.complete(request([{ role: 'user', parts: [{ type: 'text', text: 'go' }] }]));

    expect(res.stop).toBe('tool_calls');
    expect(res.model).toBe('claude-opus-5-5');
    expect(res.usage).toEqual({ inputTokens: 1050, outputTokens: 7, cachedInputTokens: 900 });
    expect(res.parts[0]).toMatchObject({ type: 'opaque', driver: 'claude', data: { type: 'thinking', thinking: 'plan', signature: 's1' } });
    expect(res.parts.slice(1)).toEqual([
      { type: 'text', text: 'Reading.' },
      { type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { path: 'src/app.ts' } },
    ]);
    expect(f.created[0]?.output_config).toEqual({ effort: 'medium' });

    const wire = toClaudeMessages([
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', parts: res.parts },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'toolu_1', content: '1: export {}', isError: false }] },
    ]);
    expect(wire[1]?.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(wire[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1: export {}', is_error: false }] });
  });

  it('replays only its own opaque parts and drops malformed ones', () => {
    const wire = toClaudeMessages([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'opaque', driver: 'openai', data: thinking },
          { type: 'opaque', driver: 'claude', data: { type: 'redacted_thinking', data: 'xyz' } },
          { type: 'opaque', driver: 'claude', data: { type: 'thinking' } },
          { type: 'text', text: 'ok' },
        ],
      },
      { role: 'user', parts: [{ type: 'text', text: 'next' }] },
    ]);
    expect(wire[1]?.content).toEqual([{ type: 'redacted_thinking', data: 'xyz' }, { type: 'text', text: 'ok' }]);
  });

  it('merges same-role messages, puts tool_result blocks first and keeps roles alternating', () => {
    const wire = toClaudeMessages([
      { role: 'user', parts: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'a', name: 'plan', input: { steps: [] } }] },
      { role: 'user', parts: [{ type: 'text', text: 'note: keep going' }, { type: 'tool_result', callId: 'a', content: 'plan recorded', isError: false }] },
      { role: 'user', parts: [{ type: 'text', text: 'nudge' }, { type: 'text', text: '  ' }] },
      { role: 'assistant', parts: [{ type: 'opaque', driver: 'openai', data: {} }] },
    ]);
    expect(wire).toHaveLength(3);
    expect(wire[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'plan recorded', is_error: false },
        { type: 'text', text: 'note: keep going' },
        { type: 'text', text: 'nudge' },
      ],
    });
  });

  it('repairs unanswered calls, orphan results, empty results and a trailing assistant turn', () => {
    const wire = toClaudeMessages([
      { role: 'user', parts: [{ type: 'text', text: 'task' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'a', name: 'read_file', input: { path: 'x' } },
          { type: 'tool_call', id: 'b', name: 'read_file', input: 'not-an-object' },
        ],
      },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'b', content: '', isError: false }, { type: 'tool_result', callId: 'zzz', content: 'stray', isError: false }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ]);
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x' } },
          { type: 'tool_use', id: 'b', name: 'read_file', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: MISSING_RESULT, is_error: true },
          { type: 'tool_result', tool_use_id: 'b', content: '(no output)', is_error: false },
          { type: 'text', text: '[result of tool call zzz]\nstray' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'text', text: CONTINUE_TEXT }] },
    ]);
  });

  it('maps stop reasons', () => {
    expect(mapClaudeStop('end_turn')).toBe('end_turn');
    expect(mapClaudeStop('stop_sequence')).toBe('end_turn');
    expect(mapClaudeStop('pause_turn')).toBe('end_turn');
    expect(mapClaudeStop('tool_use')).toBe('tool_calls');
    expect(mapClaudeStop('max_tokens')).toBe('max_tokens');
    expect(mapClaudeStop('refusal')).toBe('refusal');
    expect(mapClaudeStop('model_context_window_exceeded')).toBe('end_turn');
    expect(mapClaudeStop(null)).toBe('end_turn');
  });

  it('checks refusal before reading content', () => {
    const r = fromClaudeResponse(betaMessage([{ type: 'text', text: 'partial', citations: null }], 'refusal'));
    expect(r.stop).toBe('refusal');
    expect(r.parts).toEqual([]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
  });

  it('keeps fallback blocks as opaque parts and replays them in place', () => {
    const r = fromClaudeResponse(
      betaMessage(
        [
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: null } },
          { type: 'text', text: 'done', citations: null },
        ],
        'end_turn',
      ),
    );
    expect(r.parts[0]?.type).toBe('opaque');
    const wire = toClaudeMessages([{ role: 'user', parts: [{ type: 'text', text: 'go' }] }, { role: 'assistant', parts: r.parts }, { role: 'user', parts: [{ type: 'text', text: 'more' }] }]);
    expect(wire[1]?.content[0]).toMatchObject({ type: 'fallback', from: { model: 'claude-opus-5-5' } });
  });

  it('counts tokens with the counting endpoint, without opaque blocks, tolerating property-less tools', async () => {
    const f = fakeClient([]);
    const driver = createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
    expect(driver.tokenCounter).toBe('anthropic messages.countTokens');
    const n = await driver.countTokens({
      ...request([
        { role: 'user', parts: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', parts: [{ type: 'opaque', driver: 'claude', data: thinking }, { type: 'text', text: 'ok' }] },
        { role: 'user', parts: [{ type: 'text', text: 'next' }] },
      ]),
      tools: [READ, RUN],
    });
    expect(n).toBe(1234);
    expect(f.counted[0]).toEqual({
      model: 'claude-opus-5-5',
      system: 'be terse',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
      tools: toClaudeTools([READ, RUN]),
    });
    // an opaque-only assistant turn disappears and the user turns merge
    await driver.countTokens({ ...request([{ role: 'user', parts: [{ type: 'text', text: 'a' }] }, { role: 'assistant', parts: [{ type: 'opaque', driver: 'claude', data: thinking }] }, { role: 'user', parts: [{ type: 'text', text: 'b' }] }]), tools: [] });
    expect(f.counted[1]?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
    expect(f.counted[1] !== undefined && 'tools' in f.counted[1]).toBe(false);
  });

  describe('400 downgrade', () => {
    const conversation: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'opaque', driver: 'claude', data: thinking },
          { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      { role: 'user', parts: [{ type: 'tool_result', callId: 't1', content: '1: x', isError: false }] },
    ];

    it('retries once with the minimal request and stays there for the session', async () => {
      const ok = betaMessage([{ type: 'text', text: 'fine', citations: null }], 'end_turn');
      const f = fakeClient([apiError(400, 'thinking.block_binding: Extra inputs are not permitted')], [plainMessage(ok), plainMessage(ok)]);
      const driver = createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      expect(driver.model).toBe('claude-opus-5-5');
      const res = await driver.complete(request(conversation));
      expect(res.parts).toEqual([{ type: 'text', text: 'fine' }]);
      expect(driver.compat).toBe(true);
      expect(driver.model).toBe(`claude-opus-5-5${COMPAT_SUFFIX}`);
      expect(f.created).toHaveLength(1);
      expect(f.plain[0]).toEqual({
        model: 'claude-opus-5-5',
        max_tokens: 4000,
        system: 'be terse',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1: x', is_error: false }] },
        ],
        tools: toClaudeTools([READ]),
        tool_choice: { type: 'auto' },
      });
      // later turns go straight to the minimal request
      await driver.complete(request(conversation));
      expect(f.created).toHaveLength(1);
      expect(f.plain).toHaveLength(2);
    });

    it('recognises rejections of each optional extra, and nothing else', () => {
      for (const msg of [
        'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header',
        'fallbacks: "default" is not supported for this model',
        'cache_control: Extra inputs are not permitted',
        'output_config.effort: Input should be low, medium or high',
        'thinking.type: Input tag \'adaptive\' found using \'type\' does not match any of the expected tags',
        'messages.1.content.0: Invalid `signature` in `thinking` block.',
      ]) {
        expect(isExtrasRejection(apiError(400, msg)), msg).toBe(true);
      }
      expect(isExtrasRejection(apiError(400, 'prompt is too long: 1200000 tokens > 1000000 maximum'))).toBe(false);
      expect(isExtrasRejection(apiError(400, 'messages.2: `tool_use` ids were found without `tool_result` blocks'))).toBe(false);
      expect(isExtrasRejection(apiError(429, 'thinking rate limit'))).toBe(false);
      expect(isExtrasRejection(new Error('fallbacks'))).toBe(false);
    });

    it('does not retry other 400s and propagates the error', async () => {
      const f = fakeClient([apiError(400, 'prompt is too long: 1200000 tokens > 1000000 maximum')]);
      const driver = createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await expect(driver.complete(request(conversation))).rejects.toThrow(/prompt is too long/);
      expect(driver.compat).toBe(false);
      expect(f.plain).toHaveLength(0);
    });

    it('propagates a failure of the minimal request too', async () => {
      const f = fakeClient([apiError(400, 'fallbacks: not available')]);
      const driver = createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await expect(driver.complete(request(conversation))).rejects.toThrow(/no fake plain response left/);
    });

    it('clamps max_tokens to the ceiling a 400 names, keeping the full request', async () => {
      const ok = betaMessage([{ type: 'text', text: 'fine', citations: null }], 'end_turn');
      const f = fakeClient([apiError(400, 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5'), ok, ok]);
      const driver = createClaudeDriver({ options: {}, env, harnessRoot: '/x' }, () => f.client);
      await driver.complete({ ...request(conversation), maxOutputTokens: 200000 });
      await driver.complete({ ...request(conversation), maxOutputTokens: 200000 });
      expect(f.created.map((p) => p.max_tokens)).toEqual([200000, 128000, 128000]);
      expect(driver.compat).toBe(false);
    });
  });
});
