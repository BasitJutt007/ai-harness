import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NUDGE, runAgent, writtenPaths, type RunAgentOptions } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { GatePlugin, HookPlugin, Message, ToolPlugin, ToolResultPart } from '../../src/core/types.ts';
import {
  bigTool,
  call,
  fakeCtx,
  FakeDriver,
  fakeStore,
  finishTool,
  firstMessage,
  reply,
  specs,
  TEST_SUMMARY,
  writeTool,
} from './fakes.ts';

function setup(opts: {
  script: ConstructorParameters<typeof FakeDriver>[0];
  tools?: ToolPlugin<unknown>[];
  hooks?: HookPlugin[];
  gates?: GatePlugin[];
  baseline?: boolean;
  maxTurns?: number;
}) {
  const tools = opts.tools ?? [writeTool(), finishTool(), bigTool()];
  const { ctx, events, logs } = fakeCtx({
    tools,
    hooks: opts.hooks ?? [],
    gates: opts.gates ?? [],
    ...(opts.baseline === true ? { baseline: true } : {}),
  });
  const store = fakeStore(logs);
  const driver = new FakeDriver(opts.script);
  const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: opts.baseline === true ? 'baseline' : 'jit' });
  const agentOpts: RunAgentOptions = {
    driver,
    ctx,
    store,
    ledger,
    first: firstMessage(),
    system: 'SYSTEM',
    baselineSystem: `SYSTEM\n${'F'.repeat(4000)}`,
    tools: specs(tools),
    maxTurns: opts.maxTurns ?? 10,
    maxOutputTokens: 1000,
    retryDelaysMs: [0, 0, 0],
  };
  return { ctx, events, logs, store, driver, ledger, agentOpts };
}

/** Tool results the model saw for turn n (from the request sent on turn n+1, or the transcript). */
function resultsOf(store: ReturnType<typeof fakeStore>, turn: number): ToolResultPart[] {
  const entry = store.transcript[turn - 1];
  if (typeof entry !== 'object' || entry === null || !('results' in entry) || !Array.isArray(entry.results)) return [];
  return entry.results.filter((p: unknown): p is ToolResultPart => typeof p === 'object' && p !== null && 'type' in p && p.type === 'tool_result');
}

function passGate(): GatePlugin {
  return { kind: 'gate', name: 'tests-green', description: 'g', phases: ['finish'], run: async () => ({ status: 'pass', summary: 'all green' }) };
}

describe('runAgent', () => {
  it('blocked pre-hook: the tool does not run and the model gets the reason', async () => {
    let ran = false;
    const guard: HookPlugin = {
      kind: 'hook',
      name: 'path-guard',
      description: 'g',
      events: ['pre_tool'],
      effects: ['write'],
      run: async () => ({ decision: 'block', reason: 'package.json is read-only' }),
    };
    const s = setup({
      tools: [writeTool(() => { ran = true; }), finishTool()],
      hooks: [guard],
      gates: [passGate()],
      script: [
        reply([call('a', 'write_file', { path: 'package.json', content: '{}' })]),
        reply([call('b', 'finish', { summary: 'done' })]),
      ],
    });
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('done');
    expect(ran).toBe(false);
    const [res] = resultsOf(s.store, 1);
    expect(res).toMatchObject({ callId: 'a', isError: true, content: 'BLOCKED by path-guard: package.json is read-only' });
    expect(s.ctx.state.written.size).toBe(0);
  });

  it('invalid input is rejected before hooks run', async () => {
    let hookCalls = 0;
    const spy: HookPlugin = { kind: 'hook', name: 'spy', description: 's', events: ['pre_tool'], run: async () => { hookCalls += 1; return { decision: 'pass' }; } };
    const s = setup({ hooks: [spy], script: [reply([call('a', 'write_file', { path: 3 })])], maxTurns: 1 });
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('max_turns');
    expect(hookCalls).toBe(0);
    const [res] = resultsOf(s.store, 1);
    expect(res?.isError).toBe(true);
    expect(res?.content).toMatch(/^invalid input for write_file: path: .*; content: /);
  });

  it('unknown tool lists the available tools', async () => {
    const s = setup({ script: [reply([call('a', 'git_push', {})])], maxTurns: 1 });
    await runAgent(s.agentOpts);
    const [res] = resultsOf(s.store, 1);
    expect(res?.content).toBe('unknown tool "git_push". Available tools: write_file, finish, run_tests');
    expect(res?.isError).toBe(true);
  });

  it('finish is refused while gates fail, then accepted', async () => {
    let attempts = 0;
    const gate: GatePlugin = {
      kind: 'gate',
      name: 'tests-green',
      description: 'g',
      phases: ['finish'],
      run: async () => {
        attempts += 1;
        return attempts === 1
          ? { status: 'fail', summary: '1 failed', details: ['FAIL test/users.test.ts > returns 409'] }
          : { status: 'pass', summary: '12 passed' };
      },
    };
    const s = setup({
      gates: [gate],
      script: [
        reply([call('a', 'finish', { summary: 'done?' })]),
        reply([call('b', 'write_file', { path: 'src/a.ts', content: 'x' })]),
        reply([call('c', 'finish', { summary: 'done' }), call('d', 'write_file', { path: 'src/b.ts', content: 'y' })]),
      ],
    });
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('done');
    expect(r.turns).toBe(3);
    expect(r.finish?.ok).toBe(true);
    const [refused] = resultsOf(s.store, 1);
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toMatch(/^FINISH REFUSED/);
    expect(refused?.content).toContain('FAIL test/users.test.ts > returns 409');
    const [accepted, skipped] = resultsOf(s.store, 3);
    expect(accepted?.content).toMatch(/^FINISH ACCEPTED/);
    expect(skipped?.content).toMatch(/skipped/);
    expect(s.ctx.state.finishAttempts).toBe(2);
    expect([...s.ctx.state.written]).toEqual(['src/a.ts']);
  });

  it('three idle turns → stalled, with nudges in between', async () => {
    const s = setup({
      script: [
        reply([{ type: 'text', text: 'thinking' }], 'end_turn'),
        reply([{ type: 'text', text: 'still thinking' }], 'end_turn'),
        reply([{ type: 'text', text: 'done!' }], 'end_turn'),
      ],
    });
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('stalled');
    expect(r.turns).toBe(3);
    const third = s.driver.requests[2];
    const nudges = (third?.messages ?? []).filter((m: Message) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === NUDGE));
    expect(nudges).toHaveLength(2);
  });

  it('a tool call resets the idle counter', async () => {
    const s = setup({
      script: [
        reply([{ type: 'text', text: 'a' }], 'end_turn'),
        reply([{ type: 'text', text: 'b' }], 'end_turn'),
        reply([call('x', 'run_tests', {})]),
        reply([{ type: 'text', text: 'c' }], 'end_turn'),
      ],
      maxTurns: 4,
    });
    expect((await runAgent(s.agentOpts)).status).toBe('max_turns');
  });

  it('refusal stops the run as refused', async () => {
    const s = setup({ script: [reply([{ type: 'text', text: 'I cannot help with that.' }], 'refusal')] });
    const r = await runAgent(s.agentOpts);
    expect(r).toMatchObject({ status: 'refused', turns: 1 });
  });

  it('retries driver.complete on thrown errors, then reports error honestly', async () => {
    const ok = setup({ script: [new Error('503'), new Error('overloaded'), reply([call('b', 'finish', { summary: 'd' })])], gates: [passGate()] });
    expect((await runAgent(ok.agentOpts)).status).toBe('done');
    expect(ok.events.filter((e) => e.kind === 'error')).toHaveLength(2);

    const bad = setup({ script: [new Error('a'), new Error('b'), new Error('c'), new Error('d')] });
    const r = await runAgent(bad.agentOpts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/after 4 attempts: d/);
    expect(bad.driver.requests).toHaveLength(4);
  });

  it('JIT: compact returns to the model, raw to logs + baseline; tokens recorded per turn', async () => {
    const s = setup({
      script: [
        reply([call('a', 'run_tests', {})]),
        reply([call('b', 'run_tests', {})]),
        reply([call('c', 'run_tests', {})]),
        reply([call('d', 'run_tests', {})]),
      ],
      maxTurns: 4,
    });
    await runAgent(s.agentOpts);
    // the model saw the compact summary
    const req2 = s.driver.requests[1];
    expect(req2?.system).toBe('SYSTEM');
    const seen = req2?.messages[2]?.parts[0];
    expect(seen?.type === 'tool_result' ? seen.content : '').toBe(TEST_SUMMARY);
    // raw > 2 KB went to the logs
    expect(s.logs.written).toHaveLength(4);
    expect(s.logs.written[0]?.content).toBe('R'.repeat(5000));
    // baseline request (counted) carried the raw output and the front-load
    const baselineReqs = s.driver.counted.filter((r) => r.system.startsWith('SYSTEM\nF'));
    expect(baselineReqs).toHaveLength(4);
    const raw = baselineReqs[1]?.messages[2]?.parts[0];
    expect(raw?.type === 'tool_result' ? raw.content : '').toBe('R'.repeat(5000));
    // ledger
    const rep = s.ledger.report();
    expect(rep.turns).toHaveLength(4);
    for (const t of rep.turns) expect(t.baseline_input_tokens).toBeGreaterThan(t.actual_input_tokens);
    expect(rep.attribution_chars.front_load_avoided).toBe(4 * 4001);
    expect(rep.attribution_chars.raw_returns_avoided).toBeGreaterThan(0);
    expect(rep.attribution_chars.history_compacted).toBeGreaterThan(0);
    // transcript: one line per turn, raw-map keys only
    expect(s.store.transcript).toHaveLength(4);
    expect(JSON.stringify(s.store.transcript)).not.toContain('R'.repeat(3000));
    expect(s.store.transcript[0]).toMatchObject({ turn: 1, rawKeys: ['a'], logs: { a: 'runs/test/logs/001-t1-run_tests.txt' } });
    expect(s.store.json.has('state.json')).toBe(true);
  });

  it('baseline mode: the actual request IS the baseline and is counted once', async () => {
    const s = setup({ baseline: true, script: [reply([call('a', 'run_tests', {})]), reply([call('b', 'run_tests', {})])], maxTurns: 2 });
    await runAgent(s.agentOpts);
    expect(s.driver.counted).toHaveLength(2);
    expect(s.driver.requests[0]?.system.startsWith('SYSTEM\nF')).toBe(true);
    const seen = s.driver.requests[1]?.messages[2]?.parts[0];
    expect(seen?.type === 'tool_result' ? seen.content : '').toBe('R'.repeat(5000));
    for (const t of s.ledger.report().turns) {
      expect(t.actual_input_tokens).toBe(t.baseline_input_tokens);
      expect(t.reduction_pct).toBe(0);
    }
  });

  it('a throwing tool becomes an error result; hook notes are appended', async () => {
    const boom: ToolPlugin<unknown> = {
      kind: 'tool', name: 'plan', description: 'p', effect: 'control',
      input: (await import('zod')).z.object({}),
      run: async () => { throw new Error('disk full'); },
    };
    const noter: HookPlugin = { kind: 'hook', name: 'observer', description: 'o', events: ['post_tool'], run: async () => ({ decision: 'record', note: 'remember tests' }) };
    const s = setup({ tools: [boom], hooks: [noter], script: [reply([call('a', 'plan', {})])], maxTurns: 1 });
    await runAgent(s.agentOpts);
    const [res] = resultsOf(s.store, 1);
    expect(res?.isError).toBe(true);
    expect(res?.content).toBe('tool plan failed: disk full\n[observer] remember tests');
  });

  it('abort (Ctrl-C) mid-turn: remaining calls are skipped, the loop ends aborted and state is persisted', async () => {
    const controller = new AbortController();
    let writes = 0;
    const s = setup({
      tools: [writeTool(() => { writes += 1; }), finishTool()],
      script: [
        reply([call('a', 'write_file', { path: 'test/a.test.ts', content: 'x' })]),
        () => {
          controller.abort();
          return reply([call('b', 'write_file', { path: 'test/b.test.ts', content: 'y' })]);
        },
        reply([call('c', 'write_file', { path: 'test/c.test.ts', content: 'z' })]),
      ],
    });
    const r = await runAgent({ ...s.agentOpts, signal: controller.signal });
    expect(r.status).toBe('aborted');
    expect(r.turns).toBe(2);
    expect(writes).toBe(1);
    expect(resultsOf(s.store, 2)[0]?.content).toBe('skipped: the run was aborted');
    expect(s.driver.requests).toHaveLength(2);
    expect(s.store.json.has('state.json')).toBe(true);
    expect(s.events.some((e) => e.source === 'loop' && /aborted/.test(e.message))).toBe(true);
  });

  it('abort while driver.complete is in flight: no retry, status aborted', async () => {
    const controller = new AbortController();
    const s = setup({
      script: [
        () => {
          controller.abort();
          throw new Error('request aborted');
        },
      ],
    });
    const r = await runAgent({ ...s.agentOpts, signal: controller.signal });
    expect(r.status).toBe('aborted');
    expect(r.turns).toBe(0);
    expect(s.driver.requests).toHaveLength(1);
  });

  it('an already-aborted signal never calls the driver', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = setup({ script: [reply([call('a', 'run_tests', {})])] });
    const r = await runAgent({ ...s.agentOpts, signal: controller.signal });
    expect(r).toMatchObject({ status: 'aborted', turns: 0 });
    expect(s.driver.requests).toHaveLength(0);
  });
});

describe('runAgent: written paths and raw logs', () => {
  const bigRead: ToolPlugin<unknown> = {
    kind: 'tool',
    name: 'read_file',
    description: 'read a file',
    input: z.object({ path: z.string() }),
    effect: 'read',
    async run() {
      return { ok: true, summary: 'read 1 file', raw: 'L'.repeat(5000) };
    },
  };
  const canonicalWrite: ToolPlugin<unknown> = {
    kind: 'tool',
    name: 'write_canonical',
    description: 'write a file and report the path written',
    input: z.object({ path: z.string() }),
    effect: 'write',
    paths: (i) => [(i as { path: string }).path],
    async run() {
      return { ok: true, summary: 'wrote', raw: 'W'.repeat(5000), data: { path: 'src/users.ts' } };
    },
  };
  const plainWrite: ToolPlugin<unknown> = {
    kind: 'tool',
    name: 'write_plain',
    description: 'write without reporting a path',
    input: z.object({ path: z.string() }),
    effect: 'write',
    paths: (i) => [(i as { path: string }).path],
    async run() {
      return { ok: true, summary: 'wrote' };
    },
  };

  it('state.written holds canonical API-relative paths; only exec/write tools get raw logs', async () => {
    const tools = [bigRead, canonicalWrite, plainWrite, bigTool(), finishTool()];
    const s = setup({
      tools,
      gates: [passGate()],
      script: [
        reply([call('r', 'read_file', { path: 'src/users.ts' }), call('w', 'write_canonical', { path: './src//users.ts' })]),
        reply([call('p', 'write_plain', { path: '/tmp/r/api/src/orders.ts' }), call('q', 'write_plain', { path: '../escape.ts' })]),
        reply([call('t', 'run_tests', {})]),
        reply([call('f', 'finish', { summary: 'done' })]),
      ],
    });
    // a workspace that normalises like the real one: absolute or ./-prefixed → API-relative; escapes throw
    s.ctx.workspace = {
      ...s.ctx.workspace,
      rel: (p: string) => {
        const stripped = p.startsWith('/tmp/r/api/') ? p.slice('/tmp/r/api/'.length) : p;
        const norm = posix.normalize(stripped).replace(/^\.\//, '');
        if (norm.startsWith('..')) throw new Error(`escapes the API root: ${p}`);
        return norm;
      },
    };
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('done');
    expect([...s.ctx.state.written].sort()).toEqual(['src/orders.ts', 'src/users.ts']);
    // the big read was not logged; the big write and the exec were
    expect(s.logs.written.map((l) => l.name)).toEqual(['t1-write_canonical', 't3-run_tests']);
    // the transcript records the model that served each turn
    for (const entry of s.store.transcript) expect(entry).toMatchObject({ model: 'fake-model' });
  });

  it('writtenPaths prefers data.path/data.paths and drops paths outside the API root', () => {
    const ws = { workspace: { ...fakeCtx().ctx.workspace, rel: (p: string) => { if (p.startsWith('..')) throw new Error('escape'); return p.replace(/^\.\//, ''); } } };
    expect(writtenPaths({ ok: true, summary: '', data: { paths: ['./a.ts', '../b.ts', 3] } }, ['x.ts'], ws)).toEqual(['a.ts']);
    expect(writtenPaths({ ok: true, summary: '' }, ['./x.ts', 'x.ts'], ws)).toEqual(['x.ts']);
    expect(writtenPaths({ ok: true, summary: '', data: 'nope' }, ['y.ts'], ws)).toEqual(['y.ts']);
  });
});
