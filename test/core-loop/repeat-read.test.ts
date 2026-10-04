/**
 * Repeated-read pointer (real-model finding F1, thrashing): a read whose freshly executed,
 * compact result is byte-identical to the result of an identical call (canonical input) that the
 * next request still shows is answered with a short pointer instead of a second copy. The read
 * always runs: "unchanged" is never inferred from tool history, so a change made earlier in the
 * same turn, or by agent code during a test run, always yields the full content. The raw
 * (baseline) return stays full, and baseline mode never points.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { repeatPointer } from '../../src/core/context.ts';
import { canonicalJson, findRepeat, runAgent, type RunAgentOptions } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { Message, ModelRequest, Part, ToolCallPart, ToolPlugin, ToolResultPart } from '../../src/core/types.ts';
import { call, fakeCtx, FakeDriver, fakeStore, firstMessage, reply, specs } from './fakes.ts';

/** In-memory files behind a read tool, a write tool and an exec tool whose "agent code" edits a file. */
function fileTools(files: Map<string, string>, readOpts: { fetcher?: boolean } = {}): ToolPlugin<unknown>[] {
  const read: ToolPlugin<{ path: string; startLine?: number }> = {
    kind: 'tool',
    name: 'read_file',
    description: 'read',
    input: z.object({ path: z.string(), startLine: z.number().optional() }),
    effect: 'read',
    ...readOpts,
    async run(i) {
      const c = files.get(i.path);
      if (c === undefined) return { ok: false, summary: `read_file: ${i.path} does not exist` };
      const lines = c.split('\n');
      const summary = [`${i.path} (lines 1-${lines.length} of ${lines.length})`, ...lines.map((l, n) => `${n + 1}| ${l}`)].join('\n');
      return { ok: true, summary, raw: `RAW ${summary}` };
    },
  };
  const write: ToolPlugin<{ path: string; content: string }> = {
    kind: 'tool',
    name: 'write_file',
    description: 'write',
    input: z.object({ path: z.string(), content: z.string() }),
    effect: 'write',
    paths: (i) => [i.path],
    async run(i) {
      files.set(i.path, i.content);
      return { ok: true, summary: `wrote ${i.path}` };
    },
  };
  const tests: ToolPlugin<Record<string, never>> = {
    kind: 'tool',
    name: 'run_tests',
    description: 'tests (agent code may write files under the API root)',
    input: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    effect: 'exec',
    async run() {
      files.set('src/a.ts', `${files.get('src/a.ts') ?? ''}\n// touched by a test`);
      return { ok: true, summary: 'tests: 1 passed (1)' };
    },
  };
  return [read, write, tests].map((t) => t as ToolPlugin<unknown>);
}

const A = 'export const a = 1;\nexport function f(): number {\n  return a;\n}';

/** `fetcher: false`: the read tool declares itself no context fetcher (kept in the baseline). */
function setup(script: Part[][], opts: { baseline?: boolean; fetcher?: boolean } = {}) {
  const files = new Map([['src/a.ts', A]]);
  const tools = fileTools(files, opts.fetcher === undefined ? {} : { fetcher: opts.fetcher });
  const { ctx, events, logs } = fakeCtx({ tools, ...(opts.baseline === true ? { baseline: true } : {}) });
  const store = fakeStore(logs);
  const driver = new FakeDriver(script.map((parts) => reply(parts)));
  const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: opts.baseline === true ? 'baseline' : 'jit' });
  const agentOpts: RunAgentOptions = {
    driver, ctx, store, ledger,
    first: firstMessage(),
    system: 'SYSTEM',
    baselineSystem: 'SYSTEM+FRONTLOAD',
    tools: specs(tools),
    maxTurns: script.length,
    maxOutputTokens: 1000,
    retryDelaysMs: [],
  };
  return { files, events, store, driver, agentOpts };
}

/** Model-visible result of call `id` in the request sent for turn `n` (1-based). */
function seen(driver: FakeDriver, n: number, id: string): string | undefined {
  const req = driver.requests[n - 1];
  for (const m of req?.messages ?? []) for (const p of m.parts) if (p.type === 'tool_result' && p.callId === id) return p.content;
  return undefined;
}

/** The result of call `id` in the BASELINE request counted for turn `n`. */
function baselineSeen(driver: FakeDriver, n: number, id: string): string | undefined {
  const req: ModelRequest | undefined = driver.counted.filter((r) => r.system === 'SYSTEM+FRONTLOAD')[n - 1];
  for (const m of req?.messages ?? []) for (const p of m.parts) if (p.type === 'tool_result' && p.callId === id) return p.content;
  return undefined;
}

const readA = (id: string, extra: Record<string, unknown> = {}): Part => call(id, 'read_file', { path: 'src/a.ts', ...extra });
const FULL = /^src\/a\.ts \(lines 1-\d+ of \d+\)\n1\| export const a = 1;/;

describe('canonicalJson / findRepeat', () => {
  it('is key-order independent and distinguishes values', () => {
    expect(canonicalJson({ path: 'a', startLine: 1 })).toBe(canonicalJson({ startLine: 1, path: 'a' }));
    expect(canonicalJson({ a: [1, { y: 2, x: 1 }] })).toBe('{"a":[1,{"x":1,"y":2}]}');
    expect(canonicalJson({ path: 'a', startLine: 1 })).not.toBe(canonicalJson({ path: 'a', startLine: 2 }));
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('matches only the same tool, the same canonical input, a successful result and the same content', () => {
    const c = (id: string, name: string, input: unknown): ToolCallPart => ({ type: 'tool_call', id, name, input });
    const r = (callId: string, content: string, isError = false): ToolResultPart => ({ type: 'tool_result', callId, content, isError });
    const visible = [
      { turn: 3, call: c('x', 'read_file', { path: 'a', startLine: 1 }), result: r('x', 'A'), content: 'A' },
      { turn: 4, call: c('y', 'outline', { path: 'a' }), result: r('y', 'O'), content: 'O' },
      { turn: 4, call: c('z', 'read_file', { path: 'b' }), result: r('z', 'err', true), content: 'err' },
    ];
    expect(findRepeat(c('n', 'read_file', { startLine: 1, path: 'a' }), 'A', visible, 3)).toEqual({ turn: 3, source: { turn: 3, callId: 'x' } });
    expect(findRepeat(c('n', 'read_file', { path: 'a', startLine: 1 }), 'A changed', visible, 3)).toBeNull();
    expect(findRepeat(c('n', 'outline', { path: 'a', startLine: 1 }), 'A', visible, 3)).toBeNull();
    expect(findRepeat(c('n', 'read_file', { path: 'b' }), 'err', visible, 3)).toBeNull();
  });
});

describe('repeated reads in the loop (JIT)', () => {
  it('an identical read whose content is unchanged gets a pointer; the shadow baseline never sees a pointer', async () => {
    const s = setup([[readA('r1')], [readA('r2')], [call('n3', 'run_tests', {})]]);
    const second = s.driver;
    await runAgent(s.agentOpts);
    expect(seen(second, 2, 'r1')).toMatch(FULL);
    expect(seen(second, 3, 'r2')).toBe(repeatPointer('read_file', 1));
    expect(seen(second, 3, 'r2')).toBe('unchanged since t1: identical to that read_file result, still in your context above');
    // read_file is a context fetcher: the shadow baseline leaves its calls out (a baseline harness front-loads the file)
    expect(baselineSeen(second, 3, 'r1')).toBeUndefined();
    expect(baselineSeen(second, 3, 'r2')).toBeUndefined();
    expect(s.events.some((e) => e.kind === 'note' && /answered with a pointer/.test(e.message))).toBe(true);
  });

  it('a read tool that is no context fetcher stays in the shadow baseline with its full raw return, never a pointer', async () => {
    const s = setup([[readA('r1')], [readA('r2')], [call('n3', 'run_tests', {})]], { fetcher: false });
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toBe(repeatPointer('read_file', 1));
    expect(baselineSeen(s.driver, 3, 'r1')).toMatch(/^RAW src\/a\.ts/);
    expect(baselineSeen(s.driver, 3, 'r2')).toMatch(/^RAW src\/a\.ts/);
  });

  it('key order does not matter (canonical input)', async () => {
    const s = setup([[call('r1', 'read_file', { path: 'src/a.ts', startLine: 1 })], [call('r2', 'read_file', { startLine: 1, path: 'src/a.ts' })], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toBe(repeatPointer('read_file', 1));
  });

  it('a write earlier in the SAME turn changes the content: the read returns it in full', async () => {
    const s = setup([[readA('r1')], [call('w2', 'write_file', { path: 'src/a.ts', content: 'export const a = 2;' }), readA('r2')], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toBe('src/a.ts (lines 1-1 of 1)\n1| export const a = 2;');
  });

  it('a read before and after a same-turn write: pointer first, full content after the write', async () => {
    const s = setup([[readA('r1')], [readA('r2'), call('w2', 'write_file', { path: 'src/a.ts', content: 'export const a = 3;' }), readA('r3')], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toBe(repeatPointer('read_file', 1));
    expect(seen(s.driver, 3, 'r3')).toBe('src/a.ts (lines 1-1 of 1)\n1| export const a = 3;');
  });

  it('a file changed by agent code during run_tests (no write tool involved) is read in full', async () => {
    const s = setup([[readA('r1')], [call('t2', 'run_tests', {})], [readA('r3')], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 4, 'r3')).toMatch(FULL);
    expect(seen(s.driver, 4, 'r3')).toContain('// touched by a test');
  });

  it('a read whose earlier copy is no longer shown verbatim (folded) is returned in full', async () => {
    // keepRecentTurns 2: the request after t3 shows t2 and t3 only; t1 is in the digest
    const s = setup([[readA('r1')], [call('t2', 'write_file', { path: 'src/b.ts', content: 'x' })], [readA('r3')], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 4, 'r3')).toMatch(FULL);
  });

  it('when the pointed-to turn folds, the pointer is shown with the full content again; a chain points at the newest visible copy', async () => {
    const s = setup([[readA('r1')], [readA('r2')], [readA('r3')], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toBe(repeatPointer('read_file', 1));
    // request 4 shows t2 and t3: t1 folded, so t2's pointer is expanded and t3 points at t2
    expect(seen(s.driver, 4, 'r2')).toMatch(FULL);
    expect(seen(s.driver, 4, 'r3')).toBe(repeatPointer('read_file', 2));
    const ws = (s.driver.requests[3]?.messages[0]?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(ws).not.toContain('Files you read in earlier turns'); // re-read in the kept turns: no skeleton needed
  });

  it('baseline mode never points (a read tool that is no context fetcher stays offered there)', async () => {
    const s = setup([[readA('r1')], [readA('r2')], []], { baseline: true, fetcher: false });
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toMatch(/^RAW src\/a\.ts/);
  });

  it('baseline mode withholds a context-fetching read tool: a call to it is an unknown tool', async () => {
    const s = setup([[readA('r1')], []], { baseline: true });
    await runAgent(s.agentOpts);
    expect(s.driver.requests[0]?.tools.map((t) => t.name)).toEqual(['write_file', 'run_tests']);
    expect(seen(s.driver, 2, 'r1')).toMatch(/^unknown tool "read_file"/);
  });

  it('an error read is never a pointer and never pointed at', async () => {
    const s = setup([[call('r1', 'read_file', { path: 'nope.ts' })], [call('r2', 'read_file', { path: 'nope.ts' })], []]);
    await runAgent(s.agentOpts);
    expect(seen(s.driver, 3, 'r2')).toBe('read_file: nope.ts does not exist');
  });
});

describe('transcript evidence', () => {
  it('the pointer and where its full content lives are persisted with the turn', async () => {
    const s = setup([[readA('r1')], [readA('r2')], []]);
    await runAgent(s.agentOpts);
    const row = s.store.transcript[1] as { repeats?: Record<string, unknown>; results?: Message['parts'] };
    expect(row.repeats).toEqual({ r2: { turn: 1, source: { turn: 1, callId: 'r1' } } });
  });
});
