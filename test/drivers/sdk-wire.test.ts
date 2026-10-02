/**
 * The drivers driven through the REAL installed SDK clients, with only `fetch` replaced:
 * asserts the HTTP requests (URL, beta header, JSON body) the SDK actually puts on the wire,
 * the SDK's own retry of 529/429, and the 400 downgrade paths end to end. No network.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { CLIENT_OPTIONS as CLAUDE_OPTIONS, createClaudeDriver } from '../../plugins/drivers/claude.ts';
import { CLIENT_OPTIONS as OPENAI_OPTIONS, createOpenAIDriver } from '../../plugins/drivers/openai.ts';
import type { ModelRequest } from '../../src/core/plugin-api.ts';

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = { status: number; json: unknown; headers?: Record<string, string> };

function capture(replies: Reply[]): { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const parsed: unknown = JSON.parse(raw);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {},
      });
      const r = replies.shift();
      if (r === undefined) throw new Error('no reply left');
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
    },
  };
}

const req: ModelRequest = {
  system: 'sys',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'opaque', driver: 'claude', data: { type: 'thinking', thinking: '', signature: 'sig' } },
        { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_call', id: 'call_2', name: 'run_tests', input: {} },
      ],
    },
    {
      role: 'user',
      parts: [
        { type: 'tool_result', callId: 'call_1', content: '1: x', isError: false },
        { type: 'tool_result', callId: 'call_2', content: 'FAIL', isError: true },
      ],
    },
  ],
  tools: [
    { name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'run_tests', description: 'Run', inputSchema: { type: 'object' } },
  ],
  maxOutputTokens: 64000,
};

const claudeOk = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-2' },
    { type: 'text', text: 'done' },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
};

describe('claude driver through the real SDK', () => {
  it('hits the beta endpoint with the beta header, a clean body, and retries 529 itself', async () => {
    expect(CLAUDE_OPTIONS.maxRetries).toBe(4);
    const f = capture([
      { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after-ms': '1' } },
      { status: 200, json: claudeOk },
      { status: 200, json: { input_tokens: 42 } },
    ]);
    const driver = createClaudeDriver({ options: {}, env: { ANTHROPIC_API_KEY: 'k' }, harnessRoot: '/x' }, (apiKey) => new Anthropic({ apiKey, ...CLAUDE_OPTIONS, fetch: f.fetch }));
    // 64k output tokens non-streaming: the explicit timeout keeps the SDK from refusing locally
    const res = await driver.complete(req);
    expect(res).toMatchObject({ stop: 'end_turn', usage: { inputTokens: 17, outputTokens: 3, cachedInputTokens: 5 }, model: 'claude-opus-5-5' });
    expect(f.calls).toHaveLength(2);
    const sent = f.calls[1];
    if (sent === undefined) throw new Error('no request');
    expect(new URL(sent.url).pathname).toBe('/v1/messages');
    expect(new URL(sent.url).searchParams.get('beta')).toBe('true');
    expect(sent.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01,thinking-binding-controls-2026-08-01');
    expect(sent.headers.get('x-api-key')).toBe('k');
    expect(sent.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      fallbacks: 'default',
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system: 'sys',
      tools: [
        { name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'run_tests', description: 'Run', input_schema: { type: 'object', properties: {} } },
      ],
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'call_2', name: 'run_tests', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: '1: x', is_error: false },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'FAIL', is_error: true },
          ],
        },
      ],
    });

    expect(await driver.countTokens(req)).toBe(42);
    const counted = f.calls[2];
    expect(counted !== undefined && new URL(counted.url).pathname).toBe('/v1/messages/count_tokens');
    expect(counted?.headers.get('anthropic-beta')).toBeNull();
    expect(JSON.stringify(counted?.body)).not.toContain('thinking');
  });

  it('downgrades on a 400 naming an extra: plain endpoint, no beta header, minimal body', async () => {
    const f = capture([
      { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.block_binding: Extra inputs are not permitted' } } },
      { status: 200, json: claudeOk },
    ]);
    const driver = createClaudeDriver({ options: {}, env: { ANTHROPIC_API_KEY: 'k' }, harnessRoot: '/x' }, (apiKey) => new Anthropic({ apiKey, ...CLAUDE_OPTIONS, fetch: f.fetch }));
    await driver.complete({ ...req, maxOutputTokens: 4000 });
    expect(f.calls).toHaveLength(2); // a 400 is not retried by the SDK; the driver retried once
    const sent = f.calls[1];
    if (sent === undefined) throw new Error('no request');
    expect(new URL(sent.url).pathname).toBe('/v1/messages');
    expect(new URL(sent.url).searchParams.has('beta')).toBe(false);
    expect(sent.headers.get('anthropic-beta')).toBeNull();
    expect(Object.keys(sent.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system', 'tool_choice', 'tools']);
    expect(JSON.stringify(sent.body['messages'])).not.toContain('thinking');
    expect(driver.model).toBe('claude-opus-5-5 (compat)');
  });
});

const openaiOk = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-6-astra-2026-09-01',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      logprobs: null,
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [
          { id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
          { id: 'call_10', type: 'function', function: { name: 'run_tests', arguments: '{}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 9, total_tokens: 109, prompt_tokens_details: { cached_tokens: 64 } },
};

describe('openai driver through the real SDK', () => {
  it('posts chat completions with function tools and parses parallel calls; retries 429 itself', async () => {
    expect(OPENAI_OPTIONS.maxRetries).toBe(4);
    const f = capture([
      { status: 429, json: { error: { message: 'Rate limit', type: 'rate_limit_error', param: null, code: null } }, headers: { 'retry-after-ms': '1' } },
      { status: 200, json: openaiOk },
    ]);
    const driver = createOpenAIDriver({ options: {}, env: { OPENAI_API_KEY: 'k' }, harnessRoot: '/x' }, (apiKey) => new OpenAI({ apiKey, ...OPENAI_OPTIONS, fetch: f.fetch }));
    const res = await driver.complete(req);
    expect(res.parts).toEqual([
      { type: 'tool_call', id: 'call_9', name: 'read_file', input: { path: 'b.ts' } },
      { type: 'tool_call', id: 'call_10', name: 'run_tests', input: {} },
    ]);
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 9, cachedInputTokens: 64 });
    const sent = f.calls[1];
    if (sent === undefined) throw new Error('no request');
    expect(new URL(sent.url).pathname).toBe('/v1/chat/completions');
    expect(sent.headers.get('authorization')).toBe('Bearer k');
    expect(sent.body).toEqual({
      model: 'gpt-5.5',
      max_completion_tokens: 64000,
      tools: [
        { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
        { type: 'function', function: { name: 'run_tests', description: 'Run', parameters: { type: 'object', properties: {} } } },
      ],
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
            { id: 'call_2', type: 'function', function: { name: 'run_tests', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '1: x' },
        { role: 'tool', tool_call_id: 'call_2', content: 'FAIL' },
      ],
    });
  });

  it('downgrades max_completion_tokens to max_tokens on a 400 naming it', async () => {
    const f = capture([
      { status: 400, json: { error: { message: "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead.", type: 'invalid_request_error', param: 'max_completion_tokens', code: 'unsupported_parameter' } } },
      { status: 200, json: openaiOk },
    ]);
    const driver = createOpenAIDriver({ options: {}, env: { OPENAI_API_KEY: 'k' }, harnessRoot: '/x' }, (apiKey) => new OpenAI({ apiKey, ...OPENAI_OPTIONS, fetch: f.fetch }));
    await driver.complete(req);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.body['max_tokens']).toBe(64000);
    expect('max_completion_tokens' in (f.calls[1]?.body ?? {})).toBe(false);
    expect(driver.model).toBe('gpt-5.5 (compat)');
  });
});
