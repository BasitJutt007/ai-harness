/**
 * Realistic long run (40 turns of reads, writes, edits, test and standards runs) through
 * the real loop with the shipped context policy. Prints the per-turn table, a per-mechanism
 * ladder, the cost of the anti-thrashing context and the keepRecentTurns trade-off (run with
 * --reporter=verbose to see it).
 *
 * The trade-off this test documents. Runs against real free-tier models showed thrashing: once
 * a read turn folded into the one-line digest, models re-read the same files in a loop (in the
 * real transcripts, 111 of 122 re-reads targeted a file whose content was no longer in the
 * request at all), and they read every scaffold file up front. Two mechanisms now spend tokens
 * on purpose to prevent that:
 *   - the working set: after the digest, a skeleton (signature lines with line numbers) of each
 *     file read in a folded turn and not written since (replaying the real transcripts through
 *     jitView, every one of those 122 re-reads then had at least the file's skeleton in context);
 *   - the scaffold API: the scaffold's exported signatures in the greenfield brief.
 * This simulation's model is a fixed script that never re-reads, so it pays both costs and
 * cannot be credited with the re-reads they prevent. So the test asserts what is true here:
 *   1. the compaction mechanisms alone (the same requests without the working set, the brief
 *      without the scaffold API) still reduce input tokens by more than 88%;
 *   2. the anti-thrashing context is bounded (working set within WORKING_SET_CHARS per request;
 *      scaffold API under 700 tokens per request, added to actual and baseline alike) and costs
 *      less than 6 points of reduction (5.1 measured: the same tokens weigh more against the smaller honest baseline);
 *   3. the shipped total stays above 83% with honest, non-negative attribution.
 * The baseline is never touched: every variant has the same baseline as the shipped run
 * (except the no-scaffold-API one, whose brief is smaller on both sides). It is the request
 * run.ts builds (BASELINE_DEFINITION): the tree front-loaded as it is at each turn, no context
 * fetchers, and this trajectory's fetch calls left out of the shadow (their content is already
 * front-loaded). The thresholds were 90% / 85% while the shadow front-loaded the run-start tree
 * and ALSO replayed every raw read (the same file counted twice) plus the fetchers' schemas:
 * measured on the same 40 turns, that baseline was 1,337,976 tokens, the honest one ~1,148,000.
 */
import { describe, expect, it } from 'vitest';
import { countRequest, countText } from '../../plugins/lib/tokenize.ts';
import { DIGEST_HEADER, WORKING_SET_CHARS, WORKING_SET_HEADER } from '../../src/core/context.ts';
import { formatTokenReport } from '../../src/core/tokens.ts';
import type { ModelRequest } from '../../src/core/types.ts';
import { simulate, STEPS, type SimResult } from './simulate.ts';

function line(label: string, r: SimResult): string {
  const t = r.report.totals;
  return `${label.padEnd(44)} actual ${String(t.actual_input_tokens).padStart(7)}  baseline ${String(t.baseline_input_tokens).padStart(7)}  reduction ${t.reduction_pct}%`;
}

const pct = (actual: number, baseline: number): number => Math.round(1000 * (1 - actual / baseline)) / 10;

/** The working-set part of a request (after the digest, in the first message), if any. */
function workingSetText(req: ModelRequest): string | null {
  const p = req.messages[0]?.parts.find((x) => x.type === 'text' && x.text.startsWith(WORKING_SET_HEADER));
  return p !== undefined && p.type === 'text' ? p.text : null;
}

/** Tokens the working set added over a run, and the run's actual total with it removed from every request. */
function workingSetCost(r: SimResult): { tokens: number; requests: number; maxChars: number; actualWithout: number } {
  let tokens = 0;
  let requests = 0;
  let maxChars = 0;
  let actualWithout = 0;
  for (const req of r.requests) {
    const ws = workingSetText(req);
    const head = req.messages[0];
    if (ws !== null && head !== undefined) {
      tokens += countText(ws);
      requests += 1;
      maxChars = Math.max(maxChars, ws.length);
      actualWithout += countRequest({ ...req, messages: [{ role: head.role, parts: head.parts.filter((p) => !(p.type === 'text' && p.text === ws)) }, ...req.messages.slice(1)] });
    } else {
      actualWithout += countRequest(req);
    }
  }
  return { tokens, requests, maxChars, actualWithout };
}

describe('40-turn simulation (shipped policy)', () => {
  it('compaction alone reduces input tokens by more than 88%; the deliberate anti-thrashing context is bounded and itemised', async () => {
    const shipped = await simulate();
    expect(STEPS.length).toBe(40);
    expect(shipped.turns).toBe(40);
    expect(shipped.status).toBe('done');
    // The simulation counts requests itself; they must agree with the ledger it reports.
    expect(shipped.requests.reduce((n, r) => n + countRequest(r), 0)).toBe(shipped.report.totals.actual_input_tokens);

    // Variants for the per-mechanism breakdown (same transcript, same counter, same baseline).
    const elisionOnly = await simulate({ keepRecentTurns: 10_000 });
    const noHistory = await simulate({ mode: { jit: true, compactReturns: true, compactHistory: false } });
    const noReturns = await simulate({ mode: { jit: true, compactReturns: false, compactHistory: false } });
    const keep1 = await simulate({ keepRecentTurns: 1 });
    const keep3 = await simulate({ keepRecentTurns: 3 });
    // The anti-thrashing context, measured: the brief without the scaffold API, and every request without the working set.
    const noApi = await simulate({ scaffoldApi: false });
    const ws = workingSetCost(shipped);
    const compactionOnly = workingSetCost(noApi).actualWithout;
    const apiTokens = shipped.report.totals.actual_input_tokens - noApi.report.totals.actual_input_tokens;
    const apiBaselineTokens = shipped.report.totals.baseline_input_tokens - noApi.report.totals.baseline_input_tokens;

    const t = shipped.report.totals;
    const out = [
      formatTokenReport(shipped.report),
      '',
      'mechanism ladder (each line adds one mechanism):',
      `${'baseline (front-load, raw returns, full history)'.padEnd(44)} ${t.baseline_input_tokens}`,
      line('+ JIT context (no front-load)', noReturns),
      line('+ compact tool returns', noHistory),
      line('+ input elision (large write/edit payloads)', elisionOnly),
      line('+ digest of turns older than keepRecentTurns', shipped),
      '',
      'anti-thrashing context (deliberate cost, see the header of this file):',
      `${'  working set (skeletons of folded reads)'.padEnd(44)} +${ws.tokens} tokens over ${ws.requests} requests (largest ${ws.maxChars} chars, budget ${WORKING_SET_CHARS})`,
      `${'  scaffold API in the greenfield brief'.padEnd(44)} +${apiTokens} tokens (${apiTokens / shipped.turns} per request; baseline +${apiBaselineTokens})`,
      `${'  shipped without both (compaction only)'.padEnd(44)} actual ${String(compactionOnly).padStart(7)}  baseline ${String(noApi.report.totals.baseline_input_tokens).padStart(7)}  reduction ${pct(compactionOnly, noApi.report.totals.baseline_input_tokens)}%`,
      '',
      'keepRecentTurns trade-off:',
      line('keepRecentTurns 1', keep1),
      line('keepRecentTurns 2 (shipped)', shipped),
      line('keepRecentTurns 3', keep3),
    ].join('\n');
    console.log(out);

    // 1. The compaction mechanisms alone: more than 88% (the baseline is the honest naive harness:
    //    the current tree front-loaded once per request, run_tests replays the runner's console
    //    output, check_standards the full report; no fetch traffic; tool schemas are counted once).
    expect(pct(compactionOnly, noApi.report.totals.baseline_input_tokens)).toBeGreaterThan(88);

    // 2. The anti-thrashing context is bounded and itemised.
    expect(ws.requests).toBeGreaterThan(0);
    expect(ws.maxChars).toBeLessThanOrEqual(WORKING_SET_CHARS + WORKING_SET_HEADER.length + 1);
    expect(apiTokens).toBe(apiBaselineTokens); // the brief is the same on both sides
    expect(apiTokens / shipped.turns).toBeLessThan(700);
    expect(pct(compactionOnly, noApi.report.totals.baseline_input_tokens) - t.reduction_pct).toBeLessThan(6);
    // Itemisation is complete: shipped = compaction only + working set + scaffold API (token counts
    // of separately serialized parts differ by a few tokens at the seams).
    expect(Math.abs(t.actual_input_tokens - (compactionOnly + ws.tokens + apiTokens))).toBeLessThan(shipped.turns * 4);

    // 3. The shipped total.
    expect(t.reduction_pct).toBeGreaterThan(83);
    for (const v of [elisionOnly, noHistory, noReturns, keep1, keep3]) {
      expect(v.report.totals.baseline_input_tokens).toBe(t.baseline_input_tokens);
    }
    // History compaction may cost a few characters on the single turn a read folds (its content stays in
    // full in the working set while the digest/working-set headers are added): never more than those two
    // headers on any turn, and it saves overall.
    const headers = DIGEST_HEADER.length + WORKING_SET_HEADER.length;
    for (const r of shipped.rows) {
      expect(r.actual).toBeLessThan(r.baseline);
      expect(r.attribution.frontLoadChars).toBeGreaterThan(0);
      expect(r.attribution.rawReturnChars).toBeGreaterThanOrEqual(0);
      expect(r.attribution.historyChars).toBeGreaterThanOrEqual(-headers);
    }
    expect(shipped.rows.reduce((n, r) => n + r.attribution.historyChars, 0)).toBeGreaterThan(0);
    // Every mechanism pulls its weight (monotone ladder); fewer recent turns, fewer tokens.
    const a = (r: SimResult): number => r.report.totals.actual_input_tokens;
    expect(a(noReturns)).toBeGreaterThan(a(noHistory));
    expect(a(noHistory)).toBeGreaterThan(a(elisionOnly));
    expect(a(elisionOnly)).toBeGreaterThan(a(shipped));
    expect(a(keep3)).toBeGreaterThan(a(shipped));
    expect(a(shipped)).toBeGreaterThan(a(keep1));
  }, 180_000);
});
