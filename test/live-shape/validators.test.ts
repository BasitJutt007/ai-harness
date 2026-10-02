/**
 * The live-shape fakes are only evidence if their validators actually refuse malformed
 * requests. Each case here feeds one known-bad request and expects the rule to fire.
 */
import { describe, expect, it } from 'vitest';
import { CLAUDE_EXPECTED_BETAS, validateClaudeCount, validateClaudeCreate, validateOpenAIChat, type WireRequest } from './fake-providers.ts';

function claudeReq(body: Record<string, unknown>, opts: { beta?: boolean; betas?: string[] } = {}): WireRequest {
  const url = new URL(`https://api.anthropic.com/v1/messages${opts.beta === true ? '?beta=true' : ''}`);
  const headers = new Headers({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
  if (opts.betas !== undefined) headers.set('anthropic-beta', opts.betas.join(','));
  return { method: 'POST', url, headers, body };
}

const tools = [{ name: 'run_tests', description: 'Run', input_schema: { type: 'object', properties: {} } }];
const ok = {
  model: 'm',
  max_tokens: 100,
  tools,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'run_tests', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] },
  ],
};
const none = new Map<string, string>();

describe('Messages API validator', () => {
  it('accepts a well-formed plain request', () => {
    expect(validateClaudeCreate(claudeReq(ok), none)).toEqual([]);
  });

  it.each([
    ['missing max_tokens', { ...ok, max_tokens: undefined }, /max_tokens/],
    ['unanswered tool_use', { ...ok, messages: [...ok.messages.slice(0, 2), { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, /without tool_result/],
    ['result for unknown id', { ...ok, messages: [ok.messages[0], ok.messages[1], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'x' }] }] }, /unexpected tool_use_id/],
    ['text before tool_result', { ...ok, messages: [ok.messages[0], ok.messages[1], { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }] }, /must come first/],
    ['non-alternating roles', { ...ok, messages: [ok.messages[0], ok.messages[0]] }, /alternate/],
    ['empty text block', { ...ok, messages: [{ role: 'user', content: [{ type: 'text', text: ' ' }] }] }, /non-whitespace/],
    ['tool schema not an object', { ...ok, tools: [{ name: 'run_tests', description: 'Run', input_schema: { type: 'string' } }] }, /'object'/],
    ['root anyOf in schema', { ...ok, tools: [{ name: 'run_tests', description: 'Run', input_schema: { type: 'object', anyOf: [] } }] }, /anyOf/],
    ['unknown tool used', { ...ok, tools: [{ ...tools[0], name: 'other' }] }, /not in tools/],
    ['betas in the body', { ...ok, betas: ['x'] }, /anthropic-beta header/],
    ['fallbacks on the plain endpoint', { ...ok, fallbacks: 'default' }, /fallbacks/],
  ])('rejects: %s', (_label, body, re) => {
    const problems = validateClaudeCreate(claudeReq(body), none);
    expect(problems.join('\n')).toMatch(re);
  });

  it('beta extras need their beta header', () => {
    const body = { ...ok, fallbacks: 'default', thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
    const missing = validateClaudeCreate(claudeReq(body, { beta: true, betas: [] }), none).join('\n');
    expect(missing).toContain(CLAUDE_EXPECTED_BETAS.fallbacks);
    expect(missing).toContain(CLAUDE_EXPECTED_BETAS.blockBinding);
  });

  it('with thinking on, the final tool-using assistant turn must start with a verbatim thinking block', () => {
    const betas = [CLAUDE_EXPECTED_BETAS.fallbacks, CLAUDE_EXPECTED_BETAS.blockBinding];
    const thinking = { type: 'adaptive' };
    expect(validateClaudeCreate(claudeReq({ ...ok, thinking }, { beta: true, betas }), none).join('\n')).toMatch(/must start with a thinking block/);
    const replay = (text: string): Record<string, unknown> => ({
      ...ok,
      thinking,
      messages: [ok.messages[0], { role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: 'sig' }, ok.messages[1]?.content[0]] }, ok.messages[2]],
    });
    const issued = new Map([['sig', 'original']]);
    expect(validateClaudeCreate(claudeReq(replay('original'), { beta: true, betas }), issued)).toEqual([]);
    expect(validateClaudeCreate(claudeReq(replay('edited'), { beta: true, betas }), issued).join('\n')).toMatch(/Invalid signature/);
  });

  it('count_tokens refuses max_tokens', () => {
    expect(validateClaudeCount(claudeReq(ok), none).join('\n')).toMatch(/body\.max_tokens/);
  });
});

function chatReq(body: Record<string, unknown>): WireRequest {
  return {
    method: 'POST',
    url: new URL('https://api.openai.com/v1/chat/completions'),
    headers: new Headers({ authorization: 'Bearer test', 'content-type': 'application/json' }),
    body,
  };
}

const fnTools = [{ type: 'function', function: { name: 'run_tests', description: 'Run', parameters: { type: 'object', properties: {} } } }];
const chatOk = {
  model: 'm',
  max_completion_tokens: 100,
  tools: fnTools,
  tool_choice: 'auto',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ],
};

describe('Chat Completions validator', () => {
  it('accepts a well-formed request', () => {
    expect(validateOpenAIChat(chatReq(chatOk), { legacyOnly: false })).toEqual([]);
  });

  it.each([
    ['unanswered tool call', { ...chatOk, messages: [...chatOk.messages.slice(0, 3), { role: 'user', content: 'x' }] }, /did not have response messages/],
    ['orphan tool message', { ...chatOk, messages: [chatOk.messages[0], chatOk.messages[1], chatOk.messages[3]] }, /must be a response/],
    ['bad arguments JSON', { ...chatOk, messages: [chatOk.messages[0], chatOk.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_tests', arguments: '{' } }] }, chatOk.messages[3]] }, /invalid JSON/],
    ['no instructions first', { ...chatOk, messages: chatOk.messages.slice(1) }, /system\/developer/],
    ['both output limits', { ...chatOk, max_tokens: 5 }, /mutually exclusive/],
    ['tool_choice without tools', { ...chatOk, tools: undefined, messages: chatOk.messages.slice(0, 2) }, /only allowed when/],
    ['non-object parameters', { ...chatOk, tools: [{ type: 'function', function: { name: 'run_tests', description: 'Run', parameters: { type: 'array' } } }] }, /type: "object"/],
  ])('rejects: %s', (_label, body, re) => {
    expect(validateOpenAIChat(chatReq(body), { legacyOnly: false }).join('\n')).toMatch(re);
  });

  it('refuses max_completion_tokens once the model is legacy-only', () => {
    expect(validateOpenAIChat(chatReq(chatOk), { legacyOnly: true }).join('\n')).toMatch(/Unsupported parameter/);
  });
});
