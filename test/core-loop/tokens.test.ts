import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_DEFINITION,
  comparisonsFor,
  compareRuns,
  formatComparison,
  formatTokenReport,
  MEASURED_NOTE,
  parseTokenReport,
  reductionPct,
  SHADOW_NOTE,
  TokenLedger,
  type TokenLedgerMeta,
  type TurnTokens,
} from '../../src/core/tokens.ts';

function ledger(mode: 'jit' | 'baseline', runId = 'r1', meta: Partial<TokenLedgerMeta> = {}): TokenLedger {
  return new TokenLedger({ runId, task: 'users-api', driver: 'fake', model: 'm', counter: 'chars/4', mode, ...meta });
}

const NO_ATTR: TurnTokens['attribution'] = { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 };

function turns(l: TokenLedger, n: number, actual: number, providerInput: number, extra: Partial<TurnTokens> = {}): TokenLedger {
  for (let t = 1; t <= n; t += 1) l.record({ turn: t, actual, baseline: actual * 9, providerInput, providerCached: 0, output: 5, attribution: NO_ATTR, ...extra });
  return l;
}

describe('token report', () => {
  it('reduction_pct = round(100*(1-actual/baseline), 1)', () => {
    expect(reductionPct(50, 1000)).toBe(95);
    expect(reductionPct(1, 3)).toBe(66.7);
    expect(reductionPct(10, 0)).toBe(0);
    expect(reductionPct(100, 100)).toBe(0);
  });

  it('builds per-turn rows, totals and attribution', () => {
    const l = ledger('jit');
    l.record({ turn: 1, actual: 100, baseline: 2000, providerInput: 110, providerCached: 0, output: 30,
      attribution: { frontLoadChars: 7000, rawReturnChars: 0, historyChars: 0 } });
    l.record({ turn: 2, actual: 300, baseline: 3000, providerInput: 310, providerCached: 100, output: 20,
      attribution: { frontLoadChars: 7000, rawReturnChars: 500, historyChars: 40, fetchChars: 900 } });
    const r = l.report();
    expect(r.method).toBe('shadow-baseline');
    expect(r.baselineDefinition).toBe(BASELINE_DEFINITION);
    expect(r.turns[0]).toEqual({
      turn: 1, actual_input_tokens: 100, baseline_input_tokens: 2000, reduction_pct: 95,
      provider_reported_input_tokens: 110, provider_cached_input_tokens: 0, output_tokens: 30,
    });
    expect(r.turns[1]?.reduction_pct).toBe(90);
    expect(r.totals).toEqual({
      actual_input_tokens: 400, baseline_input_tokens: 5000, reduction_pct: 92,
      provider_reported_input_tokens: 420, output_tokens: 50,
    });
    expect(r.attribution_chars).toEqual({ front_load_avoided: 14000, raw_returns_avoided: 500, history_compacted: 40, fetch_traffic_left_out: 900 });
    expect(formatTokenReport(r)).toContain('reduction 92%');
  });

  it('labels the baseline unambiguously: a normal run is a shadow estimate and points to the measured route', () => {
    const r = turns(ledger('jit'), 1, 10, 10).report();
    expect(r.baseline_kind).toBe('shadow');
    expect(r.method).toBe('shadow-baseline');
    expect(r.baseline_note).toBe(SHADOW_NOTE);
    expect(r.baseline_note).toMatch(/estimate that was never sent/);
    expect(r.baseline_note).toMatch(/same trajectory|own trajectory/);
    expect(r.baseline_note).toContain('harness run <task> --baseline');
    expect(r.baseline_note).toContain('harness tokens compare <thisRunId> <baselineRunId>');
    expect(formatTokenReport(r)).toMatch(/baseline shadow estimate \(never sent\)/);
  });

  it('a --baseline run is measured: what it sent is the baseline', () => {
    const l = ledger('baseline');
    l.record({ turn: 1, actual: 500, baseline: 500, providerInput: 0, providerCached: 0, output: 0, attribution: NO_ATTR });
    const r = l.report();
    expect(r.baseline_kind).toBe('measured');
    expect(r.method).toBe('measured-baseline');
    expect(r.baseline_note).toBe(MEASURED_NOTE);
    expect(r.baseline_note).toContain('harness tokens compare <jitRunId> <thisRunId>');
    expect(r.totals.reduction_pct).toBe(0);
    expect(formatTokenReport(r)).toMatch(/baseline measured/);
  });

  it('provider usage: reported, none (an offline driver), partial; estimated turns are marked', () => {
    expect(turns(ledger('jit'), 2, 10, 10).report().provider_usage).toBe('reported');
    expect(turns(ledger('jit'), 2, 10, 0, { providerReported: false }).report().provider_usage).toBe('none');
    const mixed = turns(ledger('jit'), 1, 10, 10);
    mixed.record({ turn: 2, actual: 10, baseline: 90, providerInput: 0, providerCached: 0, output: 0, attribution: NO_ATTR, providerReported: false });
    expect(mixed.report().provider_usage).toBe('partial');
    expect(ledger('jit').report().provider_usage).toBe('none'); // no turn: nothing was reported
    const est = turns(ledger('jit'), 1, 10, 10, { estimated: true }).report();
    expect(est.turns[0]?.estimated).toBe(true);
    expect(formatTokenReport(est)).toContain('(chars/4 estimate)');
    expect(turns(ledger('jit'), 1, 10, 10).report().turns[0]).not.toHaveProperty('estimated');
  });

  it('writes tokens/<runId>.json and reads it back', () => {
    const dir = join(process.cwd(), '.harness', 'tmp', `core-loop-tokens-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const l = ledger('jit', 'run-xyz');
    l.record({ turn: 1, actual: 10, baseline: 100, providerInput: 0, providerCached: 0, output: 1,
      attribution: { frontLoadChars: 1, rawReturnChars: 2, historyChars: 3 }, estimated: true });
    const file = l.write(dir);
    expect(file).toBe(join(dir, 'run-xyz.json'));
    try {
      const back = parseTokenReport(JSON.parse(readFileSync(file, 'utf8')));
      expect(back).toEqual(l.report());
      expect(back.totals.reduction_pct).toBe(90);
      expect(() => parseTokenReport({ runId: 1 })).toThrow(/not a token report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a report written before baseline_kind existed: kind from its mode, provider usage unknown', () => {
    const legacy = (mode: 'jit' | 'baseline'): Record<string, unknown> => {
      const { baseline_kind: _k, baseline_note: _n, provider_usage: _p, ...rest } = turns(ledger(mode), 1, 10, 10).report();
      const { fetch_traffic_left_out: _f, ...attr } = rest.attribution_chars;
      return { ...rest, method: 'shadow-baseline', attribution_chars: attr };
    };
    const jit = parseTokenReport(legacy('jit'));
    expect(jit).toMatchObject({ baseline_kind: 'shadow', method: 'shadow-baseline', baseline_note: SHADOW_NOTE, provider_usage: 'unknown' });
    expect(jit.attribution_chars.fetch_traffic_left_out).toBe(0);
    // an old --baseline report said "shadow-baseline", but its requests were the baseline: measured
    expect(parseTokenReport(legacy('baseline'))).toMatchObject({ baseline_kind: 'measured', method: 'measured-baseline', baseline_note: MEASURED_NOTE });
  });

  it('documents exactly what the baseline request contains', () => {
    for (const part of [
      /same task on the same driver and model/,
      /context fetchers and compaction disabled/,
      /every text file under the API root/,
      /re-read from the current tree before that turn/,
      /node_modules\/\.git\/dist/,
      /200 KB cap/,
      /every standards doc in full/,
      /minus the context fetchers \(read tools and tools that declare fetcher: true\)/,
      /tool schemas counted once in the tools array, not repeated in the system prompt/,
      /raw \(naive, uncapped\) return/,
      /test runner console output/,
      /no input elision, no history compaction/,
      /same token counter/,
    ]) expect(BASELINE_DEFINITION).toMatch(part);
  });
});

describe('tokens compare (measured)', () => {
  it('measures two real runs: per-run totals and per-turn averages, each explained', () => {
    const a = ledger('jit', 'jit-run');
    for (const t of [1, 2]) a.record({ turn: t, actual: 100, baseline: 900, providerInput: 120, providerCached: 0, output: 5, attribution: NO_ATTR });
    const b = ledger('baseline', 'base-run');
    for (let t = 1; t <= 4; t += 1) b.record({ turn: t, actual: 1000, baseline: 1000, providerInput: 1100, providerCached: 0, output: 5, attribution: NO_ATTR });
    const c = compareRuns(a.report(), b.report());
    expect(c.method).toBe('measured');
    expect(c.baseline_kind).toBe('measured');
    expect(c.jit.input_tokens).toBe(200);
    expect(c.baseline.input_tokens).toBe(4000);
    expect(c.reduction_pct).toBe(95);
    expect(c.per_turn_reduction_pct).toBe(90);
    expect(c.provider_reported_reduction_pct).toBe(94.5);
    expect(c.jit_shadow_reduction_pct).toBe(88.9);
    expect(c.explanations.reduction_pct).toMatch(/per-run totals/);
    expect(c.explanations.per_turn_reduction_pct).toMatch(/per-turn average.*own turn count/);
    expect(c.caveats.join(' ')).toMatch(/turn counts differ \(2 vs 4\).*reduction_pct.*per_turn_reduction_pct/);
    expect(formatComparison(c).join('\n')).toMatch(/95% per-run totals, 90% per-turn average, 94\.5% provider-reported/);
  });

  it('a like-for-like pair (same task, driver, model, counter, turn count) has no caveats', () => {
    const c = compareRuns(turns(ledger('jit', 'a'), 3, 10, 10).report(), turns(ledger('baseline', 'b'), 3, 100, 100).report());
    expect(c.caveats).toEqual([]);
    expect(c.reduction_pct).toBe(c.per_turn_reduction_pct);
  });

  it('caveats every mismatch with the assignment definition (same task, same driver, same model)', () => {
    const cases: Array<{ jit: Partial<TokenLedgerMeta>; base: Partial<TokenLedgerMeta>; mode?: ['jit' | 'baseline', 'jit' | 'baseline']; want: RegExp }> = [
      { jit: { driver: 'driver-a' }, base: { driver: 'driver-b' }, want: /different drivers: driver-a vs driver-b/ },
      { jit: { model: 'model-x' }, base: { model: 'model-y' }, want: /different models: model-x vs model-y/ },
      { jit: { model: 'model-x' }, base: { model: 'model-x (compat)' }, want: /different models/ },
      { jit: { task: 'users-api' }, base: { task: 'orders-api' }, want: /different tasks: users-api vs orders-api/ },
      { jit: { counter: 'counter-1' }, base: { counter: 'counter-2' }, want: /different token counters/ },
      { jit: {}, base: {}, mode: ['jit', 'jit'], want: /second run is not a --baseline run/ },
      { jit: {}, base: {}, mode: ['baseline', 'baseline'], want: /first run is not a normal \(JIT\) run/ },
    ];
    for (const k of cases) {
      const [ma, mb] = k.mode ?? ['jit', 'baseline'];
      const c = compareRuns(turns(ledger(ma, 'a', k.jit), 2, 10, 10).report(), turns(ledger(mb, 'b', k.base), 2, 100, 100).report());
      expect(c.caveats.join('\n')).toMatch(k.want);
    }
  });

  it('no provider usage on either side (an offline driver): the provider ratio is null, with a caveat', () => {
    const a = turns(ledger('jit', 'a'), 2, 10, 0, { providerReported: false }).report();
    const b = turns(ledger('baseline', 'b'), 2, 100, 0, { providerReported: false }).report();
    const c = compareRuns(a, b);
    expect(c.provider_reported_reduction_pct).toBeNull();
    expect(c.caveats.join('\n')).toMatch(/run a has no provider-reported usage/);
    expect(formatComparison(c).join('\n')).toMatch(/provider-reported n\/a/);
    const empty = compareRuns(ledger('jit', 'a').report(), turns(ledger('baseline', 'b'), 1, 1, 1).report());
    expect(empty.caveats.join('\n')).toMatch(/run a recorded no turns/);
  });

  it('comparisonsFor finds the measured comparisons of a run on disk (either side), skipping junk', () => {
    const dir = join(process.cwd(), '.harness', 'tmp', `core-loop-compare-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const c = compareRuns(turns(ledger('jit', 'j1'), 2, 10, 10).report(), turns(ledger('baseline', 'b1'), 2, 100, 100).report());
      writeFileSync(join(dir, 'compare-j1-vs-b1.json'), JSON.stringify(c));
      writeFileSync(join(dir, 'compare-broken.json'), '{ not json');
      writeFileSync(join(dir, 'j1.json'), JSON.stringify(turns(ledger('jit', 'j1'), 1, 1, 1).report()));
      expect(comparisonsFor(dir, 'j1').map((x) => [x.jitRunId, x.baselineRunId, x.reduction_pct, x.per_turn_reduction_pct])).toEqual([['j1', 'b1', 90, 90]]);
      expect(comparisonsFor(dir, 'b1')).toHaveLength(1);
      expect(comparisonsFor(dir, 'other')).toEqual([]);
      expect(comparisonsFor(join(dir, 'missing'), 'j1')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
