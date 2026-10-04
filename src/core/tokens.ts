/**
 * Token ledger: per-turn actual vs baseline input tokens.
 *
 * The baseline (BASELINE_DEFINITION) is the same task on the same driver with the context
 * fetchers and compaction disabled. It comes in two kinds, always labelled `baseline_kind`:
 *  - shadow    (normal runs): every turn the loop counts the request it sends AND the baseline
 *              request rebuilt from the same trajectory, with the same counter; never sent.
 *  - measured  (`--baseline` runs): every request sent IS the baseline request (actual == baseline).
 * `compareRuns` compares a normal run with a measured `--baseline` run of the same task.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface TurnTokens {
  turn: number;
  actual: number;
  baseline: number;
  providerInput: number;
  providerCached: number;
  output: number;
  /**
   * Characters kept out of the actual request (shadow only): the front-load, raw returns replaced
   * by compact ones, folded history; `fetchChars` is the reverse: the run's own context-fetch
   * traffic, left out of the shadow baseline because a baseline harness would not fetch.
   */
  attribution: { frontLoadChars: number; rawReturnChars: number; historyChars: number; fetchChars?: number };
  /** False when the driver reported no provider usage for this turn (its numbers are then 0). Default true. */
  providerReported?: boolean;
  /** True when this turn's counts are the chars/4 fallback (the driver's counter failed). */
  estimated?: boolean;
}

export type TokenMode = 'jit' | 'baseline';
export type BaselineKind = 'shadow' | 'measured';
/** reported: every turn; none: no turn (an offline driver); partial: some turns; unknown: a report written before this was recorded. */
export type ProviderUsage = 'reported' | 'none' | 'partial' | 'unknown';

export interface TokenLedgerMeta {
  runId: string;
  task: string;
  driver: string;
  model: string;
  counter: string;
  mode: TokenMode;
}

export interface TokenTurnRow {
  turn: number;
  actual_input_tokens: number;
  baseline_input_tokens: number;
  reduction_pct: number;
  provider_reported_input_tokens: number;
  provider_cached_input_tokens: number;
  output_tokens: number;
  /** Present when the driver's counter failed and both counts of the turn are chars/4 estimates. */
  estimated?: true;
}

export interface TokenReport {
  runId: string;
  task: string;
  driver: string;
  model: string;
  mode: TokenMode;
  counter: string;
  /** shadow: an estimate rebuilt from this run's trajectory, never sent; measured: what a --baseline run sent. */
  baseline_kind: BaselineKind;
  method: 'shadow-baseline' | 'measured-baseline';
  baselineDefinition: string;
  /** What this report's baseline is, and how to get the measured one. */
  baseline_note: string;
  provider_usage: ProviderUsage;
  turns: TokenTurnRow[];
  totals: {
    actual_input_tokens: number;
    baseline_input_tokens: number;
    reduction_pct: number;
    provider_reported_input_tokens: number;
    output_tokens: number;
  };
  /** Characters kept out of the actual requests, summed over all turns (see TurnTokens.attribution). */
  attribution_chars: { front_load_avoided: number; raw_returns_avoided: number; history_compacted: number; fetch_traffic_left_out: number };
}

/**
 * Exactly what the baseline request is (also written into every tokens/<runId>.json). It is
 * what a naive harness would send, and nothing more.
 */
export const BASELINE_DEFINITION =
  'the same task on the same driver and model with the context fetchers and compaction disabled. Request per turn: ' +
  'system = the baseline system prompt (it says the repository is included) + every text file under the API root, ' +
  're-read from the current tree before that turn (node_modules/.git/dist and binary files excluded, 200 KB cap) + every standards doc in full; ' +
  'tools = the same tools minus the context fetchers (read tools and tools that declare fetcher: true), ' +
  'tool schemas counted once in the tools array, not repeated in the system prompt; the same task brief; ' +
  'history = the same assistant turns verbatim with each tool result replaced by its raw (naive, uncapped) return: ' +
  'whole files with line numbers, the test runner console output, the full standards report, the full contract diff; ' +
  'no input elision, no history compaction; counted with the same token counter as the actual request';

/** baseline_note of a normal (JIT) run. */
export const SHADOW_NOTE =
  'baseline_kind "shadow": an estimate that was never sent. Every turn the baseline request (baselineDefinition) is rebuilt ' +
  "from THIS run's own trajectory: the same assistant turns with raw returns, the current tree front-loaded, and this run's " +
  'context-fetch calls left out (a baseline harness has that content front-loaded). A real baseline run may take a different path. ' +
  'For the measured baseline, run the same task on the same driver and model with `harness run <task> --baseline`, then ' +
  '`harness tokens compare <thisRunId> <baselineRunId>`; prefer that measured comparison wherever it exists.';

/** baseline_note of a --baseline run. */
export const MEASURED_NOTE =
  'baseline_kind "measured": this run ran with the context fetchers and compaction disabled (--baseline), so every request it sent ' +
  'was the baseline request (baselineDefinition) and actual == baseline on every turn. Compare it with a normal run of the same ' +
  'task on the same driver and model: `harness tokens compare <jitRunId> <thisRunId>`.';

export function baselineKindOf(mode: TokenMode): BaselineKind {
  return mode === 'baseline' ? 'measured' : 'shadow';
}

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

  providerUsage(): ProviderUsage {
    const reported = this.rows.filter((t) => t.providerReported !== false).length;
    if (reported === 0) return 'none';
    return reported === this.rows.length ? 'reported' : 'partial';
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
      ...(t.estimated === true ? { estimated: true as const } : {}),
    }));
    const sum = (f: (t: TurnTokens) => number): number => this.rows.reduce((n, t) => n + f(t), 0);
    const actual = sum((t) => t.actual);
    const baseline = sum((t) => t.baseline);
    const kind = baselineKindOf(this.meta.mode);
    return {
      runId: this.meta.runId,
      task: this.meta.task,
      driver: this.meta.driver,
      model: this.meta.model,
      mode: this.meta.mode,
      counter: this.counterLabel(),
      baseline_kind: kind,
      method: kind === 'measured' ? 'measured-baseline' : 'shadow-baseline',
      baselineDefinition: BASELINE_DEFINITION,
      baseline_note: kind === 'measured' ? MEASURED_NOTE : SHADOW_NOTE,
      provider_usage: this.providerUsage(),
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
        fetch_traffic_left_out: sum((t) => t.attribution.fetchChars ?? 0),
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

// ───────────────────────────── measured comparison ─────────────────────────────

export interface RunTokenSide {
  runId: string;
  driver: string;
  model: string;
  mode: string;
  baseline_kind: BaselineKind;
  counter: string;
  provider_usage: ProviderUsage;
  turns: number;
  input_tokens: number;
  provider_reported_input_tokens: number;
  output_tokens: number;
  avg_input_tokens_per_turn: number;
}

export interface TokenComparison {
  method: 'measured';
  baseline_kind: 'measured';
  definition: string;
  task: string;
  jit: RunTokenSide;
  baseline: RunTokenSide;
  /** Per-run totals (see explanations.reduction_pct). */
  reduction_pct: number;
  /** Per-turn averages (see explanations.per_turn_reduction_pct). */
  per_turn_reduction_pct: number;
  /** Per-run totals of provider-reported input; null when either run has no provider usage. */
  provider_reported_reduction_pct: number | null;
  /** The JIT run's own shadow estimate, for reference only (the measured ratios above are preferred). */
  jit_shadow_reduction_pct: number;
  explanations: { reduction_pct: string; per_turn_reduction_pct: string; provider_reported_reduction_pct: string; jit_shadow_reduction_pct: string };
  caveats: string[];
}

export const COMPARISON_DEFINITION =
  'two real runs of the same task: one normal run (context fetchers, compact returns, history compaction) and one --baseline run ' +
  '(context fetchers and compaction disabled; baselineDefinition of its token report). Both numbers are what each run counted for ' +
  'the requests it actually sent.';

export const COMPARISON_EXPLANATIONS: TokenComparison['explanations'] = {
  reduction_pct:
    'per-run totals: 1 - (input tokens summed over every turn of the normal run) / (the same sum for the --baseline run). ' +
    'It depends on how many turns each run took, so it mixes context size with the path each run took.',
  per_turn_reduction_pct:
    "per-turn average: 1 - (normal run's input tokens per turn) / (--baseline run's input tokens per turn), each run's total " +
    'divided by its own turn count. Independent of the turn counts: the closer measure of context size per request when the runs took different paths.',
  provider_reported_reduction_pct:
    'the per-run-totals ratio over the input tokens the provider reported; null when either run has no provider-reported usage (an offline driver).',
  jit_shadow_reduction_pct:
    "the normal run's own shadow estimate (its token report), shown for reference: an estimate from one trajectory, never sent.",
};

function side(r: TokenReport): RunTokenSide {
  const n = r.turns.length;
  return {
    runId: r.runId,
    driver: r.driver,
    model: r.model,
    mode: r.mode,
    baseline_kind: r.baseline_kind,
    counter: r.counter,
    provider_usage: r.provider_usage,
    turns: n,
    input_tokens: r.totals.actual_input_tokens,
    provider_reported_input_tokens: r.totals.provider_reported_input_tokens,
    output_tokens: r.totals.output_tokens,
    avg_input_tokens_per_turn: n === 0 ? 0 : Math.round(r.totals.actual_input_tokens / n),
  };
}

/** Measured comparison of two real runs of the same task (a normal run, then a --baseline run). */
export function compareRuns(actual: TokenReport, baseline: TokenReport): TokenComparison {
  const a = side(actual);
  const b = side(baseline);
  const caveats: string[] = [];
  if (actual.task !== baseline.task) caveats.push(`different tasks: ${actual.task} vs ${baseline.task}`);
  if (actual.mode !== 'jit') caveats.push(`first run is not a normal (JIT) run (mode ${actual.mode})`);
  if (baseline.mode !== 'baseline') caveats.push(`second run is not a --baseline run (mode ${baseline.mode}): its baseline is not measured`);
  if (a.driver !== b.driver) caveats.push(`different drivers: ${a.driver} vs ${b.driver} (the baseline is defined on the same driver)`);
  if (a.model !== b.model) caveats.push(`different models: ${a.model} vs ${b.model} (the baseline is defined on the same model)`);
  if (actual.counter !== baseline.counter) caveats.push(`different token counters: ${actual.counter} vs ${baseline.counter}`);
  for (const s of [a, b]) {
    if (s.turns === 0) caveats.push(`run ${s.runId} recorded no turns: its ratios are meaningless`);
    if (s.provider_usage === 'none') caveats.push(`run ${s.runId} has no provider-reported usage (an offline driver): provider_reported_reduction_pct is null`);
    else if (s.provider_usage !== 'reported') caveats.push(`run ${s.runId} provider usage is ${s.provider_usage}: the provider-reported ratio may undercount`);
  }
  if (a.turns !== b.turns) {
    caveats.push(
      `turn counts differ (${a.turns} vs ${b.turns}): the runs took different paths; reduction_pct (per-run totals) reflects that, per_turn_reduction_pct (per-turn averages) does not`,
    );
  }
  const providerKnown = a.provider_usage !== 'none' && b.provider_usage !== 'none' && b.provider_reported_input_tokens > 0;
  return {
    method: 'measured',
    baseline_kind: 'measured',
    definition: COMPARISON_DEFINITION,
    task: actual.task,
    jit: a,
    baseline: b,
    reduction_pct: reductionPct(a.input_tokens, b.input_tokens),
    per_turn_reduction_pct: reductionPct(a.avg_input_tokens_per_turn, b.avg_input_tokens_per_turn),
    provider_reported_reduction_pct: providerKnown ? reductionPct(a.provider_reported_input_tokens, b.provider_reported_input_tokens) : null,
    jit_shadow_reduction_pct: actual.totals.reduction_pct,
    explanations: COMPARISON_EXPLANATIONS,
    caveats,
  };
}

/** Text lines of a comparison (CLI). */
export function formatComparison(c: TokenComparison): string[] {
  const run = (label: string, s: RunTokenSide): string =>
    `${label.padEnd(9)} ${s.runId}: ${s.input_tokens} input tokens over ${s.turns} turns (${s.avg_input_tokens_per_turn} per turn; provider ${s.provider_usage === 'none' ? 'not reported' : s.provider_reported_input_tokens})`;
  return [
    `measured  task ${c.task}  (baseline_kind measured)`,
    run('jit', c.jit),
    run('baseline', c.baseline),
    `reduction ${c.reduction_pct}% per-run totals, ${c.per_turn_reduction_pct}% per-turn average, ` +
      `${c.provider_reported_reduction_pct === null ? 'provider-reported n/a' : `${c.provider_reported_reduction_pct}% provider-reported`}` +
      `  (the normal run's own shadow estimate: ${c.jit_shadow_reduction_pct}%)`,
    ...c.caveats.map((x) => `caveat    ${x}`),
  ];
}

/** A measured comparison found on disk (compare-<jit>-vs-<baseline>.json). */
export interface ComparisonOnDisk {
  file: string;
  jitRunId: string;
  baselineRunId: string;
  reduction_pct: number;
  per_turn_reduction_pct: number | null;
  caveats: string[];
}

const ComparisonFileSchema = z.looseObject({
  method: z.literal('measured'),
  jit: z.looseObject({ runId: z.string() }),
  baseline: z.looseObject({ runId: z.string() }),
  reduction_pct: z.number(),
  per_turn_reduction_pct: z.number().optional(),
  caveats: z.array(z.string()).optional(),
});

/** Measured comparisons in `tokensDir` that involve `runId` (either side), by file name. */
export function comparisonsFor(tokensDir: string, runId: string): ComparisonOnDisk[] {
  if (!existsSync(tokensDir)) return [];
  const out: ComparisonOnDisk[] = [];
  for (const name of readdirSync(tokensDir).filter((n) => n.startsWith('compare-') && n.endsWith('.json')).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(tokensDir, name), 'utf8'));
    } catch {
      continue;
    }
    const r = ComparisonFileSchema.safeParse(parsed);
    if (!r.success || (r.data.jit.runId !== runId && r.data.baseline.runId !== runId)) continue;
    out.push({
      file: join(tokensDir, name),
      jitRunId: r.data.jit.runId,
      baselineRunId: r.data.baseline.runId,
      reduction_pct: r.data.reduction_pct,
      per_turn_reduction_pct: r.data.per_turn_reduction_pct ?? null,
      caveats: r.data.caveats ?? [],
    });
  }
  return out;
}

/** Compact text rendering of a token report (CLI). */
export function formatTokenReport(r: TokenReport): string {
  const kind = r.baseline_kind === 'measured' ? 'measured (--baseline run: actual == baseline)' : 'shadow estimate (never sent)';
  const lines = [
    `tokens  run ${r.runId}  task ${r.task}  driver ${r.driver}  model ${r.model}  mode ${r.mode}`,
    `counter ${r.counter}  baseline ${kind}  provider usage ${r.provider_usage}`,
    'turn   actual   baseline  reduction  provider_in  cached  output',
  ];
  for (const t of r.turns) {
    lines.push(
      `${String(t.turn).padStart(4)} ${String(t.actual_input_tokens).padStart(8)} ${String(t.baseline_input_tokens).padStart(10)} ` +
        `${`${t.reduction_pct}%`.padStart(10)} ${String(t.provider_reported_input_tokens).padStart(12)} ` +
        `${String(t.provider_cached_input_tokens).padStart(7)} ${String(t.output_tokens).padStart(7)}${t.estimated === true ? '  (chars/4 estimate)' : ''}`,
    );
  }
  const x = r.totals;
  lines.push(
    `total  actual ${x.actual_input_tokens}  baseline ${x.baseline_input_tokens}  reduction ${x.reduction_pct}%  ` +
      `provider_in ${x.provider_reported_input_tokens}  output ${x.output_tokens}`,
  );
  const c = r.attribution_chars;
  lines.push(
    `chars avoided  front-load ${c.front_load_avoided}  raw-returns ${c.raw_returns_avoided}  history ${c.history_compacted}  ` +
      `(fetch traffic left out of the baseline ${c.fetch_traffic_left_out})`,
  );
  lines.push(`baseline: ${r.baseline_note}`);
  return lines.join('\n');
}

// ───────────────────────────── reading reports back ─────────────────────────────

const TurnRowSchema = z.object({
  turn: z.number(),
  actual_input_tokens: z.number(),
  baseline_input_tokens: z.number(),
  reduction_pct: z.number(),
  provider_reported_input_tokens: z.number(),
  provider_cached_input_tokens: z.number(),
  output_tokens: z.number(),
  estimated: z.literal(true).optional(),
});

/** Current shape; the fields added later are optional so reports written before them still read. */
const TokenReportSchema = z.object({
  runId: z.string(),
  task: z.string(),
  driver: z.string(),
  model: z.string(),
  mode: z.enum(['jit', 'baseline']),
  counter: z.string(),
  baseline_kind: z.enum(['shadow', 'measured']).optional(),
  method: z.enum(['shadow-baseline', 'measured-baseline']),
  baselineDefinition: z.string(),
  baseline_note: z.string().optional(),
  provider_usage: z.enum(['reported', 'none', 'partial', 'unknown']).optional(),
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
    fetch_traffic_left_out: z.number().optional(),
  }),
});

/**
 * Validate a token report read back from disk. A report written before baseline_kind existed
 * gets it from its mode (a --baseline run's requests were the baseline: measured), and
 * provider_usage `unknown` (it did not say whether an offline driver estimated it).
 */
export function parseTokenReport(v: unknown): TokenReport {
  const r = TokenReportSchema.safeParse(v);
  if (!r.success) throw new Error(`not a token report: ${r.error.issues[0]?.message ?? 'invalid shape'}`);
  const d = r.data;
  const kind = d.baseline_kind ?? baselineKindOf(d.mode);
  const turns: TokenTurnRow[] = d.turns.map(({ estimated, ...row }) => (estimated === true ? { ...row, estimated } : row));
  return {
    runId: d.runId,
    task: d.task,
    driver: d.driver,
    model: d.model,
    mode: d.mode,
    counter: d.counter,
    baseline_kind: kind,
    method: kind === 'measured' ? 'measured-baseline' : 'shadow-baseline',
    baselineDefinition: d.baselineDefinition,
    baseline_note: d.baseline_note ?? (kind === 'measured' ? MEASURED_NOTE : SHADOW_NOTE),
    provider_usage: d.provider_usage ?? 'unknown',
    turns,
    totals: d.totals,
    attribution_chars: { ...d.attribution_chars, fetch_traffic_left_out: d.attribution_chars.fetch_traffic_left_out ?? 0 },
  };
}
