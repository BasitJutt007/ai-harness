/**
 * Context overflow is recognised in the drivers (Driver.errorKind, plugins/drivers/_wire.ts), never
 * by wording in the core: the loop only sees the typed kind 'context_overflow' and shrinks the
 * request once (test/core-loop/context-overflow.test.ts). The texts below are the shapes the
 * providers and the gateways in front of them return, with model ids and URLs replaced.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createClaudeDriver, type ClaudeClient } from '../../plugins/drivers/claude.ts';
import { createOpenAIDriver, type OpenAIClient } from '../../plugins/drivers/openai.ts';
import { driverErrorKind, isContextOverflowError } from '../../plugins/drivers/_wire.ts';
import type { Driver, ModelRequest } from '../../src/core/plugin-api.ts';

class StatusError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

const OVERFLOWS: Array<[string, unknown]> = [
  [
    'chat completions: maximum context length + code',
    new StatusError(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens. Please reduce the length of the messages.", 'context_length_exceeded'),
  ],
  ['code only (an empty message)', new StatusError(400, '', 'context_length_exceeded')],
  ['messages API: prompt is too long', new StatusError(400, 'prompt is too long: 213456 tokens > 200000 maximum')],
  ['input token count exceeds the maximum', new StatusError(400, 'The input token count (1500000) exceeds the maximum number of tokens allowed (1048576).')],
  ['gateway: endpoint maximum context length', new StatusError(400, "This endpoint's maximum context length is 131072 tokens. However, you requested about 140213 tokens (124213 of text input, 16000 in the output).")],
  ['local server: exceeds the context window', new StatusError(400, 'the request exceeds the available context window of 32768 tokens')],
  ['local server: context length exceeded wording', new StatusError(500, 'input length exceeds the context length')],
  ['hosted: input is too long', new StatusError(400, 'Input is too long for requested model.')],
  ['HTTP 413, any wording', new StatusError(413, 'Payload Too Large')],
  ['request_too_large type', new StatusError(413, '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}')],
  ['no status at all', new Error('context_length_exceeded: reduce the length of the messages')],
];

const NOT_OVERFLOWS: Array<[string, unknown]> = [
  ['a per-minute token rate limit (wait, do not shrink)', new StatusError(429, 'Request too large for model-x in organization org-1 on tokens per min (TPM): Limit 30000, Requested 41000.')],
  ['a quota', new StatusError(429, 'You exceeded your current quota. RESOURCE_EXHAUSTED')],
  ['an output-token ceiling (clamped by the driver)', new StatusError(400, 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for model-x')],
  ['an output-token ceiling, other wording', new StatusError(400, 'max_completion_tokens is too large: this model supports at most 4096 completion tokens')],
  ['a schema rejection', new StatusError(400, "Invalid schema for function 'write_file': tools[0].parameters is not valid")],
  ['a server error', new StatusError(500, 'Internal server error')],
  ['an auth error', new StatusError(401, 'invalid x-api-key')],
  ['a connection error', new Error('Connection error.')],
  ['a non-error value', 'boom'],
];

describe('isContextOverflowError / driverErrorKind (_wire.ts)', () => {
  for (const [name, e] of OVERFLOWS) {
    it(`overflow: ${name}`, () => {
      expect(isContextOverflowError(e)).toBe(true);
      expect(driverErrorKind(e)).toBe('context_overflow');
    });
  }
  for (const [name, e] of NOT_OVERFLOWS) {
    it(`not an overflow: ${name}`, () => {
      expect(isContextOverflowError(e)).toBe(false);
      expect(driverErrorKind(e)).toBeNull();
    });
  }

  it('reads the real SDK error classes (status, JSON body, code)', () => {
    const h = new Headers({});
    const oa = OpenAI.APIError.generate(400, { error: { message: "This model's maximum context length is 8192 tokens.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }, undefined, h);
    expect(driverErrorKind(oa)).toBe('context_overflow');
    const codeOnly = OpenAI.APIError.generate(400, { error: { message: 'Bad request', type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }, undefined, h);
    expect(driverErrorKind(codeOnly)).toBe('context_overflow');
    const an = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }, undefined, h);
    expect(driverErrorKind(an)).toBe('context_overflow');
    const big = Anthropic.APIError.generate(413, { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum size' } }, undefined, h);
    expect(driverErrorKind(big)).toBe('context_overflow');
    const rate = OpenAI.APIError.generate(429, { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } }, undefined, h);
    expect(driverErrorKind(rate)).toBeNull();
  });
});

const REQ: ModelRequest = { system: 'S', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], maxOutputTokens: 100 };
const OVERFLOW = new StatusError(400, "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", 'context_length_exceeded');

describe('the SDK drivers report the kind and do not retry an overflow themselves', () => {
  it('openai: errorKind; complete() throws at once without changing the request shape', async () => {
    let calls = 0;
    const client: OpenAIClient = {
      chat: {
        completions: {
          async create() {
            calls += 1;
            throw OVERFLOW;
          },
        },
      },
    };
    const d = createOpenAIDriver({ model: 'm', options: {}, env: { OPENAI_API_KEY: 'k' }, harnessRoot: '/x' }, () => client);
    expect(d.errorKind?.(OVERFLOW)).toBe('context_overflow');
    expect(d.errorKind?.(new StatusError(500, 'Internal server error'))).toBeNull();
    await expect(d.complete(REQ)).rejects.toBe(OVERFLOW);
    expect(calls).toBe(1);
    expect(d.model).toBe('m'); // no compat shape adopted for an overflow
  });

  it('claude: errorKind; complete() throws at once without downgrading to the minimal request', async () => {
    let calls = 0;
    // Wording that also names an optional extra must still not trigger the downgrade.
    const tooLong = new StatusError(400, 'prompt is too long: 210000 tokens > 200000 maximum (thinking blocks included)');
    const client: ClaudeClient = {
      beta: {
        messages: {
          async create() {
            calls += 1;
            throw tooLong;
          },
        },
      },
      messages: { create: async () => Promise.reject(new Error('unused')), countTokens: async () => ({ input_tokens: 1 }) },
    };
    const d = createClaudeDriver({ model: 'm', options: {}, env: { ANTHROPIC_API_KEY: 'k' }, harnessRoot: '/x' }, () => client);
    expect(d.errorKind?.(tooLong)).toBe('context_overflow');
    await expect(d.complete(REQ)).rejects.toBe(tooLong);
    expect(calls).toBe(1);
    expect(d.compat).toBe(false);
  });

  it('every SDK driver implements errorKind (the scripted replay has no provider to overflow)', () => {
    const drivers: Driver[] = [
      createOpenAIDriver({ model: 'm', options: {}, env: { OPENAI_API_KEY: 'k' }, harnessRoot: '/x' }, () => ({ chat: { completions: { create: async () => Promise.reject(new Error('unused')) } } })),
      createClaudeDriver({ model: 'm', options: {}, env: { ANTHROPIC_API_KEY: 'k' }, harnessRoot: '/x' }, () => ({
        beta: { messages: { create: async () => Promise.reject(new Error('unused')) } },
        messages: { create: async () => Promise.reject(new Error('unused')), countTokens: async () => ({ input_tokens: 1 }) },
      })),
    ];
    for (const d of drivers) expect(typeof d.errorKind).toBe('function');
  });
});
