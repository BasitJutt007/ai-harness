/**
 * CORE CONTRACTS.
 *
 * Everything the engine knows about drivers, tools, hooks, gates and checks is
 * declared here. Nothing in this file (or anywhere under src/core) may name a
 * model provider: providers live behind the `Driver` interface in plugins/drivers.
 */
import type { z } from 'zod';
import type ts from 'typescript';
import type { TargetLayout } from './target.ts';

// ───────────────────────────── Conversation model ─────────────────────────────
// A provider-neutral transcript. Drivers translate to and from their wire format.

export type JsonSchema = Record<string, unknown>;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  /** Driver-assigned id, echoed back in the matching ToolResultPart. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  callId: string;
  /** What the model sees. Already compacted by the core in JIT mode. */
  content: string;
  isError: boolean;
}

/**
 * Driver-private payload that must be replayed verbatim on later turns
 * (e.g. reasoning blocks). The core stores it and never inspects it; other
 * drivers ignore parts whose `driver` is not their own name.
 */
export interface OpaquePart {
  type: 'opaque';
  driver: string;
  data: unknown;
}

export type Part = TextPart | ToolCallPart | ToolResultPart | OpaquePart;

export interface Message {
  role: 'user' | 'assistant';
  parts: Part[];
}

/** A tool as offered to a model: name, prose and a plain JSON Schema for its input. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
}

export type StopReason = 'end_turn' | 'tool_calls' | 'max_tokens' | 'refusal' | 'error';

export interface Usage {
  /**
   * Total input tokens the provider processed for this request, INCLUDING any
   * cached prefix (i.e. the full context-window footprint of the request).
   */
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens served from a provider cache, when reported. */
  cachedInputTokens?: number;
  /**
   * False when no provider reported usage for this response (an offline driver): the numbers
   * are then 0, and the token report says "no provider usage" instead of showing an estimate
   * as provider data. Default: true.
   */
  reported?: boolean;
}

export interface ModelResponse {
  parts: Part[];
  stop: StopReason;
  usage: Usage;
  /** The concrete model that served the request (for the run log only). */
  model: string;
}

// ───────────────────────────────── Drivers ─────────────────────────────────

export interface Driver {
  /** Registry name, e.g. the value passed to --driver. */
  readonly name: string;
  /** Concrete model id in use (from CLI flag or environment, never from a task file). */
  readonly model: string;
  /** Human-readable label of the method countTokens() uses. */
  readonly tokenCounter: string;
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  /**
   * Count the input tokens `req` would occupy. Used for BOTH the actual request
   * and the shadow baseline request each turn, so the reduction ratio compares
   * like with like.
   */
  countTokens(req: ModelRequest): Promise<number>;
  /**
   * Optional: the wait in ms that an error thrown by complete() asks for before a retry (a rate
   * limit that names its wait in the provider's own format), or null when it names none. The
   * provider's formats live here, never in the core. Without it, or on null, the loop honours a
   * standard Retry-After header of an HTTP 429/503 error.
   */
  retryAfterMs?(error: unknown): number | null;
  /**
   * Optional: what kind of failure an error thrown by complete() is, when the provider's own
   * wording says so (DriverErrorKind), else null. The provider's error formats live here, never in
   * the core: on 'context_overflow' the loop shrinks the request once instead of resending it.
   */
  errorKind?(error: unknown): DriverErrorKind | null;
}

/**
 * Failure kinds the loop treats specially. `context_overflow`: the request did not fit the
 * model's context window (or the provider's request-size limit); resending it unchanged cannot work.
 */
export type DriverErrorKind = 'context_overflow';

export interface DriverCreateOptions {
  /** --model flag, if given. Drivers fall back to their own env var / default. */
  model?: string;
  /** --driver-opt key=value pairs. */
  options: Record<string, string>;
  env: NodeJS.ProcessEnv;
  /** Absolute path of the harness repository (for drivers that read fixtures). */
  harnessRoot: string;
}

export interface DriverPlugin {
  kind: 'driver';
  name: string;
  description: string;
  create(opts: DriverCreateOptions): Driver;
}

// ───────────────────────────────── Tasks ─────────────────────────────────

export type TaskKind = 'greenfield' | 'brownfield';

/** Canonical field types; `unknown` = the task declared a type the harness has no name for (see rawType). */
export type FieldType =
  | 'string'
  | 'email'
  | 'uuid'
  | 'integer'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'date'
  | 'time'
  | 'enum'
  | 'array'
  | 'object'
  | 'unknown';

export interface FieldSpec {
  name: string;
  type: FieldType;
  /** The type exactly as the task file declared it, when that differs from `type` (the brief prints it as declared). */
  rawType?: string | undefined;
  required: boolean;
  unique: boolean;
  readOnly: boolean;
  values?: string[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
  default?: string | number | boolean | undefined;
  description?: string | undefined;
}

export type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface ResourceSpec {
  /** Singular noun, e.g. "user". */
  name: string;
  /** Plural noun used in paths, e.g. "users". Derived when omitted. */
  plural: string;
  fields: FieldSpec[];
  operations: Operation[];
  /** Resource-level details the task gave beyond fields and operations (relations, custom routes, ...), verbatim. */
  notes?: string[] | undefined;
}

interface TaskCommon {
  id: string;
  title: string;
  /** Free-text behaviours / acceptance criteria. */
  behaviours: string[];
  /**
   * `maxTurns` absent: the task file named none, so the harness scales a default with the task's
   * size and may extend it while the gates make progress (loop.ts turnLimitFor). Present: a hard cap.
   */
  limits: { maxTurns?: number | undefined; maxOutputTokens: number };
  /** Free-text description of the task, shown to the model verbatim. */
  brief?: string | undefined;
  /** Top-level task-file keys the harness has no slot for, carried to the model verbatim. */
  carried?: Record<string, unknown> | undefined;
}

export interface GreenfieldTask extends TaskCommon {
  kind: 'greenfield';
  /** Output directory for the new API, relative to the repository root. */
  output: string;
  /** Scaffold template directory name under templates/. */
  template: string;
  basePath: string;
  /** May be empty when the task describes the API in its brief. */
  resources: ResourceSpec[];
}

export interface BrownfieldTask extends TaskCommon {
  kind: 'brownfield';
  /** API root to change, relative to the repository root. */
  target: string;
  /** What to change, in prose. */
  change: string;
  /** Globs (relative to the API root) the agent may write. */
  scope: { allow: string[]; deny: string[] };
  /** When false (default), any breaking contract change blocks finish and ship. */
  allowBreaking: boolean;
  /** Resources the change adds or extends, when the task lists them. */
  resources?: ResourceSpec[] | undefined;
}

export type Task = GreenfieldTask | BrownfieldTask;

/** How a task file was decoded. */
export type TaskFormat = 'json' | 'yaml' | 'markdown' | 'text';

export interface LoadedTask {
  task: Task;
  /** Absolute path of the task file. */
  file: string;
  /** sha256 of the task file bytes. */
  sha256: string;
  /** sha256 of the canonical (normalized) task, key-sorted JSON. */
  normalizedSha256: string;
  format: TaskFormat;
  /** True when loaded with --strict-task (canonical schema only, no lenient front end). */
  strict: boolean;
  /** Everything the front end renamed, inferred, dropped or carried, one line each. */
  warnings: string[];
  /**
   * True when the task names its own write scope (scope.allow). Otherwise a brownfield run writes within
   * the target API's own source and test roots (the TargetProfile), not the schema default.
   */
  declaresScope: boolean;
}

// ───────────────────────────── Run state & context ─────────────────────────────

/** Context policy. Baseline mode = all three false. */
export interface ContextMode {
  /** Fetch context on demand (true) vs front-load the repository into the system prompt (false). */
  jit: boolean;
  /** Tools return compact summaries (true) vs raw output (false). */
  compactReturns: boolean;
  /** Older tool traffic is collapsed to stubs (true) vs kept verbatim (false). */
  compactHistory: boolean;
}

export interface RunInfo {
  id: string;
  driver: string;
  model: string;
  startedAt: string;
  /** Absolute path of the harness repository (where runs/, tokens/, plugins/ live). */
  harnessRoot: string;
  /** Absolute path of runs/<id>. */
  runDir: string;
  /** Feature branch the run works on. */
  branch: string;
  /** Branch the worktree was created from (PR base). */
  baseBranch: string;
  /** Commit the worktree was created from (the "before" side of every diff). */
  baseSha: string;
}

/** Filesystem view of the governed API. All paths are API-root-relative POSIX paths. */
export interface Workspace {
  /** Absolute path of the git worktree root. */
  readonly repoRoot: string;
  /** Absolute path of the API root inside the worktree. */
  readonly root: string;
  /** API root relative to repoRoot (POSIX). */
  readonly rootRel: string;
  /** Resolve an API-relative path to absolute. Throws if it escapes the API root. */
  resolve(rel: string): string;
  /** Normalise any path (absolute or relative) to an API-relative POSIX path. Throws on escape. */
  rel(p: string): string;
  read(rel: string): Promise<string | null>;
  write(rel: string, content: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** Glob relative to the API root (node_modules and .git always excluded). */
  list(patterns: string[]): Promise<string[]>;
}

/** A test run observed by the harness's own runner. */
export interface TestObservation {
  /** API-relative test file path. */
  file: string;
  /** sha256 of the test file content at the moment it was run. */
  hash: string;
  status: 'pass' | 'fail' | 'error';
  /** Number of test cases collected in the file. */
  collected: number;
  failed: number;
  /**
   * Whether this observation counts as "observed red" for the observed-red gate:
   * at least one collected test failed, or the suite failed only because a
   * module under src/ it imports does not exist yet.
   */
  validRed: boolean;
  reason: string;
  turn: number;
  at: string;
  /**
   * Per-test-case evidence, statically extracted from the file content that was run and
   * joined with the runner's per-case results. Used to tie a red to the code it exercises
   * and to require red -> green on UNCHANGED test code.
   */
  cases?: TestCaseObservation[];
}

export interface TestCaseObservation {
  /** "describe > ... > title" (same key format as the test-preservation hook). */
  name: string;
  /** Runner result for this case; 'error' = the file failed to load, so the case never ran. */
  status: 'pass' | 'fail' | 'skip' | 'error';
  /** sha256 of the case body with whitespace/comments normalised; undefined if not statically found. */
  bodyHash?: string;
  /** The case (or its file-level hooks) uses a binding imported from a module whose closure reaches src/. */
  exercisesSource: boolean;
  /** Every assertion compares literals only (e.g. expect(true).toBe(false)) or there is none. */
  constantOnly: boolean;
}

/** One collected test case as the runner reported it. */
export interface TestCaseResult {
  /** API-relative test file. */
  file: string;
  /** "describe > ... > title", as the runner reported it. */
  name: string;
  /** 'skip' also covers pending and disabled cases; 'todo' is `it.todo`. */
  status: 'pass' | 'fail' | 'skip' | 'todo';
}

/**
 * What the suite looked like at run start (see test-baseline.ts): the cases that did not run or failed,
 * so a gate can tell what a repository already had from what the run introduced.
 */
export interface TestBaseline {
  /** When it was measured (ISO). */
  at: string;
  /** Why the run-start results are unknown (no per-case report); the lists are then empty. */
  error?: string;
  totals: { files: number; tests: number; passed: number; failed: number };
  /** Cases skipped or todo at run start. */
  skipped: TestCaseResult[];
  /** Cases failing at run start. */
  failed: TestCaseResult[];
  /** Test files that failed to load at run start. */
  loadErrors: string[];
  /** Harness-root-relative path of the runner's raw output. */
  logPath?: string;
}

export interface RunEvent {
  turn: number;
  at: string;
  kind: 'hook' | 'gate' | 'tool' | 'note' | 'error';
  source: string;
  decision?: 'pass' | 'block' | 'record';
  message: string;
  data?: unknown;
}

/** Mutable state shared by tools, hooks and gates during one run. */
export interface RunState {
  turn: number;
  /** Every observation, in order. */
  tests: TestObservation[];
  /** API-relative paths the agent wrote (via any write-effect tool). */
  written: Set<string>;
  /** sha256 of files at run start (API-relative path -> hash); absent = did not exist. */
  initialHashes: Map<string, string>;
  /**
   * The target's own test results at run start, measured before the agent's first turn (brownfield
   * runs; see test-baseline.ts). Never a test observation. Absent = not measured.
   */
  testBaseline?: TestBaseline;
  /** The agent's latest submitted plan, if any. */
  plan: string[];
  events: RunEvent[];
  /** Free-form slots plugins may use; key by plugin name. */
  scratch: Map<string, unknown>;
  finishAttempts: number;
}

export interface LogStore {
  /** Persist raw output under runs/<id>/logs and return the harness-root-relative path. */
  write(name: string, content: string): Promise<string>;
}

export interface ExecResult {
  /** Set when opts.sandbox was given: the mechanism that confined the child. */
  sandbox?: SandboxMechanism;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when opts.channel was given: everything the child wrote to its fd 3. */
  channel?: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * OS-level confinement for a subprocess that executes untrusted (agent-written) code:
 * the test runner, runtime probes, contract schema extraction. Applied by exec.ts via
 * src/core/sandbox.ts. Writes outside `writable` and network outside `network` are denied.
 */
export interface SandboxPolicy {
  /** Absolute directories the child may write (everything else is read-only). */
  writable: string[];
  /** 'none' = no network at all; 'localhost' = loopback only (supertest, runtime probes). */
  network: 'none' | 'localhost';
}

/** Which confinement actually wrapped an execution (recorded in run evidence). */
export type SandboxMechanism = 'sandbox-exec' | 'bwrap' | 'node-permission' | 'none';

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Run the command confined (see SandboxPolicy). Omit only for trusted commands (git, tsc). */
  sandbox?: SandboxPolicy;
  /**
   * Open a private pipe on the child's fd 3 and return what it writes there (ExecResult.channel).
   * Node marks inherited descriptors close-on-exec, so the child's own children (test workers,
   * anything they spawn) never hold it: a result written there cannot be forged or rewritten by them.
   */
  channel?: boolean;
}

/** Deterministic subprocess execution (provider keys are always stripped from the env). */
export type Exec = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export interface HarnessConfig {
  pluginDirs: string[];
  disabled: string[];
  protectedBranches: string[];
  worktreeDir: string;
  runsDir: string;
  tokensDir: string;
  templatesDir: string;
  history: { keepRecentTurns: number };
  limits: { maxReadLines: number; maxListEntries: number; maxSearchHits: number };
  /**
   * Execution isolation for agent-written code. 'auto' (default) = best available
   * mechanism, and REFUSE to run untrusted code if none works; 'off' = run unconfined
   * (recorded as UNPROVEN isolation in run evidence).
   */
  sandbox: 'auto' | 'off';
}

export interface TestRunReport {
  /** True when every collected test passed and at least one test ran. */
  ok: boolean;
  totals: { files: number; tests: number; passed: number; failed: number };
  /** One observation per test file that was part of the run. */
  observations: TestObservation[];
  /** Every collected case with the runner's result; absent when the runner produced no per-case report. */
  results?: TestCaseResult[];
  /** Compact pass/fail lines (failures first, capped). */
  summary: string;
  /** Harness-root-relative path of the raw runner output. */
  logPath: string;
  /**
   * The runner's own console output (default reporter, no colour), capped at 64 KB.
   * This is what a developer would see in a terminal: the honest raw (baseline) return.
   */
  console?: string;
  /**
   * One line per failing case that passes when re-run alone (it depends on test order), when the run
   * was asked to isolate failures. Diagnostic only: those re-runs are never observations.
   */
  diagnosis?: string[];
}

/** Static import graph between test files and source files (API-relative paths). */
export interface TestMap {
  /** test file -> non-test files reachable through its imports (transitively; .ts anywhere under the API root). */
  coverage: Record<string, string[]>;
  /** Test files whose import closure contains `source` (or, for a source that does not exist yet, that match it by name). */
  testsFor(source: string): string[];
}

export interface RuleSummary {
  rule: string;
  category: string;
  unit: string;
  /**
   * pass / fail / unproven (skipped, or a 'standards' rule with 0 units).
   * n/a: a non-'standards' rule with nothing to check (no findings, 0 units). It is
   * never counted toward the verdict and never reported as proven.
   */
  status: 'pass' | 'fail' | 'unproven' | 'n/a';
  passed: number;
  total: number;
  files: number;
}

export interface CheckReport {
  /** Absolute API root that was checked. */
  root: string;
  findings: CheckFinding[];
  rules: RuleSummary[];
  verdict: { status: 'pass' | 'fail' | 'unproven'; percent: number };
  /** Full report: one line per rule per file, then the summary block. */
  text: string;
  /** Compact report: failing/skipped lines only, then the summary block. */
  compact: string;
}

/** Deterministic services the core provides to plugins. */
export interface CoreServices {
  /**
   * Run tests with the harness's own runner and record observations in RunState. With
   * `isolateFailures`, up to two failing cases are then re-run alone and the ones that pass alone are
   * named in TestRunReport.diagnosis; those re-runs are never recorded.
   */
  runTests(files?: string[], opts?: { isolateFailures?: boolean }): Promise<TestRunReport>;
  /**
   * Run registered checks against the workspace API root, or against `root` (an absolute directory
   * holding another copy of the API, e.g. a base-commit snapshot for a brownfield baseline).
   */
  runChecks(opts?: { categories?: string[]; rules?: string[]; root?: string }): Promise<CheckReport>;
  /** Current import graph (recomputed from disk on each call). */
  testMap(): Promise<TestMap>;
  /**
   * Run `files` with the harness's runner in a scratch copy of the API root in which every path in
   * `revert` has its run-start content again (or is absent, if it did not exist at run start).
   * Observations are NOT recorded in RunState. Throws when a run-start content is unavailable.
   */
  runTestsReverted(files: string[], revert: string[]): Promise<TestRunReport>;
}

/** Everything a plugin can reach during a run. */
export interface RunContext {
  run: RunInfo;
  task: Task;
  workspace: Workspace;
  state: RunState;
  logs: LogStore;
  mode: ContextMode;
  config: HarnessConfig;
  exec: Exec;
  services: CoreServices;
  /** Lookup of other registered plugins. */
  registry: RegistryView;
  /** Append a structured event to runs/<id>/events.jsonl. */
  emit(event: Omit<RunEvent, 'turn' | 'at'>): void;
}

// ───────────────────────────────── Tools ─────────────────────────────────

export type ToolEffect = 'read' | 'write' | 'exec' | 'control';

export interface ToolResult {
  ok: boolean;
  /** Compact return: a summary, diff stat or pass/fail lines. Shown in JIT mode. */
  summary: string;
  /**
   * Full raw output: shown to the model only in baseline mode (it is what the baseline
   * replays; JIT mode shows `summary`). Written to runs/<id>/logs only for exec and write
   * tools whose raw output exceeds the log threshold (2 KB); never logged for read/control tools.
   */
  raw?: string;
  /** Structured data for hooks/gates/state. Never shown to the model. */
  data?: unknown;
  /** Set by the `finish` control tool to request the finish gates. */
  finish?: { summary: string };
}

export interface ToolPlugin<I = unknown> {
  kind: 'tool';
  /** Tool name offered to the model: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ (e.g. "read_file", "openapi-diff"). */
  name: string;
  /** One or two sentences. This is all the model learns about the tool up front. Default: the name. */
  description?: string;
  /** Zod schema for the input. The core converts it to a neutral JSON Schema. */
  input: z.ZodType<I>;
  effect: ToolEffect;
  /**
   * Whether the tool fetches context (repository files, listings, standards text). Default:
   * true for `read` tools, false otherwise. `--baseline` runs withhold every context fetcher
   * (their content is front-loaded instead).
   */
  fetcher?: boolean;
  /** Task kinds this tool is offered in. Default: all. */
  availableIn?: TaskKind[];
  /** API-relative paths the call will touch (used by hooks). */
  paths?(input: I): string[];
  /**
   * Write tools: the exact content `path` (one of paths()) will have after the call, given its
   * current content `before` (null = absent); null = no file there afterwards (a deletion). A call
   * the tool will refuse leaves the file as it is (return `before`). The loop computes it once per
   * path before the pre_tool hooks (ToolCallInfo.preview); hooks that judge content refuse a write
   * tool without it (fail closed).
   */
  preview?(input: I, before: string | null, path: string): string | null;
  run(input: I, ctx: RunContext): Promise<ToolResult>;
}

// ───────────────────────────────── Hooks ─────────────────────────────────

export interface ToolCallInfo {
  id: string;
  tool: string;
  effect: ToolEffect;
  input: unknown;
  /** API-relative paths from the tool's paths() (empty when not declared). */
  paths: string[];
  /**
   * Post-call content of each declared path (keyed as in `paths`) from the tool's preview(),
   * computed once by the loop before the pre_tool hooks; null = no file there afterwards.
   * Absent when the tool declares no preview(); a path is missing when its post-call content
   * could not be computed. Content hooks judge this, never the tool's input field names.
   */
  preview?: ReadonlyMap<string, string | null>;
}

export interface PreToolEvent {
  event: 'pre_tool';
  call: ToolCallInfo;
}

export interface PostToolEvent {
  event: 'post_tool';
  call: ToolCallInfo;
  result: ToolResult;
}

export type HookEvent = PreToolEvent | PostToolEvent;

/**
 * pass   → continue.
 * block  → pre_tool: the tool does not run, the model receives `reason` as an error result.
 *          post_tool: the result is marked as an error and `reason` is appended.
 * record → continue, log `note`, and append it to the model-visible result as feedback.
 */
export type HookVerdict =
  | { decision: 'pass' }
  | { decision: 'block'; reason: string }
  | { decision: 'record'; note: string };

export interface HookPlugin {
  kind: 'hook';
  name: string;
  description?: string;
  events: Array<HookEvent['event']>;
  /** Restrict to these tool effects (default: all). */
  effects?: ToolEffect[];
  /** Restrict to these tool names (default: all). */
  tools?: string[];
  run(event: HookEvent, ctx: RunContext): Promise<HookVerdict>;
}

// ───────────────────────────────── Gates ─────────────────────────────────

export type GatePhase = 'finish' | 'ship';

/**
 * pass     → proven by the harness.
 * fail     → proven broken.
 * unproven → could not be established (a skipped check is never green).
 * n/a      → does not apply to this task kind (reported, never counted as green).
 */
export type GateStatus = 'pass' | 'fail' | 'unproven' | 'n/a';

export interface GateResult {
  status: GateStatus;
  /** One line. */
  summary: string;
  /** Compact detail lines for the model / report. */
  details?: string[];
  /** Harness-root-relative path of the raw log, if any. */
  logPath?: string;
  /** What the gate saw but neither proved nor blocked on (e.g. pre-existing violations): listed under "human must verify". */
  humanMustVerify?: string[];
  /**
   * How many units (tests, violations, changes, ...) a fail/unproven result found failing. Lets the
   * loop measure progress between finish attempts; absent, the number of detail lines stands in.
   */
  failing?: number;
}

export interface GatePlugin {
  kind: 'gate';
  name: string;
  description?: string;
  phases: GatePhase[];
  appliesTo?: TaskKind[];
  run(ctx: RunContext, phase: GatePhase): Promise<GateResult>;
}

// ───────────────────────────────── Checks ─────────────────────────────────

export interface Violation {
  /** "path/to/file.ts:line:col" (API-relative). */
  location: string;
  message: string;
}

/** One rule evaluated against one file. */
export interface CheckFinding {
  rule: string;
  /** API-relative file path, or "(project)" for whole-project results. */
  file: string;
  status: 'pass' | 'fail' | 'skip';
  /** Units checked in this file (handlers, routes, error paths...). */
  units: { passed: number; total: number };
  violations: Violation[];
  /** Why the rule was skipped (status === 'skip'). Skipped = UNPROVEN. */
  skipReason?: string;
}

export interface CheckContext {
  /** Absolute API root. */
  root: string;
  /** API-relative TypeScript files under the API's source roots (non-test, non-declaration). */
  sourceFiles: string[];
  /** API-relative test files and test support (helpers, fixtures in the dedicated test dirs). */
  testFiles: string[];
  /**
   * Where the API keeps source and tests (source roots, test dirs, runner globs, import resolution): the
   * run's TargetProfile, else computed from the API's own config. Absent only in hand-built contexts.
   */
  layout?: TargetLayout;
  read(rel: string): Promise<string>;
  /** Parsed source file (cached). */
  sourceFile(rel: string): ts.SourceFile;
  /** Type-checked program over all source + test files (created lazily, cached). */
  program(): ts.Program;
  exec: Exec;
  /** Absolute harness root (to locate node_modules/.bin binaries). */
  harnessRoot: string;
  logs: LogStore;
  /** Kind of the task being run (absent for `harness check`). */
  taskKind?: TaskKind;
  /**
   * The run's base commit, for checks that compare against the "before" side
   * (e.g. a contract diff). Populated during a run; absent for `harness check`.
   */
  base?: { repoRoot: string; rootRel: string; sha: string };
  /** Merged dependencies + devDependencies of <root>/package.json ({} if absent or unreadable). */
  dependencies(): Record<string, string>;
}

export interface CheckPlugin {
  kind: 'check';
  /** Rule id printed in reports, e.g. "zod-boundary". */
  id: string;
  /** Grouping: "standards" (the graded four), "orm", "lint", or any custom label. */
  category: string;
  /** One line; also the fallback for `doc`. Default: the id. */
  description?: string;
  /** Plural unit noun for the summary line ("handlers", "error paths", "routes"). Default: "units". */
  unit?: string;
  /** The standard's full text, served JIT by the fetch_standard tool. Default: `description`. */
  doc?: string;
  run(ctx: CheckContext): Promise<CheckFinding[]>;
}

// ───────────────────────────────── Registry ─────────────────────────────────

/**
 * A tool of any input type. Tool methods are declared with method syntax, so a
 * `ToolPlugin<{ path: string }>` is assignable to `ToolPlugin<unknown>`; the core
 * validates input with `tool.input` before calling `run`.
 */
export type AnyTool = ToolPlugin<unknown>;

export type Plugin = DriverPlugin | AnyTool | HookPlugin | GatePlugin | CheckPlugin;

export interface PluginRecord<P extends Plugin = Plugin> {
  plugin: P;
  /** Harness-root-relative source file. */
  file: string;
  /** sha256 of the source file. */
  sha256: string;
}

export interface RegistryView {
  drivers: PluginRecord<DriverPlugin>[];
  tools: PluginRecord<AnyTool>[];
  hooks: PluginRecord<HookPlugin>[];
  gates: PluginRecord<GatePlugin>[];
  checks: PluginRecord<CheckPlugin>[];
  /** Plugin files that failed to load, with the reason. */
  errors: Array<{ file: string; error: string }>;
}
