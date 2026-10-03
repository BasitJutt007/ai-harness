/**
 * One governed run, end to end:
 * config → registry → task → driver → worktree (+ greenfield scaffold) → context →
 * agent loop → fresh final gates → evidence (run.json, gates.json, standards.txt,
 * state.json, tokens/<runId>.json) → optional ship (the harness ships, never the agent).
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { evidenceDirs, HARNESS_ROOT, loadConfig } from './config.ts';
import { exec } from './exec.ts';
import { formatGates, runGates, type GateOutcome, type NamedGateResult } from './gates.ts';
import { runAgent, type AgentResult, type AgentStatus } from './loop.ts';
import { compactTree, frontLoad, scaffoldApiOf, systemPrompt, taskBrief, testMapSummary } from './prompt.ts';
import { loadRegistry, pluginFingerprint, toolSpecs } from './registry.ts';
import { deserializeState, newRunId, newRunState, RunStore, serializeState } from './run-store.ts';
import { isolationHonesty, isolationInfo, isolationUnavailable, setSandboxMode } from './sandbox.ts';
import { saveInitial } from './initial.ts';
import { createServices } from './services.ts';
import { loadTask, parseTask } from './task.ts';
import { TEMPLATE_MANIFEST, templateManifest, type TemplateManifest } from './template.ts';
import { TokenLedger, type TokenReport } from './tokens.ts';
import { createWorkspace, createWorktree, gitToplevel, sha256 } from './workspace.ts';
import type {
  CheckReport,
  ContextMode,
  Driver,
  DriverPlugin,
  Exec,
  HarnessConfig,
  LoadedTask,
  RegistryView,
  RunContext,
  RunEvent,
  RunState,
  Task,
  ToolSpec,
  Workspace,
} from './types.ts';

export type ShipOutcome = Awaited<ReturnType<typeof import('./ship.ts').ship>>;

export interface RunSummary {
  runId: string;
  /** How the agent loop ended. */
  status: AgentStatus;
  /** True iff the loop ended `done` AND the fresh final gate run is green. */
  ok: boolean;
  driver: string;
  model: string;
  turns: number;
  runDir: string;
  worktree: string;
  branch: string;
  /** The repository the worktree was created from (its own checkout is never modified). */
  targetRepo: string;
  gates: NamedGateResult[];
  gatesOk: boolean;
  standards: CheckReport['verdict'] | null;
  tokens: TokenReport['totals'];
  tokensPath: string;
  honesty: Honesty;
  ship?: ShipOutcome;
  error?: string;
  /** Compact human summary (also printed). */
  text: string;
}

export interface Honesty {
  proven: string[];
  failed: string[];
  unproven: string[];
  notApplicable: string[];
  humanMustVerify: string[];
}

const JIT_MODE: ContextMode = { jit: true, compactReturns: true, compactHistory: true };
const BASELINE_MODE: ContextMode = { jit: false, compactReturns: false, compactHistory: false };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function harnessRel(abs: string): string {
  return toPosix(relative(HARNESS_ROOT, abs));
}

// ───────────────────────────── context construction ─────────────────────────────

export function buildContext(opts: {
  run: RunContext['run'];
  task: Task;
  ws: Workspace;
  state: RunState;
  store: RunStore;
  mode: ContextMode;
  config: HarnessConfig;
  registry: RegistryView;
  /** Subprocess runner (default: the core exec). */
  exec?: Exec;
}): RunContext {
  const { state, store } = opts;
  const run = opts.exec ?? exec;
  const services = createServices({
    ws: opts.ws,
    registry: opts.registry,
    state,
    logs: store.logs,
    exec: run,
    harnessRoot: opts.run.harnessRoot,
    taskKind: opts.task.kind,
    baseSha: opts.run.baseSha,
    runDir: opts.run.runDir,
  });
  return {
    run: opts.run,
    task: opts.task,
    workspace: opts.ws,
    state,
    logs: store.logs,
    mode: opts.mode,
    config: opts.config,
    exec: run,
    services,
    registry: opts.registry,
    emit(e) {
      const full: RunEvent = { ...e, turn: state.turn, at: new Date().toISOString() };
      state.events.push(full);
      store.appendEvent(full);
    },
  };
}

async function loadRegistryOrThrow(config: HarnessConfig): Promise<RegistryView> {
  const registry = await loadRegistry(config, HARNESS_ROOT);
  if (registry.errors.length > 0) {
    const lines = registry.errors.map((e) => `  ${e.file}: ${e.error}`).join('\n');
    throw new Error(`plugin load errors (fix or disable them in harness.config.json):\n${lines}`);
  }
  return registry;
}

/** realpath of p, or of its nearest existing ancestor joined with the missing tail. */
function realpathLoose(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

function nearestExisting(p: string): string {
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

async function toplevelOf(dir: string, what: string): Promise<string> {
  try {
    return await gitToplevel(dir);
  } catch {
    throw new Error(`${what} is not inside a git repository (git init and commit it first): ${dir}`);
  }
}

/**
 * Repository + API-root location of the task. The task's relative output/target is resolved
 * against `base` (default: the harness root); the target repository is the git toplevel of
 * the nearest existing ancestor, so a greenfield run can target ANY git repository.
 */
export async function locateApi(task: Task, base: string = HARNESS_ROOT): Promise<{ repoDir: string; rootRel: string }> {
  if (task.kind === 'greenfield') {
    const out = resolve(base, task.output);
    const repoDir = await toplevelOf(nearestExisting(out), `output "${task.output}"`);
    const rootRel = toPosix(relative(repoDir, realpathLoose(out)));
    if (rootRel === '' || rootRel.startsWith('..') || isAbsolute(rootRel)) {
      throw new Error(`output "${task.output}" must be a sub-directory inside the repository ${repoDir}`);
    }
    return { repoDir, rootRel };
  }
  const target = resolve(base, task.target);
  if (!existsSync(target)) throw new Error(`brownfield target does not exist: ${task.target} (resolved to ${target})`);
  const real = realpathSync(target);
  const repoDir = await toplevelOf(real, `target "${task.target}"`);
  return { repoDir, rootRel: toPosix(relative(repoDir, real)) || '.' };
}

async function refuseExistingOutput(repoDir: string, rootRel: string): Promise<void> {
  const r = await exec('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', rootRel], { cwd: repoDir });
  if (r.code === 0 && r.stdout.trim().length > 0) {
    throw new Error(`refusing to scaffold: output "${rootRel}" already exists and is non-empty in the base branch`);
  }
}

/** Never copied into a scaffold: dependencies, caches, build output, VCS data, the harness's template manifest. */
const SCAFFOLD_SKIP = new Set(['node_modules', '.vite', 'dist', '.git', 'coverage', TEMPLATE_MANIFEST]);

export async function scaffold(templatesDir: string, template: string, dest: string, apiName: string): Promise<void> {
  const src = join(templatesDir, template);
  if (!existsSync(src)) throw new Error(`template not found: ${harnessRel(src)}`);
  if (existsSync(dest) && (await readdir(dest)).length > 0) {
    throw new Error(`refusing to scaffold into non-empty directory ${dest}`);
  }
  await mkdir(dest, { recursive: true });
  await cp(src, dest, {
    recursive: true,
    filter: (p) => !relative(src, p).split(sep).some((s) => SCAFFOLD_SKIP.has(s)),
  });
  const pkg = join(dest, 'package.json');
  if (existsSync(pkg)) await writeFile(pkg, (await readFile(pkg, 'utf8')).replaceAll('__API_NAME__', apiName), 'utf8');
}

/** Hash of every file at run start; the TypeScript files' content is kept under <runDir>/initial (revert check). */
async function snapshotHashes(ws: Workspace, runDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const contents = new Map<string, string>();
  for (const f of (await ws.list(['**/*'])).sort()) {
    const content = await ws.read(f);
    if (content === null) continue;
    out.set(f, sha256(content));
    contents.set(f, content);
  }
  await saveInitial(runDir, contents);
  return out;
}

/** Paths with uncommitted changes under the API root of the target checkout (they are NOT part of the run). */
async function uncommitted(repoDir: string, rootRel: string): Promise<string[]> {
  const r = await exec('git', ['-C', repoDir, 'status', '--porcelain=v1', '--untracked-files=all', '--', rootRel], { cwd: repoDir });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.trim().length > 0).map((l) => l.slice(3));
}

/**
 * Reserve a unique run id: the spec'd `${taskId}-${driver}-${date}-${time}`, suffixed `-2`, `-3`… when a
 * run dir, worktree or branch of that name already exists. The reservation is an atomic mkdir, so two
 * runs started in the same second (parallel tests) never share a worktree.
 */
async function reserveRunId(
  baseId: string,
  repoDir: string,
  worktreeParent: string,
  runsDir: string,
): Promise<{ runId: string; release: () => void }> {
  const claims = join(worktreeParent, '.claims');
  mkdirSync(claims, { recursive: true });
  for (let i = 1; i <= 100; i += 1) {
    const runId = i === 1 ? baseId : `${baseId}-${i}`;
    if (existsSync(join(worktreeParent, runId)) || existsSync(join(runsDir, runId))) continue;
    const branch = await exec('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/harness/${runId}`], { cwd: repoDir });
    if (branch.code === 0) continue;
    const claim = join(claims, runId);
    try {
      mkdirSync(claim);
    } catch {
      continue;
    }
    return { runId, release: () => rmSync(claim, { recursive: true, force: true }) };
  }
  throw new Error(`could not reserve a unique run id for ${baseId}`);
}

/** Undo a worktree whose run never started (setup failed): worktree, branch. */
async function discardWorktree(repoDir: string, worktreeRoot: string, branch: string): Promise<void> {
  await exec('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeRoot], { cwd: repoDir });
  await exec('git', ['-C', repoDir, 'branch', '-D', branch], { cwd: repoDir });
}

// ───────────────────────────── honesty ─────────────────────────────

export function honesty(task: Task, gates: NamedGateResult[], report: CheckReport | null, notes: string[] = []): Honesty {
  const h: Honesty = { proven: [], failed: [], unproven: [...notes], notApplicable: [], humanMustVerify: [] };
  for (const g of gates) {
    const name = `gate:${g.gate}`;
    if (g.status === 'pass') h.proven.push(name);
    else if (g.status === 'fail') h.failed.push(`${name} (${g.summary})`);
    else if (g.status === 'unproven') h.unproven.push(`${name} (${g.summary})`);
    else h.notApplicable.push(name);
  }
  if (report === null) {
    h.unproven.push('checks: the standards report could not be produced');
  } else {
    for (const r of report.rules) {
      const name = `check:${r.rule}`;
      if (r.status === 'pass') h.proven.push(name);
      else if (r.status === 'fail') h.failed.push(`${name} (${r.passed}/${r.total} ${r.unit})`);
      else if (r.status === 'n/a') h.notApplicable.push(`${name} (nothing to check)`);
      else h.unproven.push(`${name} (${r.passed}/${r.total} ${r.unit})`);
    }
  }
  h.humanMustVerify.push(
    'behaviour semantics beyond the tests the agent wrote',
    'that the agent-written tests cover every listed behaviour',
    'that each accepted red tested the intended behaviour (any failing non-constant assertion on src/ code counts as red)',
    'persistence, performance, security and concurrency beyond what the tests exercise',
  );
  if (task.kind === 'brownfield') {
    h.humanMustVerify.push(
      task.allowBreaking
        ? 'contract changes allowed by allowBreaking (the contract lock did not block them)'
        : 'behaviour changes that keep the contract shape (the contract lock compares schemas and status codes only)',
    );
  }
  return h;
}

export function formatHonesty(h: Honesty): string[] {
  const block = (label: string, items: string[]): string[] =>
    items.length === 0 ? [`  ${label.padEnd(18)} (none)`] : items.map((x, i) => `  ${(i === 0 ? label : '').padEnd(18)} ${x}`);
  return [
    'honesty',
    ...block('proven', h.proven),
    ...block('failed', h.failed),
    ...block('UNPROVEN', h.unproven),
    ...block('n/a', h.notApplicable),
    ...block('human must verify', h.humanMustVerify),
  ];
}

/** The run summary's standards line: verdict, then every rule with its status (n/a rules print `n/a`). */
export function standardsLine(report: CheckReport | null, aborted: boolean): string {
  if (report === null) return `UNPROVEN (${aborted ? 'not run: the run was aborted' : 'the checks could not run'})`;
  const rules = report.rules.map((r) => `${r.rule} ${r.status}`).join(', ');
  const v = report.verdict;
  if (v.status === 'pass') return `pass ${v.percent}%  ${rules}`;
  if (v.status === 'fail') {
    const failing = report.rules.filter((r) => r.status === 'fail');
    const onlyOthers = failing.length > 0 && failing.every((r) => r.category !== 'standards');
    // ORM/lint rules are diff-aware in the standards gate: violations in files the run did not change are pre-existing.
    return `FAIL ${v.percent}%  ${rules}${onlyOthers ? '  (only non-standards rules fail: the standards gate blocks only their violations in files this run changed)' : ''}`;
  }
  return `UNPROVEN (a rule was skipped or had nothing to check; ${v.percent}% of checked units passed)  ${rules}`;
}

// ───────────────────────────── executeRun ─────────────────────────────

export interface ExecuteRunOptions {
  taskFile: string;
  driver: string;
  model?: string;
  driverOptions: Record<string, string>;
  baseline: boolean;
  ship: boolean;
  maxTurns?: number;
  /** Where the compact summary is printed (default console.log). */
  log?: (line: string) => void;
  /** Resolve the task's relative output/target against this directory (default: the harness root). */
  repoBase?: string;
  /** Evidence directories (default: HARNESS_RUNS_DIR / HARNESS_TOKENS_DIR env, then harness.config.json). */
  runsDir?: string;
  tokensDir?: string;
  /** Operator abort (Ctrl-C): the loop stops between steps; evidence is still written. */
  signal?: AbortSignal;
  /** Remote for --ship (default origin). */
  remote?: string;
  /** Subprocess runner (default: the core exec). Tests inject one to make `gh` unavailable. */
  exec?: Exec;
  /** Extra driver plugins, looked up before the registry's (tests and embedders). */
  extraDrivers?: DriverPlugin[];
  /** --strict-task: the task file must already be canonical (no lenient front end). */
  strictTask?: boolean;
  /** --target / --output: override the task's API location (and decide a missing kind). */
  target?: string;
  output?: string;
}

/** Config whose runsDir/tokensDir point at the resolved evidence dirs (harness-relative when possible). */
function withEvidenceDirs(config: HarnessConfig, dirs: { runsDir: string; tokensDir: string }): HarnessConfig {
  const rel = (abs: string): string => {
    const r = relative(HARNESS_ROOT, abs);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? toPosix(r) : abs;
  };
  return { ...config, runsDir: rel(dirs.runsDir), tokensDir: rel(dirs.tokensDir) };
}

export async function executeRun(opts: ExecuteRunOptions): Promise<RunSummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const run = opts.exec ?? exec;
  const dirs = evidenceDirs(loadConfig(HARNESS_ROOT), HARNESS_ROOT, { runsDir: opts.runsDir, tokensDir: opts.tokensDir });
  const config = withEvidenceDirs(loadConfig(HARNESS_ROOT), dirs);
  setSandboxMode(config.sandbox);
  // Fail closed before any worktree exists: agent code would have nothing to confine it.
  const isolation = isolationInfo();
  if (isolation.mode === 'auto' && isolation.mechanism === 'none') throw isolationUnavailable();
  const registry = await loadRegistryOrThrow(config);
  const loaded: LoadedTask = await loadTask(resolve(opts.taskFile), { strict: opts.strictTask, target: opts.target, output: opts.output });
  const task = loaded.task;
  // Before any model call: what the front end renamed, inferred, dropped or carried.
  if (loaded.warnings.length > 0) {
    log(`task       ${loaded.warnings.length} note(s) normalizing ${loaded.file} ('harness task check' prints the canonical task):`);
    for (const w of loaded.warnings) log(`           - ${w}`);
  }

  const driverPlugins = [...(opts.extraDrivers ?? []), ...registry.drivers.map((d) => d.plugin)];
  const driverPlugin = driverPlugins.find((d) => d.name === opts.driver);
  if (driverPlugin === undefined) {
    const names = driverPlugins.map((d) => d.name).join(', ') || '(none)';
    throw new Error(`unknown driver "${opts.driver}". Available drivers: ${names}`);
  }
  let driver: Driver;
  try {
    driver = driverPlugin.create({
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      options: opts.driverOptions,
      env: process.env,
      harnessRoot: HARNESS_ROOT,
    });
  } catch (e) {
    throw new Error(`driver "${opts.driver}" could not start: ${errMsg(e)}`);
  }

  // ── workspace: a fresh worktree of the target repository; the target checkout itself is never touched.
  const startedAt = new Date();
  const { repoDir, rootRel } = await locateApi(task, opts.repoBase ?? HARNESS_ROOT);
  if (task.kind === 'greenfield') await refuseExistingOutput(repoDir, rootRel);
  const dirty = await uncommitted(repoDir, rootRel);
  const worktreeParent = resolve(HARNESS_ROOT, config.worktreeDir);
  const claim = await reserveRunId(newRunId(task.id, driver.name, startedAt), repoDir, worktreeParent, dirs.runsDir);
  const runId = claim.runId;
  const branch = `harness/${runId}`;
  let wt: { worktreeRoot: string; baseBranch: string; baseSha: string };
  try {
    wt = await createWorktree({ harnessRoot: HARNESS_ROOT, config, repoDir, runId, branch });
  } finally {
    claim.release();
  }
  let ws: Workspace;
  let manifest: TemplateManifest | null = null;
  try {
    if (task.kind === 'greenfield') {
      const templatesDir = resolve(HARNESS_ROOT, config.templatesDir);
      manifest = templateManifest(task.template, templatesDir);
      await scaffold(templatesDir, task.template, join(wt.worktreeRoot, rootRel), task.id);
    }
    ws = createWorkspace(wt.worktreeRoot, rootRel);
  } catch (e) {
    await discardWorktree(repoDir, wt.worktreeRoot, branch);
    throw e;
  }

  const runDir = join(dirs.runsDir, runId);
  const store = new RunStore(runDir, HARNESS_ROOT);
  const state = newRunState();
  state.initialHashes = await snapshotHashes(ws, store.runDir);
  const mode = opts.baseline ? BASELINE_MODE : JIT_MODE;
  const ctx = buildContext({
    run: {
      id: runId,
      driver: driver.name,
      model: driver.model,
      startedAt: startedAt.toISOString(),
      harnessRoot: HARNESS_ROOT,
      runDir,
      branch,
      baseBranch: wt.baseBranch,
      baseSha: wt.baseSha,
    },
    task,
    ws,
    state,
    store,
    mode,
    config,
    registry,
    exec: run,
  });

  // The tool list exactly as the model will be offered it (order included), recorded in run.json.
  let offered: ToolSpec[] | undefined;
  let offerError = '';
  try {
    offered = toolSpecs(registry.tools, task.kind);
  } catch (e) {
    offerError = errMsg(e);
  }

  const runRecordBase = {
    runId,
    taskFile: loaded.file,
    task: {
      id: task.id,
      kind: task.kind,
      sha256: loaded.sha256,
      normalizedSha256: loaded.normalizedSha256,
      format: loaded.format,
      strict: loaded.strict,
      file: harnessRel(loaded.file),
    },
    driver: driver.name,
    model: driver.model,
    tokenCounter: driver.tokenCounter,
    mode,
    startedAt: startedAt.toISOString(),
    targetRepo: repoDir,
    worktreeRoot: wt.worktreeRoot,
    rootRel: ws.rootRel,
    apiRoot: ws.root,
    branch,
    baseBranch: wt.baseBranch,
    baseSha: wt.baseSha,
    pluginFingerprint: pluginFingerprint(registry, { config, harnessRoot: HARNESS_ROOT }),
    toolsOffered: (offered ?? []).map((t) => t.name),
    checksRegistered: registry.checks.map((r) => r.plugin.id),
    isolation,
  };
  store.writeJson('run.json', { ...runRecordBase, status: 'running' });
  store.writeJson('task.normalized.json', {
    file: loaded.file,
    format: loaded.format,
    strict: loaded.strict,
    sha256: loaded.sha256,
    normalizedSha256: loaded.normalizedSha256,
    warnings: loaded.warnings,
    task,
  });
  if (loaded.warnings.length > 0) {
    ctx.emit({ kind: 'note', source: 'task', message: `${loaded.warnings.length} task-file normalization note(s); see task.normalized.json`, data: loaded.warnings });
  }
  if (dirty.length > 0) {
    ctx.emit({
      kind: 'note',
      source: 'run',
      message: `${dirty.length} uncommitted path(s) under ${rootRel} in ${repoDir} are not part of this run (the worktree starts from ${wt.baseSha.slice(0, 12)})`,
      data: dirty.slice(0, 50),
    });
  }

  const ledger = new TokenLedger({
    runId,
    task: task.id,
    driver: driver.name,
    model: driver.model,
    counter: driver.tokenCounter,
    mode: opts.baseline ? 'baseline' : 'jit',
  });

  let agent: AgentResult;
  try {
    if (offered === undefined) throw new Error(`tool schemas could not be built: ${offerError}`);
    const tools = offered;
    const checks = registry.checks.map((r) => r.plugin);
    const system = systemPrompt({ task, checks, tools });
    const baselineSystem = `${system}\n\n${await frontLoad({ ws, checks, tools })}`;
    const tree = compactTree(await ws.list(['**/*']));
    let testMapText: string | undefined;
    if (task.kind === 'brownfield') {
      try {
        testMapText = testMapSummary(await ctx.services.testMap());
      } catch (e) {
        ctx.emit({ kind: 'error', source: 'testmap', message: `test map unavailable: ${errMsg(e)}` });
      }
    }
    const api = task.kind === 'greenfield' ? await scaffoldApiOf(ws, manifest) : undefined;
    const brief = taskBrief(task, {
      tree,
      template: manifest,
      ...(testMapText !== undefined ? { testMap: testMapText } : {}),
      ...(api !== undefined ? { scaffoldApi: api } : {}),
    });
    const first = { role: 'user' as const, parts: [{ type: 'text' as const, text: brief }] };
    agent = await runAgent({
      driver,
      ctx,
      store,
      ledger,
      first,
      system,
      baselineSystem,
      tools,
      maxTurns: opts.maxTurns ?? task.limits.maxTurns,
      maxOutputTokens: task.limits.maxOutputTokens,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    agent = { status: 'error', turns: state.turn, error: `run setup failed: ${errMsg(e)}` };
  }

  // Drivers may downgrade mid-run (a compat suffix, a fallback model): report the model actually in use.
  const finalModel = driver.model;
  ctx.run.model = finalModel;
  ledger.meta.model = finalModel;

  // An operator stop (Ctrl-C / SIGTERM) that lands after the loop ended (e.g. while the finish
  // gates ran, after `finish` was accepted) still stops the run: it is checked again before every
  // slow post-loop step, and a stopped run is reported `aborted`, never ships, never exits 0.
  const stopRequested = (): boolean => opts.signal?.aborted === true;
  let abortedRun = agent.status === 'aborted' || stopRequested();
  // Interim record: a hard kill during the final gates or checks leaves the loop's outcome, not `running`.
  if (!abortedRun) store.writeJson('run.json', { ...runRecordBase, status: 'finalizing', loopStatus: agent.status, turns: agent.turns });

  // Fresh final gate run: never trust what the loop saw. Skipped (and reported UNPROVEN) after an abort.
  const final: GateOutcome = abortedRun
    ? { ok: false, results: [], text: 'gates     not run: the run was aborted (UNPROVEN)', compact: '' }
    : await runGates(registry.gates, ctx, 'finish');
  abortedRun ||= stopRequested();
  let report: CheckReport | null = null;
  if (abortedRun) {
    store.writeText('standards.txt', 'standards not run: the run was aborted (UNPROVEN)\n');
  } else {
    try {
      report = await ctx.services.runChecks();
      store.writeText('standards.txt', report.text);
    } catch (e) {
      store.writeText('standards.txt', `standards could not run: ${errMsg(e)}\n`);
    }
  }
  abortedRun ||= stopRequested();
  const status: AgentStatus = abortedRun ? 'aborted' : agent.status;
  const error =
    abortedRun && agent.status !== 'aborted'
      ? `stopped by signal after the loop ended ${agent.status}${agent.error !== undefined ? ` (${agent.error})` : ''}`
      : agent.error;
  store.writeJson('gates.json', { phase: 'finish', ok: final.ok, results: final.results });
  store.writeJson('state.json', serializeState(state));
  const tokensPath = ledger.write(dirs.tokensDir);
  const tokenReport = ledger.report();
  const ok = status === 'done' && final.ok;

  let shipped: ShipOutcome | undefined;
  if (opts.ship) {
    if (abortedRun || stopRequested()) {
      shipped = { status: 'refused', branch, reasons: ['stopped by signal'] };
    } else if (ok) {
      try {
        const { ship } = await import('./ship.ts');
        shipped = await ship({ ctx, registry, dryRun: false, ...(opts.remote !== undefined ? { remote: opts.remote } : {}) });
      } catch (e) {
        shipped = { status: 'refused', branch, reasons: [`ship crashed: ${errMsg(e)}`] };
      }
    } else {
      shipped = { status: 'refused', branch, reasons: ['run did not finish with all gates green'] };
    }
  }

  const notes = abortedRun
    ? [final.results.length > 0 || report !== null ? 'run stopped by signal after the loop ended: the remaining post-loop steps did not run' : 'gates and checks: not run because the run was aborted']
    : [];
  const h = honesty(task, final.results, report, notes);
  const iso = isolationHonesty(isolation);
  (iso.proven ? h.proven : h.unproven).push(iso.line);
  const evidence = {
    runJson: harnessRel(join(runDir, 'run.json')),
    events: harnessRel(join(runDir, 'events.jsonl')),
    transcript: harnessRel(join(runDir, 'transcript.jsonl')),
    gates: harnessRel(join(runDir, 'gates.json')),
    standards: harnessRel(join(runDir, 'standards.txt')),
    state: harnessRel(join(runDir, 'state.json')),
    tokens: harnessRel(tokensPath),
  };
  store.writeJson('run.json', {
    ...runRecordBase,
    model: finalModel,
    tokenCounter: ledger.counterLabel(),
    ...(finalModel !== runRecordBase.model ? { initialModel: runRecordBase.model } : {}),
    status,
    ...(status !== agent.status ? { loopStatus: agent.status } : {}),
    ok,
    turns: agent.turns,
    ...(error !== undefined ? { error } : {}),
    finishedAt: new Date().toISOString(),
    finishAttempts: state.finishAttempts,
    gatesOk: final.ok,
    gates: final.results,
    standards: report === null ? null : { verdict: report.verdict, rules: report.rules },
    tokens: { ...tokenReport.totals, turns: tokenReport.turns.length, path: harnessRel(tokensPath) },
    evidence,
    honesty: h,
    ...(shipped !== undefined ? { ship: shipped } : {}),
  });

  const t = tokenReport.totals;
  const lines = [
    `run        ${runId}`,
    `status     ${status}  turns ${agent.turns}  finish attempts ${state.finishAttempts}  driver ${driver.name}  model ${finalModel}${opts.baseline ? '  (baseline mode)' : ''}`,
    ...(error !== undefined ? [`error      ${error}`] : []),
    `gates      fresh final run (phase finish): ${final.results.length === 0 && abortedRun ? 'not run' : final.ok ? 'all green' : 'NOT green'}`,
    ...(final.results.length > 0 ? formatGates(final.results, true).split('\n') : [final.text]),
    `standards  ${standardsLine(report, abortedRun && report === null)}`,
    `tokens     actual ${t.actual_input_tokens}  baseline ${t.baseline_input_tokens}  reduction ${t.reduction_pct}%  over ${tokenReport.turns.length} turns  (output ${t.output_tokens}, provider-reported input ${t.provider_reported_input_tokens})`,
    `evidence   ${harnessRel(runDir)}/{run.json,events.jsonl,transcript.jsonl,gates.json,standards.txt,state.json,logs/}`,
    `           ${evidence.tokens}`,
    `worktree   ${wt.worktreeRoot}  branch ${branch}  (base ${wt.baseBranch} @ ${wt.baseSha.slice(0, 12)}; ${repoDir} untouched)`,
    ...formatHonesty(h),
    ...(shipped !== undefined ? [`ship       ${shipped.status}${shipped.commit !== undefined ? ` ${shipped.commit.slice(0, 12)}` : ''}${shipped.prUrl !== undefined ? ` ${shipped.prUrl}` : ''}${shipped.reasons.length > 0 ? `: ${shipped.reasons.join('; ')}` : ''}`] : []),
    ...(abortedRun ? [`resume     the worktree and evidence are kept; 'harness ship ${runId} --dry-run' re-runs every gate fresh on it`] : []),
    `verdict    ${ok ? 'DONE (all gates green)' : `NOT DONE (${status !== 'done' ? (status !== agent.status ? 'stopped by signal' : `loop ended ${status}`) : 'final gates not green'})`}`,
  ];
  const text = lines.join('\n');
  log(text);

  return {
    runId,
    status,
    ok,
    driver: driver.name,
    model: finalModel,
    turns: agent.turns,
    runDir,
    worktree: wt.worktreeRoot,
    branch,
    targetRepo: repoDir,
    gates: final.results,
    gatesOk: final.ok,
    standards: report === null ? null : report.verdict,
    tokens: tokenReport.totals,
    tokensPath,
    honesty: h,
    ...(shipped !== undefined ? { ship: shipped } : {}),
    ...(error !== undefined ? { error } : {}),
    text,
  };
}

// ───────────────────────────── reopening a run (ship, inspection) ─────────────────────────────

const RunRecordSchema = z.looseObject({
  runId: z.string(),
  taskFile: z.string(),
  driver: z.string(),
  model: z.string(),
  startedAt: z.string(),
  worktreeRoot: z.string(),
  rootRel: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string(),
  mode: z.object({ jit: z.boolean(), compactReturns: z.boolean(), compactHistory: z.boolean() }),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * Rebuild a RunContext for an earlier run from runs/<id>/{run.json,state.json}.
 * `ref` is a run id (looked up in the evidence runs dir) or a path to a run directory.
 */
export async function openRun(
  ref: string,
  opts: { runsDir?: string; tokensDir?: string; exec?: Exec } = {},
): Promise<{ ctx: RunContext; registry: RegistryView; store: RunStore; record: RunRecord }> {
  const dirs = evidenceDirs(loadConfig(HARNESS_ROOT), HARNESS_ROOT, { runsDir: opts.runsDir, tokensDir: opts.tokensDir });
  const config = withEvidenceDirs(loadConfig(HARNESS_ROOT), dirs);
  setSandboxMode(config.sandbox);
  const runDir = resolveRunDir(ref, dirs.runsDir);
  const registry = await loadRegistryOrThrow(config);
  const store = new RunStore(runDir, HARNESS_ROOT);
  const parsed = RunRecordSchema.safeParse(store.readJson<unknown>('run.json'));
  if (!parsed.success) throw new Error(`${harnessRel(runDir)}/run.json is not a valid run record`);
  const record = parsed.data;
  if (!existsSync(record.worktreeRoot)) throw new Error(`worktree no longer exists: ${record.worktreeRoot}`);
  // The task exactly as the run used it (CLI overrides included); older runs re-read the task file.
  const normalized = store.readJson<{ task?: unknown }>('task.normalized.json');
  const runTask = normalized?.task !== undefined ? parseTask(normalized.task, `${harnessRel(runDir)}/task.normalized.json`) : (await loadTask(record.taskFile)).task;
  const ws = createWorkspace(record.worktreeRoot, record.rootRel);
  const savedState = store.readJson<unknown>('state.json');
  const state = savedState === null ? newRunState() : deserializeState(savedState);
  const ctx = buildContext({
    run: {
      id: record.runId,
      driver: record.driver,
      model: record.model,
      startedAt: record.startedAt,
      harnessRoot: HARNESS_ROOT,
      runDir,
      branch: record.branch,
      baseBranch: record.baseBranch,
      baseSha: record.baseSha,
    },
    task: runTask,
    ws,
    state,
    store,
    mode: record.mode,
    config,
    registry,
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
  });
  return { ctx, registry, store, record };
}

/** A run id (under runsDir) or a path to a run directory / its run.json → absolute run directory. */
export function resolveRunDir(ref: string, runsDir: string): string {
  const asPath = resolve(ref);
  if (existsSync(asPath)) {
    const dir = basename(asPath) === 'run.json' ? dirname(asPath) : asPath;
    if (existsSync(join(dir, 'run.json'))) return dir;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error(`invalid run id "${ref}" (and no run directory at that path)`);
  const dir = join(runsDir, ref);
  if (!existsSync(join(dir, 'run.json'))) throw new Error(`no such run: ${harnessRel(dir)}/run.json`);
  return dir;
}
