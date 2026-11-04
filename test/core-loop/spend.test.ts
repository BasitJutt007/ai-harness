/**
 * Habit 9 (docs/workflow.md, What breaks): cost blow-ups. The model allowlist refuses a run before its
 * first model turn, a provider that serves another model stops the run, and the spend cap is checked
 * before every request. Each refusal is paired with the legitimate twin.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.ts';
import { runAgent } from '../../src/core/loop.ts';
import { matchesModel, modelAllowed, modelPolicyVerdict, normalizeModel, priceOf, SpendMeter, turnCostUsd } from '../../src/core/spend.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { ModelPolicy, ModelResponse, ToolPlugin } from '../../src/core/types.ts';
import { call, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, reply, specs, writeTool } from './fakes.ts';

const policy: ModelPolicy = loadConfig().models;
const HAIKU = 'claude-haiku-4-5-20251001';

describe('the model allowlist (harness.config.json models.allow)', () => {
  it.each([
    ['claude', 'claude-opus-5-5'],
    ['openai', 'gpt-5.5'],
    ['openai', 'gpt-5.4'],
    ['openai', 'gpt-5.6-luna-pro'],
  ])('refuses %s %s (a driver default or another model of the family), naming the allowlist and the fix', (driver, model) => {
    const v = modelPolicyVerdict(policy, driver, model);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain(`model "${model}" on the ${driver} driver is not on the allowlist`);
      expect(v.reason).toContain('gpt-5.6-luna, claude-haiku-4-5-20251001');
      expect(v.reason).toContain(`HARNESS_${driver.toUpperCase()}_MODEL`);
    }
  });

  it.each(['gpt-5.6-luna', HAIKU, `${HAIKU} (compat, uncached)`, 'gpt-5.6-luna-2026-08-01', 'scripted:users-api.json'])('allows %s, with a price', (model) => {
    const v = modelPolicyVerdict(policy, 'any', model);
    expect(v.ok).toBe(true);
  });

  it('an allowed model without a price is refused: a cap that cannot be computed is no cap', () => {
    const v = modelPolicyVerdict({ allow: ['cheap-model'], prices: {}, maxRunUsd: 1 }, 'x', 'cheap-model');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/has no price .* could not be enforced/);
  });

  it('matches an id, a dated snapshot of it, or a prefix pattern; never a sibling model', () => {
    expect(matchesModel('gpt-5.6-luna', 'gpt-5.6-luna')).toBe(true);
    expect(matchesModel('gpt-5.6-luna', 'gpt-5.6-luna-20260801')).toBe(true);
    expect(matchesModel('gpt-5.6-luna', 'gpt-5.6-luna-pro')).toBe(false);
    expect(matchesModel('scripted:*', 'scripted:a.json')).toBe(true);
    expect(normalizeModel('gpt-5.6-luna (compat)')).toBe('gpt-5.6-luna');
    expect(priceOf(policy, 'scripted:a.json')).toMatchObject({ input: 0, output: 0 });
    expect(modelAllowed(policy, 'claude-opus-5-5 (compat)')).toBe(false);
  });
});

describe('the spend cap', () => {
  const price = { input: 1.25, cachedInput: 0.1, output: 5 };

  it('costs uncached input, cached input and output at their own rates', () => {
    expect(turnCostUsd({ input: 100_000, cached: 90_000, output: 2_000 }, price)).toBeCloseTo(0.0315, 10);
    // Cached tokens never exceed the input they are part of.
    expect(turnCostUsd({ input: 10, cached: 50, output: 0 }, price)).toBeCloseTo(0.000001, 10);
  });

  it('refuses a request whose worst case would pass the cap; the cheap twin may be sent', () => {
    const m = new SpendMeter(0.1, price, HAIKU);
    m.add({ input: 40_000, cached: 0, output: 0 });
    expect(m.spentUsd).toBeCloseTo(0.05, 10);
    expect(m.refuseNext(20_000, 16_000)).toMatch(/spend cap: this run has spent \$0\.0500 on claude-haiku-4-5-20251001; the next request \(20000 input tokens, up to 16000 output\) could cost up to \$0\.1050, which would pass the cap of \$0\.1000/);
    expect(m.refuseNext(1_000, 1_000)).toBeNull();
  });
});

describe('the loop enforces both', () => {
  function loop(responses: ModelResponse[], meter: SpendMeter, allowed: (m: string) => boolean, tools: ToolPlugin<unknown>[]) {
    const { ctx } = fakeCtx({ tools });
    const driver = new FakeDriver(responses);
    const store = fakeStore(ctx.logs);
    const run = runAgent({
      driver,
      ctx,
      store,
      ledger: new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'fake-model', counter: 'chars/4', mode: 'jit' }),
      first: firstMessage(),
      system: 'S',
      baselineSystem: 'S+F',
      tools: specs(tools),
      maxTurns: 10,
      maxOutputTokens: 1000,
      retryDelaysMs: [],
      spend: { meter, allowed },
    });
    return { run, driver, store };
  }
  const usage = (input: number, output: number): ModelResponse['usage'] => ({ inputTokens: input, outputTokens: output, cachedInputTokens: 0 });
  const priced = { input: 1, cachedInput: 0.1, output: 5 };

  it('stops with spend_cap before the request that could pass the cap; nothing more is sent', async () => {
    // A turn reports 4000 input + 500 output = $0.0065; a request's worst case is its own (small) input
    // plus the full 1000-token output budget, about $0.005: the first fits under $0.011, the second would not.
    const meter = new SpendMeter(0.011, priced, 'fake-model');
    const turn = (i: number): ModelResponse => ({ ...reply([call(`c${i}`, 'finish', { summary: 'done' })]), usage: usage(4_000, 500) });
    const { run, driver } = loop([turn(1), turn(2), turn(3), turn(4)], meter, () => true, [finishTool()]);
    const r = await run;
    expect(r.status).toBe('spend_cap');
    expect(r.error).toMatch(/this run has spent \$0\.0065 .* which would pass the cap of \$0\.0110/);
    expect(driver.requests).toHaveLength(1);
    expect(meter.spentUsd).toBeCloseTo(0.0065, 10);
  });

  it('the same run under a cap it fits in is not stopped by it', async () => {
    const meter = new SpendMeter(2, priced, 'fake-model');
    const { run } = loop([{ ...reply([call('c1', 'finish', { summary: 'done' })]), usage: usage(4_000, 500) }], meter, () => true, [finishTool()]);
    expect((await run).status).not.toBe('spend_cap');
  });

  it('a provider serving a model off the allowlist stops the run, and its tool calls are not run', async () => {
    let wrote = false;
    const meter = new SpendMeter(2, priced, 'fake-model');
    const served: ModelResponse = { ...reply([call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]), model: 'gpt-5.4' };
    const { run } = loop([served], meter, (m) => m === 'fake-model', [writeTool(() => { wrote = true; }), finishTool()]);
    const r = await run;
    expect(r.status).toBe('model_refused');
    expect(r.error).toMatch(/served model "gpt-5\.4", which is not on the allowlist \(harness\.config\.json models\.allow\): its 1 tool call\(s\) were not run/);
    expect(wrote).toBe(false);
  });
});
