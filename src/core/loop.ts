/**
 * The agent loop. Provider-neutral: it only speaks Message / Part / ToolSpec.
 *
 * Per turn: build the actual request (JIT view) and the shadow baseline request →
 * count both → driver.complete (retried on thrown errors) → ledger.record → run each
 * tool call in order (validate → pre hooks → run → post hooks) → persist.
 * `finish` runs the finish gates; only an all-green gate run ends the loop as `done`.
 */
import { serializeState } from './run-store.ts';
import { baselineView, jitView, messageChars, type TranscriptTurn } from './context.ts';
import { runGates, type GateOutcome } from './gates.ts';
import { runPostHooks, runPreHooks } from './hooks.ts';
import type { TokenLedger } from './tokens.ts';
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
  system: string;
  baselineSystem: string;
  tools: ToolSpec[];
  maxTurns: number;
  maxOutputTokens: number;
  /** Backoff before each retry of driver.complete (default 1s, 4s, 10s). */
  retryDelaysMs?: number[];
  /** Operator abort: checked before every turn and every tool call, and passed to driver.complete. */
  signal?: AbortSignal;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class AbortedError extends Error {}

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
): Promise<ModelResponse> {
  let attempt = 0;
  for (;;) {
    try {
      return await driver.complete(req, signal);
    } catch (e) {
      if (isAborted(signal)) throw new AbortedError('aborted during driver.complete');
      const delay = delays[attempt];
      if (delay === undefined) throw e;
      attempt += 1;
      ctx.emit({ kind: 'error', source: 'driver', message: `complete failed (attempt ${attempt}): ${errMsg(e)}; retrying in ${delay} ms` });
      await sleep(delay);
      if (isAborted(signal)) throw new AbortedError('aborted while waiting to retry');
    }
  }
}

async function countOrEstimate(driver: Driver, req: ModelRequest, ctx: RunContext, label: string): Promise<number> {
  try {
    return await driver.countTokens(req);
  } catch (e) {
    const est = Math.ceil((req.system.length + messageChars(req.messages)) / 4);
    ctx.emit({ kind: 'error', source: 'driver', message: `countTokens(${label}) failed: ${errMsg(e)}; estimated ${est} from chars/4` });
    return est;
  }
}

interface CallOutcome {
  part: ToolResultPart;
  /** Baseline-visible content (raw output + notes). */
  raw: string;
  logPath?: string;
  /** Set when the call was an accepted request to finish (gates ran). */
  finish?: GateOutcome;
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
  if (tool.effect === 'write' && result.ok) for (const p of writtenPaths(result, paths, ctx)) ctx.state.written.add(p);

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
  };
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

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { driver, ctx, store, ledger, first, tools } = opts;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const baselineMode = !ctx.mode.jit && !ctx.mode.compactReturns && !ctx.mode.compactHistory;
  const keep = ctx.config.history.keepRecentTurns;
  const toolMap = offeredTools(ctx, tools);
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
      const baselineMsgs = baselineView(first, turns);
      const baselineReq: ModelRequest = {
        system: opts.baselineSystem,
        messages: baselineMsgs,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
      };
      let actualReq: ModelRequest;
      let actual: number;
      let baseline: number;
      let attribution = { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 };
      if (baselineMode) {
        actualReq = baselineReq;
        actual = await countOrEstimate(driver, actualReq, ctx, 'actual');
        baseline = actual;
      } else {
        const fullMsgs = jitView(first, turns, keep, false);
        const msgs = ctx.mode.compactHistory ? jitView(first, turns, keep, true) : fullMsgs;
        actualReq = { system: opts.system, messages: msgs, tools, maxOutputTokens: opts.maxOutputTokens };
        actual = await countOrEstimate(driver, actualReq, ctx, 'actual');
        baseline = await countOrEstimate(driver, baselineReq, ctx, 'baseline');
        attribution = {
          frontLoadChars: opts.baselineSystem.length - opts.system.length,
          rawReturnChars: messageChars(baselineMsgs) - messageChars(fullMsgs),
          historyChars: messageChars(fullMsgs) - messageChars(msgs),
        };
      }

      let response: ModelResponse;
      try {
        response = await completeWithRetry(driver, actualReq, delays, ctx, opts.signal);
      } catch (e) {
        if (e instanceof AbortedError) return aborted(turn - 1);
        const error = `driver.complete failed after ${delays.length + 1} attempts: ${errMsg(e)}`;
        ctx.emit({ kind: 'error', source: 'driver', message: error });
        store.writeJson('state.json', serializeState(ctx.state));
        return withFinish({ status: 'error', turns: turn - 1, error });
      }
      ledger.record({
        turn,
        actual,
        baseline,
        providerInput: response.usage.inputTokens,
        providerCached: response.usage.cachedInputTokens ?? 0,
        output: response.usage.outputTokens,
        attribution,
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
      let accepted: GateOutcome | undefined;
      for (const call of calls) {
        if (accepted !== undefined || isAborted(opts.signal)) {
          const skipped = accepted !== undefined ? 'skipped: the run already finished in this turn' : 'skipped: the run was aborted';
          parts.push({ type: 'tool_result', callId: call.id, content: skipped, isError: true });
          raw[call.id] = skipped;
          continue;
        }
        const out = await executeCall(call, toolMap, ctx);
        parts.push(out.part);
        raw[call.id] = out.raw;
        if (out.logPath !== undefined) logs[call.id] = out.logPath;
        if (out.finish !== undefined) {
          lastFinish = out.finish;
          if (out.finish.ok) accepted = out.finish;
        }
      }
      const t: TranscriptTurn = { turn, assistant, results: { role: 'user', parts }, raw };
      turns.push(t);
      persist(t, meta, logs);
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
