/**
 * Session use of the loop (all opt-in): a caller-owned history that continues across calls, the
 * owner's next message, a text reply that hands the turn back ('yielded'), folded turns that keep the
 * conversation (keepChat), and live text (onText: Driver.stream, else the whole reply once). Each
 * behaviour has its file-mode twin: without the option the loop does what it always did.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIGEST_HEADER, DIGEST_HEADER_CHAT, digestTurn, jitView, proseLine, type TranscriptTurn } from '../../src/core/context.ts';
import { NUDGE, runAgent, type RunAgentOptions } from '../../src/core/loop.ts';
import { buildContext } from '../../src/core/run.ts';
import { newRunState, RunStore } from '../../src/core/run-store.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { DriverErrorKind, Message, ModelRequest, ModelResponse, RunEvent, ToolPlugin } from '../../src/core/types.ts';
import { call, CONFIG, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, GREENFIELD, reply, specs, writeTool } from './fakes.ts';

const text = (t: string): ModelResponse => reply([{ type: 'text', text: t }], 'end_turn');

/** A FakeDriver that can stream: each text part goes out in 3-character deltas, then the same response. */
class StreamingDriver extends FakeDriver {
  readonly streamed: ModelRequest[] = [];
  async stream(req: ModelRequest, signal: AbortSignal | undefined, onDelta: (t: string) => void): Promise<ModelResponse> {
    this.streamed.push(req);
    const res = await this.complete(req);
    for (const p of res.parts) if (p.type === 'text') for (let i = 0; i < p.text.length; i += 3) onDelta(p.text.slice(i, i + 3));
    return res;
  }
}

class Flaky extends Error {}

/** Streams a partial reply, then fails, on its first call; classifies nothing (an ordinary retried failure). */
class InterruptedStream extends StreamingDriver {
  private failed = false;
  override async stream(req: ModelRequest, signal: AbortSignal | undefined, onDelta: (t: string) => void): Promise<ModelResponse> {
    if (!this.failed) {
      this.failed = true;
      onDelta('Hel');
      throw new Flaky('connection reset mid-stream');
    }
    return super.stream(req, signal, onDelta);
  }
  errorKind(): DriverErrorKind | null {
    return null;
  }
}

function setup(script: ConstructorParameters<typeof FakeDriver>[0], over: Partial<RunAgentOptions> & { tools?: ToolPlugin<unknown>[]; driver?: FakeDriver } = {}) {
  const tools = over.tools ?? [writeTool(), finishTool()];
  const { ctx, events, logs } = fakeCtx({ tools });
  const store = fakeStore(logs);
  const driver = over.driver ?? new FakeDriver(script);
  const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: 'jit' });
  const { tools: _t, driver: _d, ...rest } = over;
  const opts: RunAgentOptions = {
    driver,
    ctx,
    store,
    ledger,
    first: firstMessage('Session: repo demo, branch fix/x.'),
    system: 'SYSTEM',
    baselineSystem: 'SYSTEM',
    tools: specs(tools),
    maxTurns: 10,
    maxOutputTokens: 1000,
    retryDelaysMs: [0, 0, 0],
    sleep: async () => undefined,
    ...rest,
  };
  return { ctx, events, store, driver, opts };
}

function texts(m: Message): string[] {
  return m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));
}

describe('yieldOnText', () => {
  it('a reply without a tool call ends the call as yielded: no nudge, one turn', async () => {
    const s = setup([text('Hi! I can read this repo and change it under your gates.')], { yieldOnText: true });
    const r = await runAgent(s.opts);
    expect(r.status).toBe('yielded');
    expect(r.turns).toBe(1);
    expect(s.driver.requests).toHaveLength(1);
    expect(s.store.transcript).toHaveLength(1);
    expect(s.store.transcript[0]).toMatchObject({ turn: 1, results: null });
  });

  it('file-mode twin: without yieldOnText the same reply is nudged and counted toward a stall', async () => {
    const s = setup([text('a'), text('b'), text('c')]);
    const r = await runAgent(s.opts);
    expect(r.status).toBe('stalled');
    expect(s.driver.requests[1]?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: NUDGE }]);
  });

  it('a cut-off text reply still yields, and says so', async () => {
    const s = setup([reply([{ type: 'text', text: 'long answer…' }], 'max_tokens')], { yieldOnText: true });
    const r = await runAgent(s.opts);
    expect(r.status).toBe('yielded');
    expect(s.events.some((e) => /cut off at the output limit/.test(e.message))).toBe(true);
  });
});

describe('history and the next message', () => {
  it('the conversation continues across calls: turn numbers continue, the new message follows the last reply, the prefix is kept', async () => {
    const history: TranscriptTurn[] = [];
    const driver = new FakeDriver([
      text('Hi! What should I change?'),
      reply([call('c1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      text('Done: src/a.ts written.'),
    ]);
    const s = setup([], { driver, history, yieldOnText: true, message: 'hello' });
    const r1 = await runAgent(s.opts);
    expect(r1).toMatchObject({ status: 'yielded', turns: 1 });
    expect(texts(s.opts.first)).toEqual(['Session: repo demo, branch fix/x.', 'hello']);
    expect(history.map((t) => t.turn)).toEqual([1]);

    const r2 = await runAgent({ ...s.opts, message: 'write src/a.ts' });
    expect(r2).toMatchObject({ status: 'yielded', turns: 2 });
    expect(history.map((t) => t.turn)).toEqual([1, 2, 3]);
    expect(s.ctx.state.turn).toBe(3);
    // The second call's first request: the first request + the reply + the owner's new message.
    const firstReq = driver.requests[0]?.messages ?? [];
    const second = driver.requests[1]?.messages ?? [];
    expect(second.slice(0, firstReq.length)).toEqual(firstReq);
    expect(second.slice(firstReq.length)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', text: 'Hi! What should I change?' }] },
      { role: 'user', parts: [{ type: 'text', text: 'write src/a.ts' }] },
    ]);
    // Every owner message is in transcript.jsonl, after the turn it follows (0 = before the first).
    expect(s.store.transcript.filter((e) => typeof e === 'object' && e !== null && 'user' in e)).toEqual([
      { turn: 0, user: [{ type: 'text', text: 'hello' }] },
      { turn: 1, user: [{ type: 'text', text: 'write src/a.ts' }] },
    ]);
  });

  it('the turn limit applies per call, not to the whole conversation', async () => {
    const history: TranscriptTurn[] = [];
    const writes = Array.from({ length: 6 }, (_, n) => reply([call(`w${n}`, 'write_file', { path: `src/${n}.ts`, content: 'x' })]));
    const s = setup([...writes], { history, yieldOnText: true, maxTurns: 3, message: 'go' });
    expect(await runAgent(s.opts)).toMatchObject({ status: 'max_turns', turns: 3 });
    expect(await runAgent({ ...s.opts, message: 'keep going' })).toMatchObject({ status: 'max_turns', turns: 3 });
    expect(history.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a message after a turn that ended on tool results follows those results', async () => {
    const history: TranscriptTurn[] = [];
    const s = setup([reply([call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]), text('ok')], { history, yieldOnText: true, maxTurns: 1, message: 'start' });
    expect((await runAgent(s.opts)).status).toBe('max_turns');
    await runAgent({ ...s.opts, message: 'and now?' });
    const parts = history[0]?.results?.parts ?? [];
    expect(parts[0]).toMatchObject({ type: 'tool_result', callId: 'w1' });
    expect(parts[1]).toEqual({ type: 'text', text: 'and now?' });
  });

  it('a message is kept in the history even when its request fails', async () => {
    const history: TranscriptTurn[] = [];
    const driver = new FakeDriver([text('hi'), new Error('down'), new Error('down'), new Error('down'), new Error('down')]);
    const s = setup([], { driver, history, yieldOnText: true, message: 'hello' });
    await runAgent(s.opts);
    const r = await runAgent({ ...s.opts, message: 'are you there?' });
    expect(r.status).toBe('error');
    expect(r.turns).toBe(0);
    expect(history[0]?.results?.parts).toEqual([{ type: 'text', text: 'are you there?' }]);
  });
});

describe('keepChat: folded turns keep the conversation', () => {
  function chatTurns(): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    for (let n = 1; n <= 5; n += 1) {
      turns.push({
        turn: n,
        assistant: { role: 'assistant', parts: [{ type: 'text', text: `assistant says ${n}\nsecond line ${n}` }, ...(n % 2 === 0 ? [{ type: 'tool_call' as const, id: `c${n}`, name: 'read_file', input: { path: `src/${n}.ts` } }] : [])] },
        results: { role: 'user', parts: [...(n % 2 === 0 ? [{ type: 'tool_result' as const, callId: `c${n}`, content: `src/${n}.ts (lines 1-1 of 1)\n1| x`, isError: false }] : []), { type: 'text' as const, text: `user says ${n}` }] },
        raw: {},
      });
    }
    return turns;
  }

  it('prose and user messages of folded turns stay verbatim, in order, around the tool lines', () => {
    const view = jitView(firstMessage('open'), chatTurns(), 2, true, { keepChat: true });
    const digest = texts(view[0] as Message)[1] ?? '';
    expect(digest.startsWith(DIGEST_HEADER_CHAT)).toBe(true);
    expect(digest).toContain(['t2 assistant: assistant says 2', '  second line 2', 't2 read_file path=src/2.ts -> src/2.ts (lines 1-1 of 1)', 't2 user: user says 2'].join('\n'));
    for (const n of [1, 2, 3]) expect(digest).toContain(`t${n} user: user says ${n}`);
    // the two recent turns are structured messages, not digest lines
    expect(digest).not.toContain('user says 4');
    expect(view.slice(1).map((m) => texts(m)).flat()).toContain('user says 5');
  });

  it('file-mode twin: without keepChat the prose is dropped with its turn', () => {
    const view = jitView(firstMessage('open'), chatTurns(), 2, true);
    const digest = texts(view[0] as Message)[1] ?? '';
    expect(digest.startsWith(DIGEST_HEADER)).toBe(true);
    expect(digest).not.toMatch(/says/);
    expect(digestTurn(chatTurns()[0] as TranscriptTurn)).toEqual(['t1 (no tool call)']);
  });

  it('the digest only grows at its end as more turns fold (the request prefix stays stable)', () => {
    const turns = chatTurns();
    const at4 = texts(jitView(firstMessage('open'), turns.slice(0, 4), 2, true, { keepChat: true })[0] as Message)[1] ?? '';
    const at5 = texts(jitView(firstMessage('open'), turns, 2, true, { keepChat: true })[0] as Message)[1] ?? '';
    expect(at5.startsWith(at4)).toBe(true);
    expect(proseLine(9, 'user', 'a\r\nb\n')).toBe('t9 user: a\n  b');
  });

  it('the loop keeps the conversation by default in session use; keepChat false folds it away', async () => {
    const converse = async (keepChat?: boolean): Promise<string> => {
      const history: TranscriptTurn[] = [];
      const replies = ['one', 'two', 'three', 'four'].map((w) => text(`reply ${w}`));
      const s = setup(replies, { history, yieldOnText: true, message: 'm0', ...(keepChat !== undefined ? { keepChat } : {}) });
      await runAgent(s.opts);
      for (const m of ['m1', 'm2', 'm3']) await runAgent({ ...s.opts, message: m });
      return (s.driver.requests.at(-1)?.messages ?? []).flatMap(texts).join('\n');
    };
    const kept = await converse();
    for (const w of ['m0', 'reply one', 'm1', 'reply two', 'm2', 'reply three', 'm3']) expect(kept).toContain(w);
    const folded = await converse(false);
    expect(folded).not.toContain('reply one');
    expect(folded).not.toContain('m1');
    expect(folded).toContain('m3');
  });
});

describe('onText: live text', () => {
  it('a driver that streams delivers each delta in order; the reply is the one complete() would give', async () => {
    const driver = new StreamingDriver([text('Hello there, owner.')]);
    const seen: Array<{ d: string; turn: number; attempt: number }> = [];
    const s = setup([], { driver, yieldOnText: true, onText: (d, info) => seen.push({ d, ...info }) });
    expect((await runAgent(s.opts)).status).toBe('yielded');
    expect(driver.streamed).toHaveLength(1);
    expect(seen.map((x) => x.d).join('')).toBe('Hello there, owner.');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((x) => x.turn === 1 && x.attempt === 1)).toBe(true);
    expect(s.store.transcript[0]).toMatchObject({ assistant: [{ type: 'text', text: 'Hello there, owner.' }] });
  });

  it('a driver that cannot stream: complete(), then the whole text once', async () => {
    const seen: string[] = [];
    const s = setup([reply([{ type: 'text', text: 'Reading it. ' }, call('w', 'write_file', { path: 'src/a.ts', content: 'x' })]), text('Done.')], { yieldOnText: true, onText: (d) => seen.push(d) });
    await runAgent(s.opts);
    expect(seen).toEqual(['Reading it. ', 'Done.']);
  });

  it('without onText a streaming driver is never asked to stream (file mode)', async () => {
    const driver = new StreamingDriver([reply([call('f', 'finish', { summary: 'x' })])]);
    const s = setup([], { driver });
    await runAgent(s.opts);
    expect(driver.streamed).toHaveLength(0);
    expect(driver.requests.length).toBeGreaterThan(0);
  });

  it('a stream that fails mid-reply is retried like complete(); the retry is a new attempt', async () => {
    const driver = new InterruptedStream([text('Hello')]);
    const seen: Array<{ d: string; attempt: number }> = [];
    const s = setup([], { driver, yieldOnText: true, onText: (d, info) => seen.push({ d, attempt: info.attempt }) });
    const r = await runAgent(s.opts);
    expect(r.status).toBe('yielded');
    expect(seen[0]).toEqual({ d: 'Hel', attempt: 1 });
    expect(seen.slice(1).every((x) => x.attempt === 2)).toBe(true);
    expect(seen.slice(1).map((x) => x.d).join('')).toBe('Hello');
    expect(s.events.some((e) => e.kind === 'error' && /attempt 1\): connection reset mid-stream/.test(e.message))).toBe(true);
  });

  it('a listener that throws never stops the run (reported once)', async () => {
    const driver = new StreamingDriver([text('abcdefghi')]);
    const s = setup([], { driver, yieldOnText: true, onText: () => { throw new Error('tty gone'); } });
    expect((await runAgent(s.opts)).status).toBe('yielded');
    expect(s.events.filter((e) => /onText listener failed: tty gone/.test(e.message))).toHaveLength(1);
  });
});

describe('buildContext onEvent', () => {
  it('every RunEvent reaches the listener after it is recorded; a throwing listener loses nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onevent-'));
    try {
      const store = new RunStore(join(dir, 'run'), dir);
      const state = newRunState();
      const seen: RunEvent[] = [];
      const base = fakeCtx().ctx;
      const mk = (onEvent: (e: RunEvent) => void) =>
        buildContext({ run: base.run, task: GREENFIELD, ws: base.workspace, state, store, mode: base.mode, config: CONFIG, registry: base.registry, onEvent });
      const ctx = mk((e) => {
        expect(state.events).toContain(e);
        seen.push(e);
      });
      ctx.emit({ kind: 'note', source: 'test', message: 'one' });
      ctx.emit({ kind: 'tool', source: 'read_file', decision: 'pass', message: 'two' });
      expect(seen.map((e) => e.message)).toEqual(['one', 'two']);
      mk(() => {
        throw new Error('display crashed');
      }).emit({ kind: 'note', source: 'test', message: 'three' });
      const lines = readFileSync(join(dir, 'run', 'events.jsonl'), 'utf8').trim().split('\n');
      expect(lines.map((l) => (JSON.parse(l) as RunEvent).message)).toEqual(['one', 'two', 'three']);
      expect(mk(() => undefined).inPlace).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
