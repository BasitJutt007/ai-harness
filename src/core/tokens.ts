/**
 * Token ledger: per-turn actual vs shadow-baseline input tokens.
 *
 * Every turn the loop counts the request it actually sends AND the request it
 * would have sent with JIT context, compact returns and history compaction
 * disabled (the shadow baseline), using the same counter, so the ratio compares
 * like with like. `compareRuns` compares two real runs (measured mode).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface TurnTokens {
  turn: number;
  actual: number;
  baseline: number;
  providerInput: number;
  providerCached: number;
  output: number;
  attribution: { frontLoadChars: number; rawReturnChars: number; historyChars: number };
}

export interface TokenLedgerMeta {
  runId: string;
  task: string;
  driver: string;
  model: string;
  counter: string;
  mode: 'jit' | 'baseline';
}

export interface TokenTurnRow {
  turn: number;
  actual_input_tokens: number;
  baseline_input_tokens: number;
  reduction_pct: number;
  provider_reported_input_tokens: number;
  provider_cached_input_tokens: number;
  output_tokens: number;
}

export interface TokenReport {
  runId: string;
  task: string;
  driver: string;
  model: string;
  mode: 'jit' | 'baseline';
  counter: string;
  method: 'shadow-baseline';
  baselineDefinition: string;
  turns: TokenTurnRow[];
  totals: {
    actual_input_tokens: number;
    baseline_input_tokens: number;
    reduction_pct: number;
    provider_reported_input_tokens: number;
    output_tokens: number;
  };
  /** Characters kept out of the actual requests, summed over all turns. */
  attribution_chars: { front_load_avoided: number; raw_returns_avoided: number; history_compacted: number };
}

/**
 * Exactly what the shadow baseline is (also written into every tokens/<runId>.json).
 * It is what a naive harness would send, and nothing more:
 * - system: the same system prompt + every text file under the API root as it was at
 *   run start (node_modules/.git/dist and binary files excluded; capped at 200 KB) +
 *   every standards check's full doc (tool schemas are not repeated: both requests carry
 *   the same tools array, counted once);
 * - the same tool list and the same first message (task brief);
 * - history: the same assistant turns verbatim, every tool result replaced by the tool's
 *   raw (naive, uncapped) return, nothing elided or compacted.
 * Both requests are counted with the same counter in the same turn.
 */
export const BASELINE_DEFINITION =
  'same request with JIT fetchers and compaction disabled: system = same system prompt + every text file under the API root at run start (node_modules/.git/dist and binary files excluded, 200 KB cap) + every standards doc in full; same tools array (tool schemas counted once, not repeated in the system prompt) and same task brief; history = same assistant turns verbatim with each tool result replaced by its raw (naive, uncapped) return: whole files with line numbers, full listings and search hits, the test runner console output, the full standards report, the full contract diff; no input elision, no history compaction; same token counter';

export function reductionPct(actual: number, baseline: number): number {
  if (baseline <= 0) return 0;
  return Math.round(1000 * (1 - actual / baseline)) / 10;
}

export class TokenLedger {
  private readonly rows: TurnTokens[] = [];
  /** Counts where the driver's counter failed and a chars/4 estimate was used instead. */
  private estimated = 0;

  constructor(readonly meta: TokenLedgerMeta) {}

  record(t: TurnTokens): void {
    this.rows.push(t);
  }

  /** Record that one count (actual or baseline) fell back to the chars/4 estimate. */
  noteEstimated(): void {
    this.estimated += 1;
  }

  /** The counter label, honest about fallbacks: never name a counter that did not produce the numbers. */
  counterLabel(): string {
    return this.estimated === 0 ? this.meta.counter : `chars/4 estimate for ${this.estimated} count(s): ${this.meta.counter} was unavailable`;
  }

  report(): TokenReport {
    const turns: TokenTurnRow[] = this.rows.map((t) => ({
      turn: t.turn,
      actual_input_tokens: t.actual,
      baseline_input_tokens: t.baseline,
      reduction_pct: reductionPct(t.actual, t.baseline),
      provider_reported_input_tokens: t.providerInput,
      provider_cached_input_tokens: t.providerCached,
      output_tokens: t.output,
    }));
    const sum = (f: (t: TurnTokens) => number): number => this.rows.reduce((n, t) => n + f(t), 0);
    const actual = sum((t) => t.actual);
    const baseline = sum((t) => t.baseline);
    return {
      runId: this.meta.runId,
      task: this.meta.task,
      driver: this.meta.driver,
      model: this.meta.model,
      mode: this.meta.mode,
      counter: this.counterLabel(),
      method: 'shadow-baseline',
      baselineDefinition: BASELINE_DEFINITION,
      turns,
      totals: {
        actual_input_tokens: actual,
        baseline_input_tokens: baseline,
        reduction_pct: reductionPct(actual, baseline),
        provider_reported_input_tokens: sum((t) => t.providerInput),
        output_tokens: sum((t) => t.output),
      },
      attribution_chars: {
        front_load_avoided: sum((t) => t.attribution.frontLoadChars),
        raw_returns_avoided: sum((t) => t.attribution.rawReturnChars),
        history_compacted: sum((t) => t.attribution.historyChars),
      },
    };
  }

  /** Writes <tokensDir>/<runId>.json and returns its absolute path. */
  write(tokensDir: string): string {
    mkdirSync(tokensDir, { recursive: true });
    const file = join(tokensDir, `${this.meta.runId}.json`);
    writeFileSync(file, `${JSON.stringify(this.report(), null, 2)}\n`, 'utf8');
    return file;
  }
}

export interface RunTokenSide {
  runId: string;
  driver: string;
  model: string;
  mode: string;
  turns: number;
  input_tokens: number;
  provider_reported_input_tokens: number;
  output_tokens: number;
  avg_input_tokens_per_turn: number;
}

export interface TokenComparison {
  method: 'measured';
  definition: string;
  task: string;
  jit: RunTokenSide;
  baseline: RunTokenSide;
  reduction_pct: number;
  provider_reported_reduction_pct: number;
  per_turn_reduction_pct: number;
  caveats: string[];
}

function side(r: TokenReport): RunTokenSide {
  const n = r.turns.length;
  return {
    runId: r.runId,
    driver: r.driver,
    model: r.model,
    mode: r.mode,
    turns: n,
    input_tokens: r.totals.actual_input_tokens,
    provider_reported_input_tokens: r.totals.provider_reported_input_tokens,
    output_tokens: r.totals.output_tokens,
    avg_input_tokens_per_turn: n === 0 ? 0 : Math.round(r.totals.actual_input_tokens / n),
  };
}

/** Measured comparison of two real runs of the same task (one JIT, one --baseline). */
export function compareRuns(actual: TokenReport, baseline: TokenReport): TokenComparison {
  const a = side(actual);
  const b = side(baseline);
  const caveats: string[] = [];
  if (actual.task !== baseline.task) caveats.push(`different tasks: ${actual.task} vs ${baseline.task}`);
  if (actual.mode !== 'jit') caveats.push(`first run is not a JIT run (mode ${actual.mode})`);
  if (baseline.mode !== 'baseline') caveats.push(`second run is not a --baseline run (mode ${baseline.mode})`);
  if (actual.counter !== baseline.counter) caveats.push(`different token counters: ${actual.counter} vs ${baseline.counter}`);
  if (a.turns !== b.turns) caveats.push(`turn counts differ (${a.turns} vs ${b.turns}): model behaviour differs between runs`);
  return {
    method: 'measured',
    definition: 'two real runs of the same task: one with JIT context, compact returns and history compaction, one with all three disabled (--baseline)',
    task: actual.task,
    jit: a,
    baseline: b,
    reduction_pct: reductionPct(a.input_tokens, b.input_tokens),
    provider_reported_reduction_pct: reductionPct(a.provider_reported_input_tokens, b.provider_reported_input_tokens),
    per_turn_reduction_pct: reductionPct(a.avg_input_tokens_per_turn, b.avg_input_tokens_per_turn),
    caveats,
  };
}

/** Compact text rendering of a token report (CLI). */
export function formatTokenReport(r: TokenReport): string {
  const lines = [
    `tokens  run ${r.runId}  task ${r.task}  driver ${r.driver}  model ${r.model}  mode ${r.mode}`,
    `counter ${r.counter}  method ${r.method}`,
    'turn   actual   baseline  reduction  provider_in  cached  output',
  ];
  for (const t of r.turns) {
    lines.push(
      `${String(t.turn).padStart(4)} ${String(t.actual_input_tokens).padStart(8)} ${String(t.baseline_input_tokens).padStart(10)} ` +
        `${`${t.reduction_pct}%`.padStart(10)} ${String(t.provider_reported_input_tokens).padStart(12)} ` +
        `${String(t.provider_cached_input_tokens).padStart(7)} ${String(t.output_tokens).padStart(7)}`,
    );
  }
  const x = r.totals;
  lines.push(
    `total  actual ${x.actual_input_tokens}  baseline ${x.baseline_input_tokens}  reduction ${x.reduction_pct}%  ` +
      `provider_in ${x.provider_reported_input_tokens}  output ${x.output_tokens}`,
  );
  const c = r.attribution_chars;
  lines.push(
    `chars avoided  front-load ${c.front_load_avoided}  raw-returns ${c.raw_returns_avoided}  history ${c.history_compacted}`,
  );
  return lines.join('\n');
}

const TurnRowSchema = z.object({
  turn: z.number(),
  actual_input_tokens: z.number(),
  baseline_input_tokens: z.number(),
  reduction_pct: z.number(),
  provider_reported_input_tokens: z.number(),
  provider_cached_input_tokens: z.number(),
  output_tokens: z.number(),
});

const TokenReportSchema = z.object({
  runId: z.string(),
  task: z.string(),
  driver: z.string(),
  model: z.string(),
  mode: z.enum(['jit', 'baseline']),
  counter: z.string(),
  method: z.literal('shadow-baseline'),
  baselineDefinition: z.string(),
  turns: z.array(TurnRowSchema),
  totals: z.object({
    actual_input_tokens: z.number(),
    baseline_input_tokens: z.number(),
    reduction_pct: z.number(),
    provider_reported_input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  attribution_chars: z.object({
    front_load_avoided: z.number(),
    raw_returns_avoided: z.number(),
    history_compacted: z.number(),
  }),
});

/** Validate a token report read back from disk. */
export function parseTokenReport(v: unknown): TokenReport {
  const r = TokenReportSchema.safeParse(v);
  if (!r.success) throw new Error(`not a token report: ${r.error.issues[0]?.message ?? 'invalid shape'}`);
  return r.data;
}
