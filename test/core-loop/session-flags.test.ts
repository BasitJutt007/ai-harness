/**
 * The two loop options an interactive session adds, each with its file-mode twin:
 *   skipShadowBaseline  no shadow-baseline request is built or counted (the repository is never
 *                       front-loaded per message); without it, every turn counts both.
 *   yieldAfterTurn      the caller takes the turn back after a turn's tool calls (a proposal now awaits
 *                       the owner); without it, the loop asks the model again.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../../src/core/context.ts';
import { runAgent, type RunAgentOptions } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { ModelResponse } from '../../src/core/types.ts';
import { call, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, reply, specs, writeTool } from './fakes.ts';

const text = (t: string): ModelResponse => reply([{ type: 'text', text: t }], 'end_turn');

function setup(driver: FakeDriver, over: Partial<RunAgentOptions> = {}) {
  const tools = [writeTool(), finishTool()];
  const { ctx } = fakeCtx({ tools });
  const store = fakeStore(ctx.logs);
  const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: 'jit' });
  let renders = 0;
  const opts: RunAgentOptions = {
    driver,
    ctx,
    store,
    ledger,
    first: firstMessage('Session: repo demo.'),
    system: 'SYSTEM',
    baselineSystem: async () => {
      renders += 1;
      return `SYSTEM\nFRONT-LOADED REPOSITORY ${'x'.repeat(4000)}`;
    },
    tools: specs(tools),
    maxTurns: 5,
    maxOutputTokens: 1000,
    retryDelaysMs: [0],
    sleep: async () => undefined,
    history: [],
    yieldOnText: true,
    message: 'hello',
    ...over,
  };
  return { opts, ledger, renders: () => renders };
}

describe('skipShadowBaseline', () => {
  it('builds and counts no shadow: one count per turn, the front-load is never rendered, baseline = actual', async () => {
    const driver = new FakeDriver([reply([call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]), text('done')]);
    const s = setup(driver, { skipShadowBaseline: true });
    expect((await runAgent(s.opts)).status).toBe('yielded');
    expect(s.renders()).toBe(0);
    expect(driver.counted).toHaveLength(2);
    expect(driver.counted.every((r) => r.system === 'SYSTEM')).toBe(true);
    const t = s.ledger.report().totals;
    expect(t.baseline_input_tokens).toBe(t.actual_input_tokens);
  });

  it('file-mode twin: without it every turn renders the front-load and counts the shadow too', async () => {
    const driver = new FakeDriver([reply([call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]), text('done')]);
    const s = setup(driver);
    expect((await runAgent(s.opts)).status).toBe('yielded');
    expect(s.renders()).toBe(2);
    expect(driver.counted).toHaveLength(4);
    const t = s.ledger.report().totals;
    expect(t.baseline_input_tokens).toBeGreaterThan(t.actual_input_tokens);
  });

  it('is ignored in --baseline mode, where the front-load IS the request', async () => {
    const driver = new FakeDriver([text('hi')]);
    const tools = [writeTool(), finishTool()];
    const { ctx } = fakeCtx({ tools, baseline: true });
    const s = setup(driver, { skipShadowBaseline: true, ctx, store: fakeStore(ctx.logs) });
    await runAgent(s.opts);
    expect(s.renders()).toBe(1);
    expect(driver.requests[0]?.system).toMatch(/FRONT-LOADED REPOSITORY/);
  });
});

describe('yieldAfterTurn', () => {
  it('true after a turn hands the turn back: no further request, status yielded', async () => {
    const history: TranscriptTurn[] = [];
    const driver = new FakeDriver([reply([call('p1', 'write_file', { path: 'src/a.ts', content: 'x' })]), text('never asked')]);
    const s = setup(driver, { history, yieldAfterTurn: () => true });
    const r = await runAgent(s.opts);
    expect(r).toMatchObject({ status: 'yielded', turns: 1 });
    expect(driver.requests).toHaveLength(1);
    // The owner's next message follows that turn's tool results.
    await runAgent({ ...s.opts, message: 'yes', yieldAfterTurn: () => false });
    expect(history[0]?.results?.parts.at(-1)).toEqual({ type: 'text', text: 'yes' });
  });

  it('twin: false (or absent) lets the loop ask the model again', async () => {
    const driver = new FakeDriver([reply([call('p1', 'write_file', { path: 'src/a.ts', content: 'x' })]), text('next')]);
    const s = setup(driver, { yieldAfterTurn: () => false });
    expect(await runAgent(s.opts)).toMatchObject({ status: 'yielded', turns: 2 });
    expect(driver.requests).toHaveLength(2);
  });

  it('is not asked after a reply without tool calls (that already yields)', async () => {
    let asked = 0;
    const s = setup(new FakeDriver([text('hi')]), { yieldAfterTurn: () => (asked += 1) > 0 });
    await runAgent(s.opts);
    expect(asked).toBe(0);
  });
});
