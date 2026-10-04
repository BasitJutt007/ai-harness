/**
 * Context overflow: when the driver classifies a failed complete() as 'context_overflow'
 * (Driver.errorKind; the provider wording lives in plugins/drivers), the loop never resends the
 * identical request. It shrinks it ONCE (1 recent turn kept, the rest folded into the digest, the
 * working set as skeletons only, no full file text), recounts what it sends, and retries; a second
 * overflow, nothing left to drop, or a --baseline run (no compaction by definition) ends the run
 * with a clear error. The core reads no wording: an overflow the driver does not classify is an
 * ordinary failure with the ordinary retry budget.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WORKING_SET_HEADER, messageChars } from '../../src/core/context.ts';
import { runAgent, type RunAgentOptions } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { DriverErrorKind, Message, ModelRequest, ToolPlugin } from '../../src/core/types.ts';
import { call, fakeCtx, FakeDriver, fakeStore, firstMessage, reply, specs } from './fakes.ts';

class OverflowError extends Error {}

/** A driver that classifies OverflowError the way an SDK driver classifies its provider's wording. */
class ClassifyingDriver extends FakeDriver {
  errorKind(e: unknown): DriverErrorKind | null {
    return e instanceof OverflowError ? 'context_overflow' : null;
  }
}

/** File bodies: a signature line (kept in a skeleton) and a nested body line (full text only). */
const FILES: Record<string, string> = {
  'src/a.ts': 'export function a(): number {\n  return 1; // BODY_A\n}',
  'src/b.ts': 'export function b(): number {\n  return 2; // BODY_B\n}',
  'src/c.ts': 'export function c(): number {\n  return 3; // BODY_C\n}',
  'src/d.ts': 'export function d(): number {\n  return 4; // BODY_D\n}',
};

/** read_file as the shipped tool renders it: header line, then `<n>| <code>`. */
function readTool(): ToolPlugin<unknown> {
  const tool: ToolPlugin<{ path: string }> = {
    kind: 'tool',
    name: 'read_file',
    description: 'read a file',
    input: z.object({ path: z.string() }),
    effect: 'read',
    async run(i) {
      const code = (FILES[i.path] ?? '').split('\n');
      const text = [`${i.path} (lines 1-${code.length} of ${code.length})`, ...code.map((l, n) => `${n + 1}| ${l}`)].join('\n');
      return { ok: true, summary: text, raw: text };
    },
  };
  return tool as ToolPlugin<unknown>;
}

const read = (id: string, path: string) => reply([call(id, 'read_file', { path })]);
const done = reply([{ type: 'text', text: 'ok' }], 'end_turn');

function setup(script: ConstructorParameters<typeof FakeDriver>[0], opts: { baseline?: boolean; maxTurns?: number; driver?: FakeDriver; retryDelaysMs?: number[] } = {}) {
  const tools = [readTool()];
  const { ctx, events, logs } = fakeCtx({ tools, ...(opts.baseline === true ? { baseline: true } : {}) });
  const driver = opts.driver ?? new ClassifyingDriver(script);
  const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: opts.baseline === true ? 'baseline' : 'jit' });
  const agentOpts: RunAgentOptions = {
    driver,
    ctx,
    store: fakeStore(logs),
    ledger,
    first: firstMessage(),
    system: 'S',
    baselineSystem: 'S+F',
    tools: specs(tools),
    maxTurns: opts.maxTurns ?? 4,
    maxOutputTokens: 100,
    retryDelaysMs: opts.retryDelaysMs ?? [0, 0, 0],
  };
  return { driver, events, ledger, agentOpts };
}

const text = (m: Message[]): string => JSON.stringify(m);
const assistants = (req: ModelRequest | undefined): number => (req?.messages ?? []).filter((m) => m.role === 'assistant').length;

describe('context overflow: shrink once, never resend the identical request', () => {
  it('shrinks to 1 recent turn and working-set skeletons, recounts what it sends, and continues', async () => {
    const s = setup([read('r1', 'src/a.ts'), read('r2', 'src/b.ts'), read('r3', 'src/c.ts'), new OverflowError('too long'), done]);
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('max_turns');
    expect(s.driver.requests).toHaveLength(5); // 4 turns + exactly one shrunk resend
    const [, , , overflowed, shrunk] = s.driver.requests;
    // The request that overflowed: 2 recent turns, the folded a.ts read in full in the working set.
    expect(assistants(overflowed)).toBe(2);
    expect(text(overflowed?.messages ?? [])).toContain('BODY_A');
    // The shrunk resend: 1 recent turn; the folded reads as skeletons (signature lines), no body text.
    expect(assistants(shrunk)).toBe(1);
    const shrunkText = text(shrunk?.messages ?? []);
    expect(shrunkText).toContain(WORKING_SET_HEADER);
    expect(shrunkText).toContain('export function a(): number');
    expect(shrunkText).toContain('export function b(): number');
    expect(shrunkText).not.toContain('BODY_A');
    expect(shrunkText).not.toContain('BODY_B');
    expect(shrunkText).toContain('BODY_C'); // the kept recent turn is verbatim
    expect(messageChars(shrunk?.messages ?? [])).toBeLessThan(messageChars(overflowed?.messages ?? []));
    expect(shrunk?.system).toBe(overflowed?.system);
    // The ledger records what was sent: the shrunk request's count.
    const t4 = s.ledger.report().turns[3];
    expect(t4?.actual_input_tokens).toBe(Math.ceil(((shrunk?.system.length ?? 0) + messageChars(shrunk?.messages ?? [])) / 4));
    expect(t4?.actual_input_tokens).toBeLessThan(Math.ceil(((overflowed?.system.length ?? 0) + messageChars(overflowed?.messages ?? [])) / 4));
    expect(s.events.some((e) => e.kind === 'note' && /context overflow: request shrunk once and resent/.test(e.message))).toBe(true);
    expect(s.events.some((e) => /complete failed \(attempt/.test(e.message))).toBe(false); // no identical retry
  });

  it('the shrink is per turn: the next turn is built from the normal view again', async () => {
    const s = setup([read('r1', 'src/a.ts'), read('r2', 'src/b.ts'), read('r3', 'src/c.ts'), new OverflowError('too long'), read('r4', 'src/d.ts'), done], { maxTurns: 5 });
    await runAgent(s.agentOpts);
    expect(s.driver.requests).toHaveLength(6);
    expect(assistants(s.driver.requests[4])).toBe(1);
    expect(assistants(s.driver.requests[5])).toBe(2); // keepRecentTurns again
  });

  it('a second overflow ends the run with an error (no third attempt, no retry budget spent)', async () => {
    const s = setup([read('r1', 'src/a.ts'), read('r2', 'src/b.ts'), read('r3', 'src/c.ts'), new OverflowError('too long'), new OverflowError('still too long')]);
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('error');
    expect(r.turns).toBe(3);
    expect(r.error).toMatch(/^context overflow: the request does not fit the model's context window even after shrinking it once: still too long/);
    expect(s.driver.requests).toHaveLength(5);
  });

  it('nothing left to drop (the first turn): an error at once, not the identical request again', async () => {
    const s = setup([new OverflowError('too long'), done]);
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^context overflow with nothing left to drop/);
    expect(s.driver.requests).toHaveLength(1);
  });

  it('--baseline: no compaction by definition, so the overflow is reported, not shrunk', async () => {
    const s = setup([new OverflowError('too long'), done], { baseline: true });
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^context overflow: the --baseline request .* does not fit the model's context window: too long/);
    expect(s.driver.requests).toHaveLength(1);
  });

  it('the core reads no wording: an overflow the driver does not classify gets the ordinary retry budget', async () => {
    const msg = "This model's maximum context length is 8192 tokens (context_length_exceeded)";
    const s = setup([new Error(msg), new Error(msg), new Error(msg)], { driver: new FakeDriver([new Error(msg), new Error(msg), new Error(msg)]), retryDelaysMs: [0, 0] });
    const r = await runAgent(s.agentOpts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^driver\.complete failed after 3 attempts/);
    expect(s.driver.requests).toHaveLength(3);
    expect(new Set(s.driver.requests.map((q) => text(q.messages))).size).toBe(1); // ordinary retries resend as is
  });

  it("a driver whose errorKind throws is treated as naming no kind (the run is not crashed by the driver's parser)", async () => {
    class Throwing extends FakeDriver {
      errorKind(): DriverErrorKind | null {
        throw new Error('parser bug');
      }
    }
    const s = setup([], { driver: new Throwing([new OverflowError('x'), done]), retryDelaysMs: [0] });
    const r = await runAgent({ ...s.agentOpts, maxTurns: 1 });
    expect(r.status).toBe('max_turns');
    expect(s.driver.requests).toHaveLength(2);
  });
});
