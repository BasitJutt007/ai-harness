import { describe, expect, it } from 'vitest';
import { runPostHooks, runPreHooks } from '../../src/core/hooks.ts';
import { gatesOk, runGates } from '../../src/core/gates.ts';
import type { GatePlugin, GateResult, HookPlugin, HookVerdict, ToolCallInfo } from '../../src/core/types.ts';
import { fakeCtx, rec } from './fakes.ts';

const writeCall: ToolCallInfo = { id: 'c1', tool: 'write_file', effect: 'write', input: { path: 'src/a.ts' }, paths: ['src/a.ts'] };
const readCall: ToolCallInfo = { id: 'c2', tool: 'read_file', effect: 'read', input: { path: 'src/a.ts' }, paths: [] };

function hook(name: string, verdict: () => Promise<HookVerdict> | HookVerdict, extra: Partial<HookPlugin> = {}): HookPlugin & { calls: number } {
  const h = {
    kind: 'hook' as const,
    name,
    description: name,
    events: ['pre_tool', 'post_tool'] as HookPlugin['events'],
    calls: 0,
    async run(): Promise<HookVerdict> {
      h.calls += 1;
      return verdict();
    },
    ...extra,
  };
  return h;
}

describe('hooks', () => {
  it('first block wins and later hooks are skipped', async () => {
    const { ctx, events } = fakeCtx();
    const a = hook('a', () => ({ decision: 'record', note: 'noted' }));
    const b = hook('b', () => ({ decision: 'block', reason: 'nope' }));
    const c = hook('c', () => ({ decision: 'block', reason: 'never seen' }));
    const out = await runPreHooks([a, b, c].map((h) => rec(h)), writeCall, ctx);
    expect(out.blocked).toEqual({ hook: 'b', reason: 'nope' });
    expect(out.notes).toEqual([{ hook: 'a', note: 'noted' }]);
    expect(c.calls).toBe(0);
    expect(events.map((e) => [e.source, e.decision])).toEqual([
      ['a', 'record'],
      ['b', 'block'],
    ]);
  });

  it('fails closed when a hook throws', async () => {
    const { ctx } = fakeCtx();
    const boom = hook('boom', () => {
      throw new Error('kaput');
    });
    const out = await runPreHooks([rec(boom)], writeCall, ctx);
    expect(out.blocked).toEqual({ hook: 'boom', reason: 'hook boom crashed: kaput' });
  });

  it('fails closed on a malformed verdict', async () => {
    const { ctx } = fakeCtx();
    const bad = hook('bad', () => ({ decision: 'block' }) as unknown as HookVerdict);
    const out = await runPreHooks([rec(bad)], writeCall, ctx);
    expect(out.blocked?.reason).toMatch(/invalid verdict/);
  });

  it('filters by event, effect and tool name', async () => {
    const { ctx } = fakeCtx();
    const writeOnly = hook('w', () => ({ decision: 'block', reason: 'w' }), { effects: ['write'] });
    const toolOnly = hook('t', () => ({ decision: 'block', reason: 't' }), { tools: ['edit_file'] });
    const postOnly = hook('p', () => ({ decision: 'block', reason: 'p' }), { events: ['post_tool'] });
    const recs = [writeOnly, toolOnly, postOnly].map((h) => rec(h));
    expect((await runPreHooks(recs, readCall, ctx)).blocked).toBeNull();
    expect((await runPreHooks(recs, writeCall, ctx)).blocked?.hook).toBe('w');
    expect((await runPostHooks([rec(postOnly)], readCall, { ok: true, summary: 's' }, ctx)).blocked?.hook).toBe('p');
  });

  it('emits a pass event for passing hooks', async () => {
    const { ctx, events } = fakeCtx();
    await runPreHooks([rec(hook('ok', () => ({ decision: 'pass' })))], writeCall, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.decision).toBe('pass');
  });
});

function gate(name: string, run: () => Promise<GateResult>, extra: Partial<GatePlugin> = {}): GatePlugin {
  return { kind: 'gate', name, description: name, phases: ['finish', 'ship'], run, ...extra };
}

describe('gates', () => {
  it('ok iff no fail/unproven and at least one pass', () => {
    expect(gatesOk([])).toBe(false);
    expect(gatesOk([{ status: 'n/a', summary: '' }])).toBe(false);
    expect(gatesOk([{ status: 'pass', summary: '' }, { status: 'n/a', summary: '' }])).toBe(true);
    expect(gatesOk([{ status: 'pass', summary: '' }, { status: 'unproven', summary: '' }])).toBe(false);
    expect(gatesOk([{ status: 'pass', summary: '' }, { status: 'fail', summary: '' }])).toBe(false);
  });

  it('non-applicable gates are n/a and not run; throwing gates are unproven', async () => {
    const { ctx } = fakeCtx();
    let ran = false;
    const gates = [
      gate('tests-green', async () => ({ status: 'pass', summary: '3 passed' })),
      gate('contract-lock', async () => {
        ran = true;
        return { status: 'pass', summary: 'x' };
      }, { appliesTo: ['brownfield'] }),
      gate('crashy', async () => {
        throw new Error('no git');
      }),
    ];
    const out = await runGates(gates.map((g) => rec(g)), ctx, 'finish');
    expect(ran).toBe(false);
    expect(out.results.map((r) => [r.gate, r.status])).toEqual([
      ['tests-green', 'pass'],
      ['contract-lock', 'n/a'],
      ['crashy', 'unproven'],
    ]);
    expect(out.results[2]?.summary).toBe('gate crashy crashed: no git');
    expect(out.ok).toBe(false);
    expect(out.text.split('\n')).toHaveLength(3);
    expect(out.text).toMatch(/^gate {2}tests-green +pass +3 passed$/m);
  });

  it('filters by phase and includes details for failing gates in compact', async () => {
    const { ctx, events } = fakeCtx();
    const gates = [
      gate('secrets', async () => ({ status: 'fail', summary: 'never' }), { phases: ['ship'] }),
      gate('tests-green', async () => ({ status: 'fail', summary: '1 failed', details: ['FAIL test/a.test.ts > x'] })),
      gate('scope', async () => ({ status: 'pass', summary: 'in scope', details: ['hidden'] })),
    ];
    const out = await runGates(gates.map((g) => rec(g)), ctx, 'finish');
    expect(out.results.map((r) => r.gate)).toEqual(['tests-green', 'scope']);
    expect(out.ok).toBe(false);
    expect(out.compact).toContain('    FAIL test/a.test.ts > x');
    expect(out.compact).not.toContain('hidden');
    expect(events.filter((e) => e.kind === 'gate')).toHaveLength(2);
  });

  it('all pass → ok', async () => {
    const { ctx } = fakeCtx();
    const out = await runGates([rec(gate('a', async () => ({ status: 'pass', summary: 'ok' })))], ctx, 'finish');
    expect(out.ok).toBe(true);
  });
});
