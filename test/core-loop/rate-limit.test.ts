/**
 * Rate-limit POLICY of the loop (real-model finding F3). The wait comes from the driver
 * (Driver.retryAfterMs reads the provider's own formats: test/drivers/rate-limit.test.ts), else
 * from a standard Retry-After header of an HTTP 429/503 error; the core reads no provider text.
 * The loop honours a named wait up to RATE_LIMIT_MAX_WAIT_MS (at most MAX_RATE_LIMIT_WAITS times
 * per request, outside the normal retry budget) and stops at once on a longer one.
 */
import { describe, expect, it } from 'vitest';
import {
  genericRetryAfterMs,
  MAX_RATE_LIMIT_WAITS,
  parseRetryAfter,
  RATE_LIMIT_MAX_WAIT_MS,
  retryAfterMs,
  runAgent,
  type RunAgentOptions,
} from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import { call, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, reply, specs } from './fakes.ts';

/** An error a test driver understands: it names its wait in a field only that driver reads. */
class WaitError extends Error {
  constructor(readonly waitMs: number, message = 'rate limited') {
    super(message);
  }
}

/** An HTTP error of the generic shape: status plus response headers. */
class HttpError extends Error {
  constructor(readonly status: number, readonly headers: Record<string, string> | Headers = {}, message = `${status}`) {
    super(message);
  }
}

/** A FakeDriver whose retryAfterMs reads WaitError (what a real driver does with its provider's format). */
class WaitingDriver extends FakeDriver {
  retryAfterMs(e: unknown): number | null {
    return e instanceof WaitError ? e.waitMs : null;
  }
}

function setup(script: ConstructorParameters<typeof FakeDriver>[0], retryDelaysMs: number[] = [], driver: FakeDriver = new WaitingDriver(script)) {
  const tools = [finishTool()];
  const { ctx, events, logs } = fakeCtx({ tools });
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

describe('the generic Retry-After fallback (no provider format in the core)', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');

  it('reads Retry-After seconds or an HTTP date on an HTTP 429 or 503 error, any header letter case or a Headers object', () => {
    expect(parseRetryAfter('20', now)).toBe(20_000);
    expect(parseRetryAfter(' 1.5 ', now)).toBe(1_500);
    expect(parseRetryAfter('Sun, 04 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sun, 04 Oct 2026 11:00:00 GMT', now)).toBe(0); // in the past: retry now
    expect(parseRetryAfter('soon', now)).toBeNull();
    for (const status of [429, 503]) {
      expect(genericRetryAfterMs(new HttpError(status, { 'Retry-After': '20' }), now)).toBe(20_000);
      expect(genericRetryAfterMs(new HttpError(status, { 'retry-after': 'Sun, 04 Oct 2026 12:00:30 GMT' }), now)).toBe(30_000);
      expect(genericRetryAfterMs(new HttpError(status, new Headers({ 'retry-after': '7' })), now)).toBe(7_000);
    }
  });

  it('names no wait for another status, a missing header, a non-error value, or a wait written only in the message', () => {
    expect(genericRetryAfterMs(new HttpError(500, { 'retry-after': '20' }), now)).toBeNull();
    expect(genericRetryAfterMs(new HttpError(400, { 'retry-after': '20' }), now)).toBeNull();
    expect(genericRetryAfterMs(new HttpError(429, {}), now)).toBeNull();
    expect(genericRetryAfterMs(new HttpError(429, { 'retry-after': 'later' }), now)).toBeNull();
    expect(genericRetryAfterMs('429 retry-after: 20', now)).toBeNull();
    expect(genericRetryAfterMs(null, now)).toBeNull();
    // provider text is the driver's business: the core does not read "retry in 37s" from a message
    expect(genericRetryAfterMs(new HttpError(429, {}, '429 Please retry in 37s. "retryDelay": "37s"'), now)).toBeNull();
  });

  it('retryAfterMs: the driver first; a driver that names none, throws or answers nonsense falls back to the header', () => {
    const header = new HttpError(429, { 'retry-after': '5' });
    expect(retryAfterMs({ retryAfterMs: () => 2_000 }, header)).toBe(2_000);
    expect(retryAfterMs({ retryAfterMs: () => null }, header)).toBe(5_000);
    expect(retryAfterMs({}, header)).toBe(5_000);
    expect(
      retryAfterMs(
        {
          retryAfterMs: () => {
            throw new Error('parser bug');
          },
        },
        header,
      ),
    ).toBe(5_000);
    expect(retryAfterMs({ retryAfterMs: () => Number.NaN }, header)).toBe(5_000);
    expect(retryAfterMs({ retryAfterMs: () => -1 }, header)).toBe(5_000);
    expect(retryAfterMs({ retryAfterMs: () => 1.2 }, new Error('x'))).toBe(2);
    expect(retryAfterMs({}, new Error('429 rate limit, retry in 3s'))).toBeNull();
  });
});

describe('the loop on rate limits', () => {
  it('waits out a short named delay (plus 1s), outside the retry budget, then continues', async () => {
    const s = setup([new WaitError(37_000), new WaitError(2_000), answer], []);
    const r = await runAgent(s.opts);
    expect(r.status).not.toBe('error');
    expect(s.waits).toEqual([38_000, 3_000]);
    expect(s.driver.requests).toHaveLength(3);
    const notes = s.events.filter((e) => e.kind === 'note' && e.source === 'driver').map((e) => e.message);
    expect(notes[0]).toMatch(/rate limited: the provider asked to retry in 37s; waiting \(1\/30\)/);
  });

  it('honours a standard Retry-After header with a driver that reads nothing itself', async () => {
    const script = [new HttpError(429, { 'Retry-After': '4' }), new HttpError(503, new Headers({ 'retry-after': '2' })), answer];
    const s = setup(script, [], new FakeDriver(script));
    const r = await runAgent(s.opts);
    expect(r.status).not.toBe('error');
    expect(s.waits).toEqual([5_000, 3_000]);
  });

  it('stops at once on a long wait (a daily quota) instead of sleeping for hours', async () => {
    const daily = (6 * 3600 + 56 * 60 + 35) * 1000;
    const s = setup([new WaitError(daily, '429 quota'), answer], [0, 0, 0]);
    const r = await runAgent(s.opts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^driver\.complete stopped: rate limited: the provider asked to retry in 24995s, longer than the 120s/);
    expect(s.waits).toEqual([]); // neither a rate wait nor a normal retry
    expect(s.driver.requests).toHaveLength(1);
  });

  it(`the limit is exactly ${RATE_LIMIT_MAX_WAIT_MS / 1000}s`, async () => {
    const s = setup([new WaitError(RATE_LIMIT_MAX_WAIT_MS), answer]);
    await runAgent(s.opts);
    expect(s.waits).toEqual([RATE_LIMIT_MAX_WAIT_MS + 1000]);
    const t = setup([new WaitError(RATE_LIMIT_MAX_WAIT_MS + 1000), answer]);
    expect((await runAgent(t.opts)).status).toBe('error');
  });

  it(`caps the waits at ${MAX_RATE_LIMIT_WAITS} per request, then falls back to the normal retry budget`, async () => {
    const always = (): never => {
      throw new WaitError(1_000, '429 rate limit');
    };
    const s = setup(Array.from({ length: 40 }, () => always), [5]);
    const r = await runAgent(s.opts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^driver\.complete failed after 2 attempts: 429 rate limit/);
    expect(s.waits).toEqual([...Array.from({ length: MAX_RATE_LIMIT_WAITS }, () => 2_000), 5]);
    expect(s.driver.requests).toHaveLength(MAX_RATE_LIMIT_WAITS + 2);
  });

  it('a wait of 0 (a window that already reset) retries at once, outside the retry budget', async () => {
    const s = setup([new WaitError(0), new WaitError(0), new WaitError(0), new WaitError(0), answer], [1000, 4000, 10000]);
    const r = await runAgent(s.opts);
    expect(r.status).not.toBe('error');
    expect(s.driver.requests).toHaveLength(5);
    expect(s.waits).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  it('a rate limit that names no wait uses the normal retry budget', async () => {
    const s = setup([new HttpError(429, {}, 'Too Many Requests'), answer], [7]);
    await runAgent(s.opts);
    expect(s.waits).toEqual([7]);
  });

  it('a wait written only in the message text is not read by the core (driver without a parser): normal budget', async () => {
    const script = [new Error('429 Please retry in 37s.'), answer];
    const s = setup(script, [7], new FakeDriver(script));
    await runAgent(s.opts);
    expect(s.waits).toEqual([7]);
  });

  it('an abort during the wait ends the run as aborted, not as an error', async () => {
    const controller = new AbortController();
    const s = setup([new WaitError(37_000), answer]);
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
    const s = setup([new WaitError(37_000), answer]);
    const { sleep: _unused, ...withDefaultSleep } = s.opts;
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const r = await runAgent({ ...withDefaultSleep, signal: controller.signal });
    expect(r.status).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a tool-using run continues normally after a wait', async () => {
    const s = setup([new WaitError(37_000), reply([call('f1', 'finish', { summary: 'done' })])]);
    const r = await runAgent(s.opts);
    expect(s.waits).toEqual([38_000]);
    expect(r.turns).toBe(1);
  });
});
