/**
 * Rate-limit formats live in the drivers (real-model finding F3, moved out of the core): free
 * tiers limit per minute and say how long to wait ("Please retry in 37.6s", "retryDelay": "37s",
 * an echoed X-RateLimit-Reset); a daily quota says hours. The SDK drivers read those formats in
 * Driver.retryAfterMs (plugins/drivers/_wire.ts); the loop only applies its policy to the answer
 * (test/core-loop/rate-limit.test.ts) and otherwise reads nothing but a standard Retry-After.
 *
 * The error texts below are the real ones from the free-tier runs, with URLs and model ids replaced.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { ChatCompletion } from 'openai/resources/chat/completions/completions';
import { createClaudeDriver, type ClaudeClient } from '../../plugins/drivers/claude.ts';
import { createOpenAIDriver, type OpenAIClient } from '../../plugins/drivers/openai.ts';
import { isRateLimitError, rateLimitRetryAfterMs, retryDelayFromText } from '../../plugins/drivers/_wire.ts';
import { RATE_LIMIT_MAX_WAIT_MS, runAgent } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { Driver } from '../../src/core/plugin-api.ts';
import { fakeCtx, fakeStore, finishTool, firstMessage, specs } from '../core-loop/fakes.ts';

/** Shape of the real per-minute error (input tokens per minute exceeded). */
const PER_MINUTE =
  '429 [{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. ' +
  'For more information on this error, head to: https://provider.example/docs/rate-limits.\\n' +
  '* Quota exceeded for metric: provider.example/generate_content_free_tier_input_token_count, limit: 16000, model: model-a\\n' +
  'Please retry in 37.692309754s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.example/QuotaFailure","violations":[{"quotaId":"InputTokensPerModelPerMinute-FreeTier","quotaValue":"16000"}]},' +
  '{"@type":"type.example/RetryInfo","retryDelay":"37s"}]}}]';

/** Shape of the real daily-quota error (requests per day exhausted). */
const DAILY =
  '429 [{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.\\n' +
  '* Quota exceeded for metric: provider.example/generate_content_free_tier_requests, limit: 20, model: model-b\\n' +
  'Please retry in 6h56m35.833502263s.","status":"RESOURCE_EXHAUSTED"}}]';

/** The per-minute error of another free tier: no wait in words, only the window's reset time (epoch) in echoed headers. */
const perMinuteReset = (reset: number): string =>
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded: free-models-per-min. ","error_type":"rate_limit_exceeded"},' +
  '"request_id":"gen-1","metadata":{"headers":{"X-RateLimit-Limit":"20","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"' +
  String(reset) +
  '"},"limit_source":"free_tier_per_minute","remedy_hint":"Slow down requests to free models, or retry after the per-minute window resets.","provider_name":null}}';

class StatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

describe('retryDelayFromText / isRateLimitError (_wire.ts)', () => {
  it('reads the structured retryDelay first, then the sentence, then a Retry-After header', () => {
    expect(retryDelayFromText(PER_MINUTE)).toBe(37_000);
    expect(retryDelayFromText('Please retry in 37.692309754s.')).toBe(37_693);
    expect(retryDelayFromText(DAILY)).toBe(Math.ceil((6 * 3600 + 56 * 60 + 35.833502263) * 1000));
    expect(retryDelayFromText('rate limit: retry after 1m30s')).toBe(90_000);
    expect(retryDelayFromText('retry in 250ms')).toBe(250);
    expect(retryDelayFromText('429 Too Many Requests; retry-after: 20')).toBe(20_000);
    expect(retryDelayFromText('{"headers":{"retry-after":"12"}}')).toBe(12_000);
    expect(retryDelayFromText('429 Too Many Requests')).toBeNull();
    expect(retryDelayFromText('Connection error.')).toBeNull();
  });

  it('reads an echoed X-RateLimit-Reset epoch timestamp (ms or s) as the time left until it', () => {
    const now = 1_791_045_573_000;
    expect(retryDelayFromText(perMinuteReset(1_791_045_600_000), now)).toBe(27_000);
    expect(retryDelayFromText(perMinuteReset(1_791_045_600), now)).toBe(27_000); // epoch seconds
    expect(retryDelayFromText(perMinuteReset(now - 5_000), now)).toBe(0); // already reset: retry now
    expect(retryDelayFromText('{\\"X-RateLimit-Reset\\":\\"1791045600000\\"}', now)).toBe(27_000); // escaped JSON
    expect(retryDelayFromText('{"X-RateLimit-Reset":"60"}', now)).toBeNull(); // not an epoch timestamp
    // a named wait still wins over the reset time
    expect(retryDelayFromText(`${perMinuteReset(1_791_045_600_000)} Please retry in 3s.`, now)).toBe(3_000);
  });

  it('recognises a rate limit by HTTP status or wording, not other failures', () => {
    expect(isRateLimitError(new StatusError(429, 'Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error(PER_MINUTE))).toBe(true);
    expect(isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new StatusError(402, 'can only afford 2000 tokens'))).toBe(false);
    expect(isRateLimitError(new Error('Connection error.'))).toBe(false);
  });

  it('rateLimitRetryAfterMs: only a rate limit names a wait; a non-rate-limit error mentioning "retry in" names none', () => {
    expect(rateLimitRetryAfterMs(new Error(PER_MINUTE))).toBe(37_000);
    expect(rateLimitRetryAfterMs(new StatusError(500, 'internal error, retry in 5s'))).toBeNull();
    expect(rateLimitRetryAfterMs(new StatusError(429, 'Too Many Requests'))).toBeNull();
    expect(rateLimitRetryAfterMs('not an error object')).toBeNull();
  });
});

describe('rate limits through the real SDK error classes', () => {
  const headers = (h: Record<string, string>): Headers => new Headers(h);

  it('reads retry-after-ms and retry-after response headers of an SDK error, and the JSON error body', () => {
    const e1 = OpenAI.APIError.generate(429, { message: 'Rate limit reached' }, undefined, headers({ 'retry-after-ms': '2500' }));
    expect(rateLimitRetryAfterMs(e1)).toBe(2500);
    const e2 = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, headers({ 'retry-after': '7' }));
    expect(rateLimitRetryAfterMs(e2)).toBe(7000);
    const body = JSON.parse(PER_MINUTE.slice(4)) as object[];
    const e3 = OpenAI.APIError.generate(429, body[0], undefined, headers({}));
    expect(rateLimitRetryAfterMs(e3)).toBe(37_000);
    const e4 = OpenAI.APIError.generate(400, { message: 'bad request, retry in 3s' }, undefined, headers({ 'retry-after': '3' }));
    expect(rateLimitRetryAfterMs(e4)).toBeNull();
  });
});

function openaiDriver(steps: Array<Error | ChatCompletion>): Driver {
  const client: OpenAIClient = {
    chat: {
      completions: {
        async create() {
          const s = steps.shift();
          if (s === undefined) throw new Error('no step left');
          if (s instanceof Error) throw s;
          return s;
        },
      },
    },
  };
  return createOpenAIDriver({ model: 'm', options: {}, env: { OPENAI_API_KEY: 'k' }, harnessRoot: '/x' }, () => client);
}

function claudeDriver(): Driver {
  const client: ClaudeClient = {
    beta: { messages: { create: async () => Promise.reject(new Error('unused')) } },
    messages: { create: async () => Promise.reject(new Error('unused')), countTokens: async () => ({ input_tokens: 1 }) },
  };
  return createClaudeDriver({ options: {}, env: { ANTHROPIC_API_KEY: 'k' }, harnessRoot: '/x' }, () => client);
}

describe('each SDK driver implements Driver.retryAfterMs', () => {
  const cases: Array<[string, () => Driver]> = [
    ['openai', () => openaiDriver([])],
    ['claude', claudeDriver],
  ];
  for (const [name, make] of cases) {
    it(`${name}: vendor formats in, a wait in ms out; null for anything that names none`, () => {
      const d = make();
      expect(typeof d.retryAfterMs).toBe('function');
      const now = Date.now();
      const asked = (e: unknown): number | null => d.retryAfterMs?.(e) ?? null;
      expect(asked(new Error(PER_MINUTE))).toBe(37_000);
      expect(asked(new StatusError(429, DAILY))).toBe(Math.ceil((6 * 3600 + 56 * 60 + 35.833502263) * 1000));
      const reset = asked(new StatusError(429, perMinuteReset(now + 27_000)));
      expect(reset).toBeGreaterThan(20_000);
      expect(reset).toBeLessThanOrEqual(27_000);
      expect(asked(new StatusError(429, 'Too Many Requests'))).toBeNull();
      expect(asked(new StatusError(500, 'Internal error'))).toBeNull();
      expect(asked(new Error('Connection error.'))).toBeNull();
    });
  }
});

describe('driver format → loop policy, end to end', () => {
  function setup(driver: Driver) {
    const tools = [finishTool()];
    const { ctx, events, logs } = fakeCtx({ tools });
    const waits: number[] = [];
    const run = () =>
      runAgent({
        driver,
        ctx,
        store: fakeStore(logs),
        ledger: new TokenLedger({ runId: 'r', task: 't', driver: driver.name, model: 'm', counter: 'local', mode: 'jit' }),
        first: firstMessage(),
        system: 'S',
        baselineSystem: 'S+F',
        tools: specs(tools),
        maxTurns: 1,
        maxOutputTokens: 100,
        retryDelaysMs: [],
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
    return { run, waits, events };
  }

  const ok: ChatCompletion = {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  it('the openai driver reads the per-minute wait; the loop waits it out (plus 1s) and continues', async () => {
    const s = setup(openaiDriver([new StatusError(429, PER_MINUTE), ok]));
    const r = await s.run();
    expect(r.status).not.toBe('error');
    expect(s.waits).toEqual([38_000]);
  });

  it('the openai driver reads a daily quota; the loop stops at once instead of sleeping for hours', async () => {
    const s = setup(openaiDriver([new StatusError(429, DAILY), ok]));
    const r = await s.run();
    expect(r.status).toBe('error');
    expect(r.error).toMatch(new RegExp(`^driver\\.complete stopped: rate limited: .*longer than the ${RATE_LIMIT_MAX_WAIT_MS / 1000}s`));
    expect(s.waits).toEqual([]);
  });
});
