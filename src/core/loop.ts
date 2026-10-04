/**
 * The agent loop. Provider-neutral: it only speaks Message / Part / ToolSpec.
 *
 * Per turn: build the actual request (JIT view) and the baseline request (front-load of the
 * current tree, raw returns, no context fetchers; in --baseline mode it IS the actual request) →
 * count both with the same counter → driver.complete (retried on thrown errors; a rate limit's
 * wait comes from the driver, else a standard Retry-After) → ledger.record → run each tool call
 * in order (validate → pre hooks → run → post hooks) → persist.
 * `finish` runs the finish gates; only an all-green gate run ends the loop as `done`.
 */
import { serializeState } from './run-store.ts';
import { baselineView, fetcherNames, jitView, messageChars, repeatPointer, type RepeatRef, type TranscriptTurn } from './context.ts';
import { runGates, type GateOutcome } from './gates.ts';
import { runPostHooks, runPreHooks } from './hooks.ts';
import type { TokenLedger, TurnTokens } from './tokens.ts';
import type {
  Driver,
  LogStore,
  Message,
  ModelRequest,
  ModelResponse,
  RunContext,
  ToolCallInfo,
  ToolCallPart,
  ToolEffect,
  ToolPlugin,
  ToolResult,
  ToolResultPart,
  ToolSpec,
} from './types.ts';

/** The subset of RunStore the loop writes to (RunStore satisfies it structurally). */
export interface AgentStore {
  readonly logs: LogStore;
  appendTranscript(entry: unknown): void;
  writeJson(name: string, value: unknown): void;
}

/** `aborted` = stopped by the operator (Ctrl-C / AbortSignal); evidence is still written. */
export type AgentStatus = 'done' | 'max_turns' | 'refused' | 'stalled' | 'error' | 'aborted';

export interface AgentResult {
  status: AgentStatus;
  turns: number;
  finish?: GateOutcome;
  error?: string;
}

export interface RunAgentOptions {
  driver: Driver;
  ctx: RunContext;
  store: AgentStore;
  ledger: TokenLedger;
  first: Message;
  /** System prompt of the actual (JIT) request; unused in baseline mode. */
  system: string;
  /**
   * System prompt of the baseline request: the baseline prompt + the repository + every standards
   * doc. A function is called once per turn so the repository is re-rendered from the CURRENT tree
   * (files written in earlier turns are visible); a string is used as is every turn.
   */
  baselineSystem: string | (() => Promise<string>);
  /** Tools of the actual (JIT) request; the baseline request offers these minus the context fetchers. */
  tools: ToolSpec[];
  maxTurns: number;
  maxOutputTokens: number;
  /** Backoff before each retry of driver.complete (default 1s, 4s, 10s). */
  retryDelaysMs?: number[];
  /** Operator abort: checked before every turn and every tool call, and passed to driver.complete. */
  signal?: AbortSignal;
  /** How the loop waits between attempts (default: a timer that an abort cuts short); a test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const RAW_LOG_THRESHOLD = 2048;
export const MAX_IDLE_TURNS = 3;
const DEFAULT_RETRY_DELAYS = [1000, 4000, 10000];

export const NUDGE =
  'No tool call received. Continue the workflow with a tool call; when the work is complete call finish (the harness runs the gates).';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return (i === -1 ? s : s.slice(0, i)).slice(0, 200);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted === true) return r();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      r();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

class AbortedError extends Error {}

/** The provider asked for a wait longer than RATE_LIMIT_MAX_WAIT_MS (a daily quota): stop instead of waiting. */
class RateLimitStop extends Error {}

/** Longest provider-requested wait the loop honours (per-minute limits); a longer one is a quota: stop. */
export const RATE_LIMIT_MAX_WAIT_MS = 120_000;
/** Cap on provider-requested waits per request (they do not consume the normal retry budget). */
export const MAX_RATE_LIMIT_WAITS = 30;

/** HTTP statuses whose standard Retry-After header the loop honours without a driver's help. */
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** A header of a generic error shape: `headers` as a record (any letter case) or with a `get(name)` method. */
function headerOf(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const get: unknown = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const v: unknown = get.call(headers, name);
    return typeof v === 'string' ? v : null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** A Retry-After value (delta seconds or an HTTP date) → ms from `now` (at least 0), or null. */
export function parseRetryAfter(value: string, now: number = Date.now()): number | null {
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.ceil(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * The generic fallback: the standard Retry-After header of an error with HTTP status 429 or 503
 * (`status` and `headers` on the thrown value), else null. No provider's own error format is read
 * here: those belong to the driver (Driver.retryAfterMs).
 */
export function genericRetryAfterMs(e: unknown, now: number = Date.now()): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const status: unknown = (e as { status?: unknown }).status;
  if (typeof status !== 'number' || !RETRY_AFTER_STATUSES.has(status)) return null;
  const value = headerOf((e as { headers?: unknown }).headers, 'retry-after');
  return value === null ? null : parseRetryAfter(value, now);
}

/** The wait a failed complete() asks for: the driver's reading first, then the generic header; null when none. */
export function retryAfterMs(driver: Pick<Driver, 'retryAfterMs'>, e: unknown): number | null {
  let asked: number | null = null;
  try {
    asked = driver.retryAfterMs?.(e) ?? null;
  } catch {
    asked = null; // a driver's parser never turns a retry into a crash
  }
  if (asked !== null && Number.isFinite(asked) && asked >= 0) return Math.ceil(asked);
  return genericRetryAfterMs(e);
}

/** A function (not an inline property read) so TypeScript does not narrow `aborted` across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function completeWithRetry(
  driver: Driver,
  req: ModelRequest,
  delays: number[],
  ctx: RunContext,
  signal: AbortSignal | undefined,
  wait: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<ModelResponse> {
  let attempt = 0;
  let rateWaits = 0;
  for (;;) {
    try {
      return await driver.complete(req, signal);
    } catch (e) {
      if (isAborted(signal)) throw new AbortedError('aborted during driver.complete');
      // A rate limit that names its wait: honour a short one (per-minute limits) outside the
      // normal retry budget; a long one (a daily quota) will not clear in this run: stop.
      const asked = retryAfterMs(driver, e);
      if (asked !== null && asked > RATE_LIMIT_MAX_WAIT_MS) {
        throw new RateLimitStop(`rate limited: the provider asked to retry in ${Math.round(asked / 1000)}s, longer than the ${RATE_LIMIT_MAX_WAIT_MS / 1000}s the harness waits: ${errMsg(e)}`);
      }
      if (asked !== null && rateWaits < MAX_RATE_LIMIT_WAITS) {
        rateWaits += 1;
        ctx.emit({ kind: 'note', source: 'driver', message: `rate limited: the provider asked to retry in ${Math.ceil(asked / 1000)}s; waiting (${rateWaits}/${MAX_RATE_LIMIT_WAITS})` });
        await wait(asked + 1000, signal);
        if (isAborted(signal)) throw new AbortedError('aborted while waiting out a rate limit');
        continue;
      }
      const delay = delays[attempt];
      if (delay === undefined) throw e;
      attempt += 1;
      ctx.emit({ kind: 'error', source: 'driver', message: `complete failed (attempt ${attempt}): ${errMsg(e)}; retrying in ${delay} ms` });
      await wait(delay, signal);
      if (isAborted(signal)) throw new AbortedError('aborted while waiting to retry');
    }
  }
}

/** chars/4 of a request (system, messages, tool schemas): the fallback when the driver's counter fails. */
export function estimateTokens(req: ModelRequest): number {
  return Math.ceil((req.system.length + messageChars(req.messages) + (JSON.stringify(req.tools) ?? '').length) / 4);
}

/**
 * Counts each request of one turn with the driver's counter, in order. If any count fails, EVERY
 * request of the turn is estimated (chars/4) instead, so a turn's ratio never compares two counters.
 */
async function countTurn(
  driver: Driver,
  reqs: Array<{ label: string; req: ModelRequest }>,
  ctx: RunContext,
  ledger: TokenLedger,
): Promise<{ counts: number[]; estimated: boolean }> {
  const counts: number[] = [];
  for (const { label, req } of reqs) {
    try {
      counts.push(await driver.countTokens(req));
    } catch (e) {
      const est = reqs.map((r) => estimateTokens(r.req));
      for (let i = 0; i < reqs.length; i += 1) ledger.noteEstimated();
      const labels = reqs.map((r) => r.label).join(' and ');
      ctx.emit({ kind: 'error', source: 'driver', message: `countTokens(${label}) failed: ${errMsg(e)}; this turn's ${labels} counts are chars/4 estimates (${est.join(', ')})` });
      return { counts: est, estimated: true };
    }
  }
  return { counts, estimated: false };
}

interface CallOutcome {
  part: ToolResultPart;
  /** Baseline-visible content (raw output + notes). */
  raw: string;
  logPath?: string;
  /** Set when the call was an accepted request to finish (gates ran). */
  finish?: GateOutcome;
  /** Canonical API-relative paths a successful write call touched (write-effect tools only). */
  written?: string[];
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .slice(0, 10)
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(input)'}: ${i.message}`)
    .join('; ');
}

/** Tool effects whose large raw output is persisted under runs/<id>/logs. */
const LOGGED_EFFECTS: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['exec', 'write']);

/**
 * Canonical API-relative paths a successful write call touched: the tool's own
 * report (`data.path` / `data.paths`) when present, else its declared paths(),
 * each normalised through the workspace (escapes are dropped).
 */
export function writtenPaths(result: ToolResult, declared: string[], ctx: Pick<RunContext, 'workspace'>): string[] {
  const reported: string[] = [];
  const data = result.data;
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>;
    if (typeof rec['path'] === 'string') reported.push(rec['path']);
    if (Array.isArray(rec['paths'])) for (const p of rec['paths']) if (typeof p === 'string') reported.push(p);
  }
  const out = new Set<string>();
  for (const p of reported.length > 0 ? reported : declared) {
    try {
      out.add(ctx.workspace.rel(p));
    } catch {
      // outside the API root: never recorded as written
    }
  }
  return [...out];
}

function errorOutcome(call: ToolCallPart, content: string): CallOutcome {
  return { part: { type: 'tool_result', callId: call.id, content, isError: true }, raw: content };
}

async function executeCall(
  call: ToolCallPart,
  tools: Map<string, ToolPlugin<unknown>>,
  ctx: RunContext,
): Promise<CallOutcome> {
  const tool = tools.get(call.name);
  if (tool === undefined) {
    ctx.emit({ kind: 'tool', source: call.name, decision: 'block', message: 'unknown tool' });
    return errorOutcome(call, `unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(', ')}`);
  }
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    ctx.emit({ kind: 'tool', source: tool.name, decision: 'block', message: 'invalid input' });
    return errorOutcome(call, `invalid input for ${tool.name}: ${formatIssues(parsed.error.issues)}`);
  }
  const input: unknown = parsed.data;
  let paths: string[];
  try {
    paths = tool.paths?.(input) ?? [];
  } catch (e) {
    return errorOutcome(call, `invalid input for ${tool.name}: ${errMsg(e)}`);
  }
  const info: ToolCallInfo = { id: call.id, tool: tool.name, effect: tool.effect, input, paths };

  const pre = await runPreHooks(ctx.registry.hooks, info, ctx);
  if (pre.blocked !== null) {
    return errorOutcome(call, `BLOCKED by ${pre.blocked.hook}: ${pre.blocked.reason}`);
  }

  let result: ToolResult;
  try {
    result = await tool.run(input, ctx);
  } catch (e) {
    result = { ok: false, summary: `tool ${tool.name} failed: ${errMsg(e)}` };
  }
  const written = tool.effect === 'write' && result.ok ? writtenPaths(result, paths, ctx) : undefined;
  for (const p of written ?? []) ctx.state.written.add(p);

  const post = await runPostHooks(ctx.registry.hooks, info, result, ctx);
  const notes = [...pre.notes, ...post.notes].map((n) => `[${n.hook}] ${n.note}`);
  if (post.blocked !== null) notes.push(`BLOCKED by ${post.blocked.hook}: ${post.blocked.reason}`);
  const isError = !result.ok || post.blocked !== null;

  const rawBody = result.raw ?? result.summary;
  let logPath: string | undefined;
  // Only side-effecting calls get a raw log: reads are reproducible from the tree and would bury the logs that matter.
  if (LOGGED_EFFECTS.has(tool.effect) && rawBody.length > RAW_LOG_THRESHOLD) logPath = await ctx.logs.write(`t${ctx.state.turn}-${tool.name}`, rawBody);
  ctx.emit({
    kind: 'tool',
    source: tool.name,
    decision: isError ? 'block' : 'pass',
    message: firstLine(result.summary),
    data: { callId: call.id, ok: result.ok, paths, logPath },
  });

  const withNotes = (body: string): string => (notes.length > 0 ? `${body}\n${notes.join('\n')}` : body);
  let visible = withNotes(ctx.mode.compactReturns ? result.summary : rawBody);
  const raw = withNotes(rawBody);

  let finish: GateOutcome | undefined;
  if (result.finish !== undefined && !isError) {
    ctx.state.finishAttempts += 1;
    finish = await runGates(ctx.registry.gates, ctx, 'finish');
    visible = finish.ok
      ? `FINISH ACCEPTED\n${finish.text}`
      : `FINISH REFUSED (attempt ${ctx.state.finishAttempts}). Fix the failing gates, then call finish again.\n${finish.compact}`;
    ctx.emit({ kind: 'note', source: 'finish', decision: finish.ok ? 'pass' : 'block', message: firstLine(visible) });
    return {
      part: { type: 'tool_result', callId: call.id, content: visible, isError: !finish.ok },
      raw: visible,
      finish,
      ...(logPath !== undefined ? { logPath } : {}),
    };
  }
  return {
    part: { type: 'tool_result', callId: call.id, content: visible, isError },
    raw,
    ...(logPath !== undefined ? { logPath } : {}),
    ...(written !== undefined ? { written } : {}),
  };
}

/** Key-order-independent JSON (models emit the same arguments in different key orders). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const rec = v as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** A call and its result as the model will see them in the next request. */
export interface VisibleCall {
  turn: number;
  call: ToolCallPart;
  result: ToolResultPart;
  /** Set when that result is itself a repeat pointer. */
  ref?: RepeatRef;
  /** Full content of the result (the pointed-to content for a pointer). */
  content: string;
}

/**
 * A read call whose freshly executed, model-visible result is byte-identical to the result of
 * an identical call (same tool, canonical JSON input) that the next request still shows: where
 * the full content lives. The read always ran, so a file changed by a write (even earlier in the
 * same turn) or by code run during tests is never mistaken for unchanged.
 */
export function findRepeat(call: ToolCallPart, content: string, visible: VisibleCall[], firstVisibleTurn: number): RepeatRef | null {
  const key = canonicalJson(call.input);
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const v = visible[i];
    if (v === undefined || v.result.isError || v.call.name !== call.name || v.content !== content) continue;
    if (canonicalJson(v.call.input) !== key) continue;
    const named = v.ref !== undefined && v.ref.turn >= firstVisibleTurn ? v.ref.turn : v.turn;
    return { turn: named, source: v.ref?.source ?? { turn: v.turn, callId: v.call.id } };
  }
  return null;
}

function visibleCalls(t: TranscriptTurn, all: TranscriptTurn[]): VisibleCall[] {
  const results = new Map<string, ToolResultPart>();
  for (const p of t.results?.parts ?? []) if (p.type === 'tool_result') results.set(p.callId, p);
  const out: VisibleCall[] = [];
  for (const p of t.assistant.parts) {
    if (p.type !== 'tool_call') continue;
    const result = results.get(p.id);
    if (result === undefined) continue;
    const ref = t.repeats?.[p.id];
    let content = result.content;
    if (ref !== undefined) {
      const src = all.find((x) => x.turn === ref.source.turn)?.results?.parts.find((x) => x.type === 'tool_result' && x.callId === ref.source.callId);
      if (src === undefined || src.type !== 'tool_result') continue;
      content = src.content;
    }
    out.push({ turn: t.turn, call: p, result, content, ...(ref !== undefined ? { ref } : {}) });
  }
  return out;
}

function offeredTools(ctx: RunContext, specs: ToolSpec[]): Map<string, ToolPlugin<unknown>> {
  const offered = new Set(specs.map((s) => s.name));
  const map = new Map<string, ToolPlugin<unknown>>();
  for (const rec of ctx.registry.tools) {
    const t: ToolPlugin<unknown> = rec.plugin;
    if (offered.has(t.name)) map.set(t.name, t);
  }
  return map;
}

/** Baseline mode = context fetchers and every compaction disabled (`--baseline`). */
export function isBaselineMode(mode: RunContext['mode']): boolean {
  return !mode.jit && !mode.compactReturns && !mode.compactHistory;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { driver, ctx, store, ledger, first, tools } = opts;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const baselineMode = isBaselineMode(ctx.mode);
  const keep = ctx.config.history.keepRecentTurns;
  // The baseline offers no context fetchers (decided by effect and flag, never by name).
  const fetchers = fetcherNames(tools, ctx.registry.tools.map((r) => r.plugin));
  const baselineTools = tools.filter((s) => !fetchers.has(s.name));
  const toolMap = offeredTools(ctx, baselineMode ? baselineTools : tools);
  let lastBaselineSystem: string | undefined;
  /** The baseline system prompt for this turn, rendered from the current tree (the last good rendering if that fails). */
  const baselineSystemNow = async (): Promise<string> => {
    if (typeof opts.baselineSystem === 'string') return opts.baselineSystem;
    const previous = lastBaselineSystem;
    try {
      const rendered = await opts.baselineSystem();
      lastBaselineSystem = rendered;
      return rendered;
    } catch (e) {
      if (previous === undefined) throw e;
      ctx.emit({ kind: 'error', source: 'loop', message: `baseline front-load could not be re-rendered: ${errMsg(e)}; reusing the previous turn's` });
      return previous;
    }
  };
  if (baselineMode && fetchers.size > 0) {
    ctx.emit({ kind: 'note', source: 'loop', message: `baseline mode: context fetchers withheld (${[...fetchers].join(', ')}); the repository and the standards are front-loaded every turn` });
  }
  const writeTools = [...toolMap.values()].filter((t) => t.effect === 'write').map((t) => t.name);
  // Repeat pointers (JIT only): the turns the NEXT request shows verbatim are the current one and the keep-1 before it.
  const repeatsOn = !baselineMode && (!ctx.mode.compactHistory || keep >= 1);
  const shownBefore = ctx.mode.compactHistory ? Math.max(0, keep - 1) : Number.POSITIVE_INFINITY;
  const turns: TranscriptTurn[] = [];
  let idle = 0;
  let lastFinish: GateOutcome | undefined;

  const persist = (t: TranscriptTurn, extra: Record<string, unknown>, logs: Record<string, string>): void => {
    store.appendTranscript({
      turn: t.turn,
      ...extra,
      assistant: t.assistant.parts,
      results: t.results?.parts ?? null,
      rawKeys: Object.keys(t.raw),
      logs,
    });
    store.writeJson('state.json', serializeState(ctx.state));
  };
  const withFinish = (r: AgentResult): AgentResult => (lastFinish !== undefined ? { ...r, finish: lastFinish } : r);
  const aborted = (turnsDone: number): AgentResult => {
    ctx.emit({ kind: 'note', source: 'loop', message: `aborted by the operator after ${turnsDone} turns` });
    store.writeJson('state.json', serializeState(ctx.state));
    return withFinish({ status: 'aborted', turns: turnsDone, error: 'aborted by the operator' });
  };

  try {
    for (let turn = 1; turn <= opts.maxTurns; turn += 1) {
      if (isAborted(opts.signal)) return aborted(turn - 1);
      ctx.state.turn = turn;
      // Baseline request: front-load re-rendered from the current tree, raw returns, no fetchers. In a
      // --baseline run it is what is sent; otherwise it is the shadow, built from this run's trajectory
      // without its context-fetch calls (a baseline harness has that content front-loaded).
      const baselineReq: ModelRequest = {
        system: await baselineSystemNow(),
        messages: baselineMode ? baselineView(first, turns) : baselineView(first, turns, { omitTools: fetchers }),
        tools: baselineTools,
        maxOutputTokens: opts.maxOutputTokens,
      };
      let actualReq: ModelRequest;
      let actual: number;
      let baseline: number;
      let estimated: boolean;
      let attribution: TurnTokens['attribution'] = { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0, fetchChars: 0 };
      if (baselineMode) {
        actualReq = baselineReq;
        const c = await countTurn(driver, [{ label: 'actual', req: actualReq }], ctx, ledger);
        actual = c.counts[0] ?? 0;
        baseline = actual;
        estimated = c.estimated;
      } else {
        const fullMsgs = jitView(first, turns, keep, false);
        const msgs = ctx.mode.compactHistory ? jitView(first, turns, keep, true, { writeTools }) : fullMsgs;
        actualReq = { system: opts.system, messages: msgs, tools, maxOutputTokens: opts.maxOutputTokens };
        const c = await countTurn(driver, [{ label: 'actual', req: actualReq }, { label: 'baseline', req: baselineReq }], ctx, ledger);
        actual = c.counts[0] ?? 0;
        baseline = c.counts[1] ?? 0;
        estimated = c.estimated;
        const rawMsgs = fetchers.size > 0 ? baselineView(first, turns) : baselineReq.messages;
        attribution = {
          frontLoadChars: baselineReq.system.length - opts.system.length,
          rawReturnChars: messageChars(rawMsgs) - messageChars(fullMsgs),
          historyChars: messageChars(fullMsgs) - messageChars(msgs),
          fetchChars: messageChars(rawMsgs) - messageChars(baselineReq.messages),
        };
      }

      let response: ModelResponse;
      try {
        response = await completeWithRetry(driver, actualReq, delays, ctx, opts.signal, opts.sleep ?? sleep);
      } catch (e) {
        if (e instanceof AbortedError) return aborted(turn - 1);
        const error = e instanceof RateLimitStop ? `driver.complete stopped: ${e.message}` : `driver.complete failed after ${delays.length + 1} attempts: ${errMsg(e)}`;
        ctx.emit({ kind: 'error', source: 'driver', message: error });
        store.writeJson('state.json', serializeState(ctx.state));
        return withFinish({ status: 'error', turns: turn - 1, error });
      }
      // A driver with no provider (an offline replay) reports no usage: never record its numbers as the provider's.
      const reported = response.usage.reported !== false;
      ledger.record({
        turn,
        actual,
        baseline,
        providerInput: reported ? response.usage.inputTokens : 0,
        providerCached: reported ? (response.usage.cachedInputTokens ?? 0) : 0,
        output: reported ? response.usage.outputTokens : 0,
        attribution,
        ...(reported ? {} : { providerReported: false }),
        ...(estimated ? { estimated: true } : {}),
      });

      const assistant: Message = { role: 'assistant', parts: response.parts };
      const meta = { stop: response.stop, model: response.model, usage: response.usage, tokens: { actual, baseline } };
      const calls = response.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');

      if (response.stop === 'refusal' && calls.length === 0) {
        const t: TranscriptTurn = { turn, assistant, results: null, raw: {} };
        turns.push(t);
        persist(t, meta, {});
        ctx.emit({ kind: 'note', source: 'loop', message: 'model refused' });
        return withFinish({ status: 'refused', turns: turn });
      }
      if (response.stop === 'error' && calls.length === 0) {
        const t: TranscriptTurn = { turn, assistant, results: null, raw: {} };
        turns.push(t);
        persist(t, meta, {});
        return withFinish({ status: 'error', turns: turn, error: 'driver reported stop reason "error"' });
      }

      if (calls.length === 0) {
        idle += 1;
        if (idle >= MAX_IDLE_TURNS) {
          const t: TranscriptTurn = { turn, assistant, results: null, raw: {} };
          turns.push(t);
          persist(t, meta, {});
          ctx.emit({ kind: 'note', source: 'loop', message: `stalled: ${idle} consecutive turns without a tool call` });
          return withFinish({ status: 'stalled', turns: turn });
        }
        const nudge = response.stop === 'max_tokens' ? `Your reply was cut off at the output limit. ${NUDGE}` : NUDGE;
        const t: TranscriptTurn = { turn, assistant, results: { role: 'user', parts: [{ type: 'text', text: nudge }] }, raw: {} };
        turns.push(t);
        persist(t, meta, {});
        continue;
      }
      idle = 0;

      const parts: ToolResultPart[] = [];
      const raw: Record<string, string> = {};
      const logs: Record<string, string> = {};
      const repeats: Record<string, RepeatRef> = {};
      const written: Record<string, string[]> = {};
      const earlier = repeatsOn ? turns.slice(Math.max(0, turns.length - Math.min(turns.length, shownBefore))) : [];
      const visible: VisibleCall[] = earlier.flatMap((t) => visibleCalls(t, turns));
      const firstVisibleTurn = earlier[0]?.turn ?? turn;
      let accepted: GateOutcome | undefined;
      for (const call of calls) {
        if (accepted !== undefined || isAborted(opts.signal)) {
          const skipped = accepted !== undefined ? 'skipped: the run already finished in this turn' : 'skipped: the run was aborted';
          parts.push({ type: 'tool_result', callId: call.id, content: skipped, isError: true });
          raw[call.id] = skipped;
          continue;
        }
        const out = await executeCall(call, toolMap, ctx);
        let part = out.part;
        if (repeatsOn && toolMap.get(call.name)?.effect === 'read' && !part.isError) {
          const ref = findRepeat(call, part.content, visible, firstVisibleTurn);
          if (ref !== null) {
            repeats[call.id] = ref;
            part = { ...part, content: repeatPointer(call.name, ref.turn) };
            ctx.emit({ kind: 'note', source: call.name, message: `identical to the t${ref.turn} result still in context: answered with a pointer` });
          }
          visible.push({ turn, call, result: out.part, content: out.part.content, ...(ref !== null ? { ref } : {}) });
        }
        parts.push(part);
        raw[call.id] = out.raw;
        if (out.logPath !== undefined) logs[call.id] = out.logPath;
        if (out.written !== undefined) written[call.id] = out.written;
        if (out.finish !== undefined) {
          lastFinish = out.finish;
          if (out.finish.ok) accepted = out.finish;
        }
      }
      const hasRepeats = Object.keys(repeats).length > 0;
      const t: TranscriptTurn = {
        turn,
        assistant,
        results: { role: 'user', parts },
        raw,
        ...(hasRepeats ? { repeats } : {}),
        ...(Object.keys(written).length > 0 ? { written } : {}),
      };
      turns.push(t);
      persist(t, hasRepeats ? { ...meta, repeats } : meta, logs);
      if (accepted !== undefined) return { status: 'done', turns: turn, finish: accepted };
      if (isAborted(opts.signal)) return aborted(turn);
    }
    return withFinish({ status: 'max_turns', turns: opts.maxTurns });
  } catch (e) {
    const error = `loop error: ${errMsg(e)}`;
    try {
      ctx.emit({ kind: 'error', source: 'loop', message: error });
    } catch {
      // emitting must never mask the original error
    }
    return withFinish({ status: 'error', turns: ctx.state.turn, error });
  }
}
