/**
 * Provider rate limits (real-model finding F3): free tiers limit per minute and say how long
 * to wait ("Please retry in 37.6s", "retryDelay": "37s"); a daily quota says hours. The loop
 * honours a named wait up to RATE_LIMIT_MAX_WAIT_MS (at most MAX_RATE_LIMIT_WAITS times per
 * request, outside the normal retry budget) and stops at once on a longer one.
 *
 * The error texts below are the real ones from the free-tier runs, with the provider's URLs
 * and model ids replaced (the core and its tests name no provider).
 */
import { describe, expect, it } from 'vitest';
import {
  isRateLimit,
  MAX_RATE_LIMIT_WAITS,
  providerRetryDelayMs,
  RATE_LIMIT_MAX_WAIT_MS,
  runAgent,
  type RunAgentOptions,
} from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import { call, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, reply, specs } from './fakes.ts';

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

/**
 * Shape of the real per-minute error of another free tier: it names no wait in words, only the
 * window's reset time (epoch ms) in echoed headers. `reset` replaces the real timestamp.
 */
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

describe('providerRetryDelayMs / isRateLimit', () => {
  it('reads the structured retryDelay first, then the sentence, then a Retry-After header', () => {
    expect(providerRetryDelayMs(PER_MINUTE)).toBe(37_000);
    expect(providerRetryDelayMs('Please retry in 37.692309754s.')).toBe(37_693);
    expect(providerRetryDelayMs(DAILY)).toBe(Math.ceil((6 * 3600 + 56 * 60 + 35.833502263) * 1000));
    expect(providerRetryDelayMs('rate limit: retry after 1m30s')).toBe(90_000);
    expect(providerRetryDelayMs('retry in 250ms')).toBe(250);
    expect(providerRetryDelayMs('429 Too Many Requests; retry-after: 20')).toBe(20_000);
    expect(providerRetryDelayMs('{"headers":{"retry-after":"12"}}')).toBe(12_000);
    expect(providerRetryDelayMs('429 Too Many Requests')).toBeNull();
    expect(providerRetryDelayMs('Connection error.')).toBeNull();
  });

  it('reads an echoed X-RateLimit-Reset epoch timestamp (ms or s) as the time left until it', () => {
    const now = 1_791_045_573_000;
    expect(providerRetryDelayMs(perMinuteReset(1_791_045_600_000), now)).toBe(27_000);
    expect(providerRetryDelayMs(perMinuteReset(1_791_045_600), now)).toBe(27_000); // epoch seconds
    expect(providerRetryDelayMs(perMinuteReset(now - 5_000), now)).toBe(0); // already reset: retry now
    expect(providerRetryDelayMs('{\\"X-RateLimit-Reset\\":\\"1791045600000\\"}', now)).toBe(27_000); // escaped JSON
    expect(providerRetryDelayMs('{"X-RateLimit-Reset":"60"}', now)).toBeNull(); // not an epoch timestamp
    // a named wait still wins over the reset time
    expect(providerRetryDelayMs(`${perMinuteReset(1_791_045_600_000)} Please retry in 3s.`, now)).toBe(3_000);
  });

  it('recognises a rate limit by HTTP status or wording, not other failures', () => {
    expect(isRateLimit(new StatusError(429, 'Too Many Requests'))).toBe(true);
    expect(isRateLimit(new Error(PER_MINUTE))).toBe(true);
    expect(isRateLimit(new Error('rate limit exceeded'))).toBe(true);
    expect(isRateLimit(new StatusError(402, 'can only afford 2000 tokens'))).toBe(false);
    expect(isRateLimit(new Error('Connection error.'))).toBe(false);
  });
});

function setup(script: ConstructorParameters<typeof FakeDriver>[0], retryDelaysMs: number[] = []) {
  const tools = [finishTool()];
  const { ctx, events, logs } = fakeCtx({ tools });
  const driver = new FakeDriver(script);
  const waits: number[] = [];
  const opts: RunAgentOptions = {
    driver,
    ctx,
    store: fakeStore(logs),
    ledger: new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: 'jit' }),
    first: firstMessage(),
    system: 'S',
    baselineSystem: 'S+F',
    tools: specs(tools),
    maxTurns: 1,
    maxOutputTokens: 100,
    retryDelaysMs,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
  return { driver, events, waits, opts };
}

const answer = reply([{ type: 'text', text: 'ok' }], 'end_turn');

describe('the loop on rate limits', () => {
  it('waits out a short named delay (plus 1s), outside the retry budget, then continues', async () => {
    const s = setup([new Error(PER_MINUTE), new StatusError(429, 'Please retry in 2s.'), answer], []);
    const r = await runAgent(s.opts);
    expect(r.status).not.toBe('error');
    expect(s.waits).toEqual([38_000, 3_000]);
    expect(s.driver.requests).toHaveLength(3);
    const notes = s.events.filter((e) => e.kind === 'note' && e.source === 'driver').map((e) => e.message);
    expect(notes[0]).toMatch(/rate limited: the provider asked to retry in 37s; waiting \(1\/30\)/);
  });

  it('stops at once on a long wait (a daily quota) instead of sleeping for hours', async () => {
    const s = setup([new Error(DAILY), answer], [0, 0, 0]);
    const r = await runAgent(s.opts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^driver\.complete stopped: rate limited: the provider asked to retry in 24996s, longer than the 120s/);
    expect(s.waits).toEqual([]); // neither a rate wait nor a normal retry
    expect(s.driver.requests).toHaveLength(1);
  });

  it(`the limit is exactly ${RATE_LIMIT_MAX_WAIT_MS / 1000}s`, async () => {
    const s = setup([new Error(`429 Please retry in ${RATE_LIMIT_MAX_WAIT_MS / 1000}s.`), answer]);
    await runAgent(s.opts);
    expect(s.waits).toEqual([RATE_LIMIT_MAX_WAIT_MS + 1000]);
    const t = setup([new Error(`429 Please retry in ${RATE_LIMIT_MAX_WAIT_MS / 1000 + 1}s.`), answer]);
    expect((await runAgent(t.opts)).status).toBe('error');
  });

  it(`caps the waits at ${MAX_RATE_LIMIT_WAITS} per request, then falls back to the normal retry budget`, async () => {
    const always = (): never => {
      throw new Error('429 rate limit; Please retry in 1s.');
    };
    const s = setup(Array.from({ length: 40 }, () => always), [5]);
    const r = await runAgent(s.opts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^driver\.complete failed after 2 attempts: 429 rate limit/);
    expect(s.waits).toEqual([...Array.from({ length: MAX_RATE_LIMIT_WAITS }, () => 2_000), 5]);
    expect(s.driver.requests).toHaveLength(MAX_RATE_LIMIT_WAITS + 2);
  });

  it('waits out a per-minute window named only by its reset time, instead of giving up after the retry budget', async () => {
    const err = (): StatusError => new StatusError(429, perMinuteReset(Date.now() + 27_000));
    const s = setup([err(), err(), err(), err(), answer], [1000, 4000, 10000]);
    const r = await runAgent(s.opts);
    expect(r.status).not.toBe('error');
    expect(s.driver.requests).toHaveLength(5);
    expect(s.waits).toHaveLength(4);
    for (const w of s.waits) {
      expect(w).toBeGreaterThan(20_000);
      expect(w).toBeLessThanOrEqual(28_000);
    }
  });

  it('a reset time further away than the limit stops the run at once', async () => {
    const s = setup([new StatusError(429, perMinuteReset(Date.now() + 3_600_000)), answer], [0, 0, 0]);
    const r = await runAgent(s.opts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^driver\.complete stopped: rate limited/);
    expect(s.waits).toEqual([]);
  });

  it('a rate limit that names no wait uses the normal retry budget', async () => {
    const s = setup([new StatusError(429, 'Too Many Requests'), answer], [7]);
    await runAgent(s.opts);
    expect(s.waits).toEqual([7]);
  });

  it('an abort during the wait ends the run as aborted, not as an error', async () => {
    const controller = new AbortController();
    const s = setup([new Error(PER_MINUTE), answer]);
    const r = await runAgent({
      ...s.opts,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(r.status).toBe('aborted');
    expect(s.driver.requests).toHaveLength(1);
  });

  it('the default wait is cut short by an abort (no 38s sleep)', async () => {
    const controller = new AbortController();
    const s = setup([new Error(PER_MINUTE), answer]);
    const { sleep: _unused, ...withDefaultSleep } = s.opts;
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const r = await runAgent({ ...withDefaultSleep, signal: controller.signal });
    expect(r.status).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a tool-using run continues normally after a wait', async () => {
    const s = setup([new Error(PER_MINUTE), reply([call('f1', 'finish', { summary: 'done' })])]);
    const r = await runAgent(s.opts);
    expect(s.waits).toEqual([38_000]);
    expect(r.turns).toBe(1);
  });
});
