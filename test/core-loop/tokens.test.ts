import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_DEFINITION,
  compareRuns,
  formatTokenReport,
  parseTokenReport,
  reductionPct,
  TokenLedger,
} from '../../src/core/tokens.ts';

function ledger(mode: 'jit' | 'baseline', runId = 'r1'): TokenLedger {
  return new TokenLedger({ runId, task: 'users-api', driver: 'fake', model: 'm', counter: 'chars/4', mode });
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
      attribution: { frontLoadChars: 7000, rawReturnChars: 500, historyChars: 40 } });
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
    expect(r.attribution_chars).toEqual({ front_load_avoided: 14000, raw_returns_avoided: 500, history_compacted: 40 });
    expect(formatTokenReport(r)).toContain('reduction 92%');
  });

  it('writes tokens/<runId>.json and reads it back', () => {
    const dir = join(process.cwd(), '.harness', 'tmp', `core-loop-tokens-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const l = ledger('jit', 'run-xyz');
    l.record({ turn: 1, actual: 10, baseline: 100, providerInput: 0, providerCached: 0, output: 1,
      attribution: { frontLoadChars: 1, rawReturnChars: 2, historyChars: 3 } });
    const file = l.write(dir);
    expect(file).toBe(join(dir, 'run-xyz.json'));
    try {
      const back = parseTokenReport(JSON.parse(readFileSync(file, 'utf8')));
      expect(back.totals.reduction_pct).toBe(90);
      expect(() => parseTokenReport({ runId: 1 })).toThrow(/not a token report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compareRuns measures two real runs', () => {
    const a = ledger('jit', 'jit-run');
    a.record({ turn: 1, actual: 100, baseline: 900, providerInput: 120, providerCached: 0, output: 5,
      attribution: { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 } });
    a.record({ turn: 2, actual: 100, baseline: 900, providerInput: 120, providerCached: 0, output: 5,
      attribution: { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 } });
    const b = ledger('baseline', 'base-run');
    for (let t = 1; t <= 4; t += 1) {
      b.record({ turn: t, actual: 1000, baseline: 1000, providerInput: 1100, providerCached: 0, output: 5,
        attribution: { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 } });
    }
    const c = compareRuns(a.report(), b.report());
    expect(c.method).toBe('measured');
    expect(c.jit.input_tokens).toBe(200);
    expect(c.baseline.input_tokens).toBe(4000);
    expect(c.reduction_pct).toBe(95);
    expect(c.provider_reported_reduction_pct).toBe(94.5);
    expect(c.per_turn_reduction_pct).toBe(90);
    expect(c.caveats.join(' ')).toMatch(/turn counts differ/);
  });

  it('documents exactly what the shadow baseline contains', () => {
    for (const part of [
      /every text file under the API root/,
      /node_modules\/\.git\/dist/,
      /200 KB cap/,
      /every standards doc in full/,
      /tool schemas counted once, not repeated in the system prompt/,
      /raw \(naive, uncapped\) return/,
      /test runner console output/,
      /no input elision, no history compaction/,
      /same token counter/,
    ]) expect(BASELINE_DEFINITION).toMatch(part);
  });

  it('baseline-mode ledger reports 0% reduction', () => {
    const l = ledger('baseline');
    l.record({ turn: 1, actual: 500, baseline: 500, providerInput: 0, providerCached: 0, output: 0,
      attribution: { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 } });
    expect(l.report().totals.reduction_pct).toBe(0);
  });
});
