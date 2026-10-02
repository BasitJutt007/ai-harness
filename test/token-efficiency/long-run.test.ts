/**
 * Realistic long run (40 turns of reads, writes, edits, test and standards runs) through
 * the real loop with the shipped context policy. Prints the per-turn table, a per-mechanism
 * ladder and the keepRecentTurns trade-off (run with --reporter=verbose to see it).
 */
import { describe, expect, it } from 'vitest';
import { formatTokenReport } from '../../src/core/tokens.ts';
import { simulate, STEPS, type SimResult } from './simulate.ts';

function line(label: string, r: SimResult): string {
  const t = r.report.totals;
  return `${label.padEnd(44)} actual ${String(t.actual_input_tokens).padStart(7)}  baseline ${String(t.baseline_input_tokens).padStart(7)}  reduction ${t.reduction_pct}%`;
}

describe('40-turn simulation (shipped policy)', () => {
  it('reduces input tokens by more than 90% with honest, non-negative attribution', async () => {
    const shipped = await simulate();
    expect(STEPS.length).toBe(40);
    expect(shipped.turns).toBe(40);
    expect(shipped.status).toBe('done');

    // Variants for the per-mechanism breakdown (same transcript, same counter, same baseline).
    const elisionOnly = await simulate({ keepRecentTurns: 10_000 });
    const noHistory = await simulate({ mode: { jit: true, compactReturns: true, compactHistory: false } });
    const noReturns = await simulate({ mode: { jit: true, compactReturns: false, compactHistory: false } });
    const keep1 = await simulate({ keepRecentTurns: 1 });
    const keep3 = await simulate({ keepRecentTurns: 3 });

    const out = [
      formatTokenReport(shipped.report),
      '',
      'mechanism ladder (each line adds one mechanism):',
      `${'baseline (front-load, raw returns, full history)'.padEnd(44)} ${shipped.report.totals.baseline_input_tokens}`,
      line('+ JIT context (no front-load)', noReturns),
      line('+ compact tool returns', noHistory),
      line('+ input elision (large write/edit payloads)', elisionOnly),
      line('+ digest of turns older than keepRecentTurns', shipped),
      '',
      'keepRecentTurns trade-off:',
      line('keepRecentTurns 1', keep1),
      line('keepRecentTurns 2 (shipped)', shipped),
      line('keepRecentTurns 3', keep3),
    ].join('\n');
    console.log(out);

    // The baseline is the honest naive harness: run_tests replays the runner's console output,
    // check_standards the full report, reads the whole file; tool schemas are counted once.
    expect(shipped.report.totals.reduction_pct).toBeGreaterThan(90);
    for (const v of [elisionOnly, noHistory, noReturns, keep1, keep3]) {
      expect(v.report.totals.baseline_input_tokens).toBe(shipped.report.totals.baseline_input_tokens);
    }
    for (const r of shipped.rows) {
      expect(r.actual).toBeLessThan(r.baseline);
      expect(r.attribution.frontLoadChars).toBeGreaterThan(0);
      expect(r.attribution.rawReturnChars).toBeGreaterThanOrEqual(0);
      expect(r.attribution.historyChars).toBeGreaterThanOrEqual(0);
    }
    // Every mechanism pulls its weight (monotone ladder); fewer recent turns, fewer tokens.
    const a = (r: SimResult): number => r.report.totals.actual_input_tokens;
    expect(a(noReturns)).toBeGreaterThan(a(noHistory));
    expect(a(noHistory)).toBeGreaterThan(a(elisionOnly));
    expect(a(elisionOnly)).toBeGreaterThan(a(shipped));
    expect(a(keep3)).toBeGreaterThan(a(shipped));
    expect(a(shipped)).toBeGreaterThan(a(keep1));
  }, 120_000);
});
