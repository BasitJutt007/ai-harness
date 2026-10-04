/**
 * Turn limit. An explicit limit (--max-turns, the task file's limits.maxTurns) is a hard cap.
 * Without one, the limit scales with the task (TURN_LIMIT_BASE + TURNS_PER_RESOURCE per resource
 * + TURNS_PER_BEHAVIOUR per behaviour, at most TURN_LIMIT_CAP) and the loop extends it by
 * TURN_EXTENSION_STEP turns, at most half the default in all, each time the run reaches it while
 * the gates make measurable progress: the latest refused finish attempt, inside the last step,
 * found fewer failing units than the one before it.
 */
import { describe, expect, it } from 'vitest';
import { failingUnits, runGates } from '../../src/core/gates.ts';
import {
  defaultTurnLimit,
  extensionAt,
  runAgent,
  TURN_EXTENSION_STEP,
  TURN_LIMIT_BASE,
  TURN_LIMIT_CAP,
  turnLimitFor,
  TURNS_PER_BEHAVIOUR,
  TURNS_PER_RESOURCE,
  type TurnExtension,
} from '../../src/core/loop.ts';
import { turnLimitLine } from '../../src/core/run.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import type { GatePlugin, GateResult, ResourceSpec, Task } from '../../src/core/types.ts';
import { call, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, GREENFIELD, rec, reply, specs } from './fakes.ts';

const resource = (name: string): ResourceSpec => ({ name, plural: `${name}s`, fields: [], operations: ['list', 'get', 'create', 'update', 'delete'] });

function task(resources: number, behaviours: number, maxTurns?: number): Task {
  return {
    ...GREENFIELD,
    resources: Array.from({ length: resources }, (_, i) => resource(`r${i}`)),
    behaviours: Array.from({ length: behaviours }, (_, i) => `behaviour ${i}`),
    limits: { ...(maxTurns !== undefined ? { maxTurns } : {}), maxOutputTokens: 1000 },
  };
}

describe('the default turn limit scales with the task size, capped', () => {
  const table: Array<[number, number, number]> = [
    [0, 0, TURN_LIMIT_BASE + TURNS_PER_RESOURCE], // a brief-only task or a change is sized as one resource
    [1, 0, 60],
    [1, 1, 60 + TURNS_PER_BEHAVIOUR],
    [2, 0, 80],
    [3, 5, TURN_LIMIT_BASE + 3 * TURNS_PER_RESOURCE + 5 * TURNS_PER_BEHAVIOUR],
    [5, 0, 140],
    [6, 0, TURN_LIMIT_CAP],
    [40, 200, TURN_LIMIT_CAP],
  ];
  for (const [resources, behaviours, want] of table) {
    it(`${resources} resource(s), ${behaviours} behaviour(s) -> ${want}`, () => {
      expect(defaultTurnLimit({ resources, behaviours })).toBe(want);
      expect(turnLimitFor(task(resources, behaviours)).max).toBe(want);
    });
  }

  it('a brownfield task without resources gets the one-resource default', () => {
    const brown: Task = { kind: 'brownfield', id: 'x', title: 'x', behaviours: [], limits: { maxOutputTokens: 1000 }, target: 'api', change: 'add a field', scope: { allow: ['src/**'], deny: [] }, allowBreaking: false };
    expect(turnLimitFor(brown)).toMatchObject({ max: 60, source: 'default' });
  });
});

describe('which limit applies, and which may grow', () => {
  it('--max-turns, then the task file, are hard caps (no extension)', () => {
    expect(turnLimitFor(task(3, 0, 25), 7)).toEqual({ max: 7, source: 'cli' });
    expect(turnLimitFor(task(3, 0, 25))).toEqual({ max: 25, source: 'task' });
  });

  it('the scaled default may grow by TURN_EXTENSION_STEP at a time, at most half the default in all', () => {
    expect(turnLimitFor(task(1, 0))).toEqual({ max: 60, source: 'default', extension: { step: TURN_EXTENSION_STEP, maxExtra: 30 } });
    expect(turnLimitFor(task(6, 0)).extension).toEqual({ step: TURN_EXTENSION_STEP, maxExtra: 75 });
  });

  it('the run summary line names the source, the possible extension and the extensions earned', () => {
    expect(turnLimitLine({ max: 25, source: 'task' }, undefined)).toBe('25 turns (task file maxTurns (hard cap))');
    expect(turnLimitLine({ max: 7, source: 'cli' }, undefined)).toBe('7 turns (--max-turns (hard cap))');
    const line = turnLimitLine(turnLimitFor(task(1, 0)), { initial: 60, final: 70, extensions: [{ atTurn: 60, by: 10, failingBefore: 4, failingAfter: 2 }] });
    expect(line).toBe('60 turns (default scaled with the task size; up to +30 while the gates make progress); extended to 70 (+10 at turn 60: 4→2 failing)');
  });
});

describe('extensionAt: measurable progress inside the last step', () => {
  const ext: TurnExtension = { step: 10, maxExtra: 25 };
  const cases: Array<[string, Array<{ turn: number; failing: number }>, number, ReturnType<typeof extensionAt>]> = [
    ['no finish attempt', [], 0, null],
    ['one finish attempt (nothing to compare)', [{ turn: 58, failing: 3 }], 0, null],
    ['no progress (same count)', [{ turn: 50, failing: 3 }, { turn: 58, failing: 3 }], 0, null],
    ['regression', [{ turn: 50, failing: 2 }, { turn: 58, failing: 5 }], 0, null],
    ['progress, but before the last step (stale)', [{ turn: 40, failing: 5 }, { turn: 50, failing: 2 }], 0, null],
    ['progress inside the last step', [{ turn: 45, failing: 5 }, { turn: 55, failing: 2 }], 0, { atTurn: 60, by: 10, failingBefore: 5, failingAfter: 2 }],
    ['the last grant is capped by maxExtra', [{ turn: 45, failing: 5 }, { turn: 55, failing: 2 }], 20, { atTurn: 60, by: 5, failingBefore: 5, failingAfter: 2 }],
    ['maxExtra used up', [{ turn: 45, failing: 5 }, { turn: 55, failing: 2 }], 25, null],
  ];
  for (const [name, attempts, extra, want] of cases) {
    it(name, () => {
      expect(extensionAt(60, attempts, ext, extra)).toEqual(want);
    });
  }
});

describe('failing units of a gate run', () => {
  const r = (status: GateResult['status'], extra: Partial<GateResult> = {}): GateResult => ({ status, summary: 's', ...extra });
  it("a gate's own count first, else its detail lines, at least 1; passing and n/a gates count 0", () => {
    expect(failingUnits([r('pass', { failing: 9 }), r('n/a')])).toBe(0);
    expect(failingUnits([r('fail', { failing: 7, details: ['a'] })])).toBe(7);
    expect(failingUnits([r('fail', { details: ['a', 'b', 'c'] })])).toBe(3);
    expect(failingUnits([r('unproven')])).toBe(1);
    expect(failingUnits([r('fail', { failing: 0 })])).toBe(1);
    expect(failingUnits([r('fail', { failing: 4 }), r('unproven', { details: ['x', 'y'] }), r('pass')])).toBe(6);
  });

  it('the gate runner keeps a valid count and drops an invalid one', async () => {
    const gate = (name: string, failing: unknown): GatePlugin => ({
      kind: 'gate',
      name,
      phases: ['finish'],
      run: async () => ({ status: 'fail', summary: 'x', failing }) as unknown as GateResult,
    });
    const { ctx } = fakeCtx();
    const out = await runGates([rec(gate('ok', 3)), rec(gate('neg', -1)), rec(gate('frac', 1.5)), rec(gate('str', '4'))], ctx, 'finish');
    expect(out.results.map((x) => x.failing)).toEqual([3, undefined, undefined, undefined]);
  });
});

describe('the loop extends a default limit only while the gates make progress', () => {
  /** A gate that fails with the next count of `counts` on each finish attempt. */
  function countingGate(counts: number[]): GatePlugin {
    let i = 0;
    return {
      kind: 'gate',
      name: 'tests-green',
      phases: ['finish'],
      run: async () => {
        const n = counts[Math.min(i, counts.length - 1)] ?? 1;
        i += 1;
        return { status: 'fail', summary: `${n} tests failed`, failing: n };
      },
    };
  }

  function setup(counts: number[], maxTurns: number, turnExtension?: TurnExtension) {
    const tools = [finishTool()];
    const { ctx, events, logs } = fakeCtx({ tools, gates: [countingGate(counts)] });
    const finishes = Array.from({ length: 40 }, (_, i) => reply([call(`f${i}`, 'finish', { summary: 'done' })]));
    const driver = new FakeDriver(finishes);
    const run = () =>
      runAgent({
        driver,
        ctx,
        store: fakeStore(logs),
        ledger: new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: 'jit' }),
        first: firstMessage(),
        system: 'S',
        baselineSystem: 'S+F',
        tools: specs(tools),
        maxTurns,
        ...(turnExtension !== undefined ? { turnExtension } : {}),
        maxOutputTokens: 100,
        retryDelaysMs: [],
      });
    return { run, events, driver };
  }

  it('progress at every limit: extended step by step until maxExtra, then max_turns', async () => {
    const s = setup([9, 7, 6, 5, 4, 3, 2, 1], 2, { step: 2, maxExtra: 4 });
    const r = await s.run();
    expect(r.status).toBe('max_turns');
    expect(r.turns).toBe(6);
    expect(s.driver.requests).toHaveLength(6);
    expect(r.turnLimit).toEqual({
      initial: 2,
      final: 6,
      extensions: [
        { atTurn: 2, by: 2, failingBefore: 9, failingAfter: 7 },
        { atTurn: 4, by: 2, failingBefore: 6, failingAfter: 5 },
      ],
    });
    expect(s.events.filter((e) => e.kind === 'note' && /^turn limit extended to \d+ \(\+2\): the gates went from \d+ to \d+ failing units/.test(e.message))).toHaveLength(2);
  });

  it('no progress: the default limit holds', async () => {
    const s = setup([5, 5, 5, 5], 2, { step: 2, maxExtra: 4 });
    const r = await s.run();
    expect(r.status).toBe('max_turns');
    expect(r.turns).toBe(2);
    expect(r.turnLimit).toBeUndefined();
  });

  it('progress stops: the extension stops with it', async () => {
    const s = setup([9, 7, 7, 7, 7], 2, { step: 2, maxExtra: 10 });
    const r = await s.run();
    expect(r.turns).toBe(4);
    expect(r.turnLimit?.extensions).toHaveLength(1);
  });

  it('an explicit limit (no extension option) is a hard cap even with progress', async () => {
    const s = setup([9, 7, 6, 5], 2);
    const r = await s.run();
    expect(r.status).toBe('max_turns');
    expect(r.turns).toBe(2);
    expect(s.driver.requests).toHaveLength(2);
    expect(r.turnLimit).toBeUndefined();
  });
});
