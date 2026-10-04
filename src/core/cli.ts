/**
 * `harness` command line. Minimal hand-rolled argument parsing; compact output.
 * Exit codes: 0 success, 1 failure / not green, 2 usage error.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { ruleWidth, runChecks, selectChecks } from './checks.ts';
import { evidenceDirs, HARNESS_ROOT, loadConfig } from './config.ts';
import { exec } from './exec.ts';
import { testMapSummary } from './prompt.ts';
import { loadRegistry } from './registry.ts';
import { TURN_EXTENSION_STEP, TURN_LIMIT_BASE, TURN_LIMIT_CAP, TURNS_PER_BEHAVIOUR, TURNS_PER_RESOURCE } from './loop.ts';
import { RunStore } from './run-store.ts';
import { detectMechanism, isolationSelfTest, POLICY_SUMMARY, sandboxMode, setSandboxMode } from './sandbox.ts';
import { executeRun, openRun, resolveRunDir, type RunSummary } from './run.ts';
import { loadTask } from './task.ts';
import { buildTestMap } from './testmap.ts';
import { comparisonsFor, compareRuns, formatComparison, formatTokenReport, parseTokenReport, type TokenReport } from './tokens.ts';
import { createWorkspace } from './workspace.ts';
import type { CheckPlugin, HarnessConfig, RegistryView } from './types.ts';

export const USAGE = `usage: harness <command> [options]

commands:
  run <task-file> --driver <name> [--model <id>] [--driver-opt k=v]... [--baseline]
                  [--max-turns N] [--repo <dir>] [--target <dir> | --output <dir>]
                  [--strict-task] [--ship [--remote <name>]]
      Govern one run in a fresh git worktree of the target repository: agent loop, hooks,
      fresh final gates, evidence in runs/<id>/ and tokens/<id>.json. The task's output/target
      resolves against --repo <dir> (default: the harness root); any git repository works, and
      the worktree always lives under the harness's .harness/worktrees.
      Task files: .yaml/.yml/.json, or .md/.txt free text (docs/task-format.md). Aliases and
      missing keys are normalized and reported before the first model call; the canonical task
      is saved as runs/<id>/task.normalized.json. --target <dir> (an existing API: brownfield)
      or --output <dir> (a new API: greenfield), relative to the current directory, overrides
      the file. --strict-task accepts only the canonical schema (no aliases, inference or
      carried keys).
      Evidence dirs: HARNESS_RUNS_DIR (default runs/) and HARNESS_TOKENS_DIR (default tokens/)
      override where runs/<id>/ and tokens/<id>.json are written (relative to the harness root).
      Ctrl-C or SIGTERM stops between steps and still writes the evidence (exit 130 / 143).
      --baseline: the measured token baseline: no context fetchers, no compaction; the current
      tree and the standards are front-loaded into every request.
      --max-turns N (or the task file's maxTurns) is a hard cap. Without either, the limit is
      ${TURN_LIMIT_BASE} + ${TURNS_PER_RESOURCE} per resource + ${TURNS_PER_BEHAVIOUR} per behaviour (at most ${TURN_LIMIT_CAP}), extended by ${TURN_EXTENSION_STEP} turns at a
      time (at most half the default) while finish attempts show fewer failing gate units.
      exit 0 = DONE (all gates green; with --ship: shipped), 1 = not done / refused
  check --api <dir> [--rule r]... [--category c]... [--json]
      Standards checks on any API directory (absolute or relative; no run needed), one line
      per rule per file. A directory without node_modules is checked as a temporary copy that
      resolves dependencies from the harness. An unknown --rule id, or a --category no check
      has, is a usage error (exit 2) that lists the registered rule ids. exit 0 iff 100%
  plugins                         list drivers, tools, hooks, gates, checks (+ load errors)
  tokens <runId|path>             print a run's per-turn token report (its baseline_kind: shadow
                                  or measured; a measured comparison is shown when one exists)
  tokens compare <jitRunId> <baselineRunId>
                                  measured comparison of a JIT run and a --baseline run: per-run
                                  totals and per-turn averages, with caveats
  agnostic <runA> <runB>          compare task sha + tool/hook/gate/check fingerprints of two
                                  runs (run ids or run directories). exit 0 iff zero diff
  ship <run> [--dry-run] [--remote <name>]
                                  re-run every gate fresh, then commit/push/PR the run branch
                                  (the harness ships; the agent never does). exit 0 iff shipped/dry-run
  task check <task-file> [--strict-task] [--target <dir> | --output <dir>] [--json]
                                  normalize a task file without a run (no tokens spent): the
                                  canonical task (YAML) and every note; exit 0 iff it is valid
  testmap --api <dir>             print the test -> source import map
  doctor                          environment, plugin load, provider-leak scan and an isolation
                                  self-test (exit 1 if agent code cannot be confined in auto mode)

exit codes: 0 success, 1 failure / not green, 2 usage error, 130 interrupted (143 on SIGTERM).
env: HARNESS_RUNS_DIR, HARNESS_TOKENS_DIR override where evidence is written and read
     (run, ship, tokens, agnostic); relative values resolve against the harness root.
     HARNESS_SANDBOX=off|auto overrides harness.config.json "sandbox" (off = agent code runs
     unconfined, recorded as UNPROVEN isolation).
`;

const BOOL_FLAGS = new Set(['baseline', 'ship', 'json', 'dry-run', 'help', 'strict-task']);

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

export function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { positionals: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '-h') {
      out.bools.add('help');
      continue;
    }
    if (!a.startsWith('--')) {
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (name.length === 0) return { error: `invalid option "${a}"` };
    if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) return { error: `--${name} takes no value` };
      out.bools.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = args[i + 1];
      i += 1;
    }
    if (value === undefined || value.length === 0) return { error: `--${name} needs a value` };
    const list = out.flags.get(name);
    if (list === undefined) out.flags.set(name, [value]);
    else list.push(value);
  }
  return out;
}

function one(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags.get(name);
  return v === undefined ? undefined : v[v.length - 1];
}

function many(p: ParsedArgs, name: string): string[] {
  return p.flags.get(name) ?? [];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function unknownFlags(p: ParsedArgs, allowed: string[]): string | null {
  const ok = new Set([...allowed, 'help']);
  for (const k of [...p.flags.keys(), ...p.bools]) if (!ok.has(k)) return `unknown option --${k}`;
  return null;
}

type Out = (line: string) => void;

// ───────────────────────────── commands ─────────────────────────────

async function cmdRun(p: ParsedArgs, out: Out): Promise<number> {
  const bad = unknownFlags(p, ['driver', 'model', 'driver-opt', 'baseline', 'ship', 'max-turns', 'repo', 'remote', 'strict-task', 'target', 'output']);
  const taskFile = p.positionals[0];
  const driver = one(p, 'driver');
  if (bad !== null || taskFile === undefined || driver === undefined || p.positionals.length > 1) {
    out(bad ?? (p.positionals.length > 1 ? `run takes one task file, got: ${p.positionals.join(' ')}` : 'run needs <task-file> and --driver <name>'));
    return 2;
  }
  if (!existsSync(resolve(taskFile))) {
    out(`task file not found: ${taskFile}`);
    return 2;
  }
  const driverOptions: Record<string, string> = {};
  for (const kv of many(p, 'driver-opt')) {
    const i = kv.indexOf('=');
    if (i <= 0) {
      out(`--driver-opt expects k=v, got "${kv}"`);
      return 2;
    }
    driverOptions[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const mt = one(p, 'max-turns');
  let maxTurns: number | undefined;
  if (mt !== undefined) {
    maxTurns = Number(mt);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      out('--max-turns must be a positive integer');
      return 2;
    }
  }
  const repo = one(p, 'repo');
  if (repo !== undefined && !(existsSync(resolve(repo)) && statSync(resolve(repo)).isDirectory())) {
    out(`--repo is not a directory: ${repo}`);
    return 2;
  }
  const remote = one(p, 'remote');
  if (remote !== undefined && !p.bools.has('ship')) {
    out('--remote only applies with --ship');
    return 2;
  }
  const model = one(p, 'model');
  const location = taskLocation(p);
  if ('error' in location) {
    out(location.error);
    return 2;
  }

  // Ctrl-C or SIGTERM (kill, a CI timeout): the first signal stops the loop between steps and the
  // evidence is still written; a second one exits now. Exit code 128 + signal number (130 / 143).
  const controller = new AbortController();
  let interrupts = 0;
  let stoppedBy: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupts += 1;
    stoppedBy ??= signal;
    if (interrupts > 1) {
      out(`${signal} again: exiting now (the worktree and partial evidence are kept)`);
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    }
    out(`${signal}: stopping after the current step and writing the evidence (send it again to exit now)`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const summary = await executeRun({
      taskFile,
      driver,
      ...(model !== undefined ? { model } : {}),
      driverOptions,
      baseline: p.bools.has('baseline'),
      ship: p.bools.has('ship'),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(repo !== undefined ? { repoBase: resolve(repo) } : {}),
      ...(remote !== undefined ? { remote } : {}),
      ...location,
      strictTask: p.bools.has('strict-task'),
      signal: controller.signal,
      log: out,
    });
    // A stop requested at any point (even after `finish` was accepted) is an interrupted run, whatever its status.
    if (stoppedBy !== undefined) return stoppedBy === 'SIGTERM' ? 143 : 130;
    return runExitCode(summary);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

/**
 * --target / --output as absolute paths (a flag is typed relative to the shell, not the task file).
 * They are mutually exclusive: one names an existing API to change, the other a new one to build.
 */
function taskLocation(p: ParsedArgs): { target?: string; output?: string } | { error: string } {
  const target = one(p, 'target');
  const output = one(p, 'output');
  if (target !== undefined && output !== undefined) return { error: '--target (change an existing API) and --output (build a new one) are mutually exclusive' };
  if (target !== undefined && !(existsSync(resolve(target)) && statSync(resolve(target)).isDirectory())) return { error: `--target is not a directory: ${target}` };
  return {
    ...(target !== undefined ? { target: resolve(target) } : {}),
    ...(output !== undefined ? { output: resolve(output) } : {}),
  };
}

/** `harness task check <file>`: the canonical task and every normalization note, no run and no tokens. */
async function cmdTask(p: ParsedArgs, out: Out): Promise<number> {
  const [sub, file, ...extra] = p.positionals;
  const bad = unknownFlags(p, ['strict-task', 'target', 'output', 'json']);
  if (bad !== null || sub !== 'check' || file === undefined || extra.length > 0) {
    out(bad ?? 'usage: harness task check <task-file> [--strict-task] [--target <dir> | --output <dir>] [--json]');
    return 2;
  }
  if (!existsSync(resolve(file))) {
    out(`task file not found: ${file}`);
    return 2;
  }
  const location = taskLocation(p);
  if ('error' in location) {
    out(location.error);
    return 2;
  }
  let loaded: Awaited<ReturnType<typeof loadTask>>;
  try {
    loaded = await loadTask(file, { ...location, strict: p.bools.has('strict-task') });
  } catch (e) {
    out(errMsg(e));
    return 1;
  }
  if (p.bools.has('json')) {
    const { file: abs, format, strict, sha256, normalizedSha256, warnings, task } = loaded;
    out(JSON.stringify({ file: abs, format, strict, sha256, normalizedSha256, warnings, task }, null, 2));
    return 0;
  }
  const t = loaded.task;
  out(`task      ${loaded.file} (${loaded.format}${loaded.strict ? ', --strict-task' : ''})`);
  out(`kind      ${t.kind}  id ${t.id}  ${t.kind === 'greenfield' ? `output ${t.output}` : `target ${t.target}`}`);
  out(`sha256    ${loaded.sha256}  normalized ${loaded.normalizedSha256}`);
  out(`notes     ${loaded.warnings.length === 0 ? '(none: the file is canonical)' : loaded.warnings.length}`);
  for (const w of loaded.warnings) out(`  - ${w}`);
  out('canonical task:');
  for (const line of stringifyYaml(t, { lineWidth: 0 }).trimEnd().split('\n')) out(`  ${line}`);
  return 0;
}

/** 0 = done with all gates green (and shipped, when --ship was asked); 130 = interrupted; else 1. */
export function runExitCode(summary: Pick<RunSummary, 'ok' | 'status' | 'ship'>): number {
  if (summary.status === 'aborted') return 130;
  if (!summary.ok) return 1;
  if (summary.ship !== undefined && summary.ship.status !== 'shipped') return 1;
  return 0;
}

async function loadAll(): Promise<{ config: HarnessConfig; registry: RegistryView }> {
  const config = loadConfig(HARNESS_ROOT);
  setSandboxMode(config.sandbox);
  return { config, registry: await loadRegistry(config, HARNESS_ROOT) };
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

function apiDir(p: ParsedArgs, out: Out): string | null {
  const dir = one(p, 'api');
  if (dir === undefined) {
    out('missing --api <dir>');
    return null;
  }
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    out(`not a directory: ${dir}`);
    return null;
  }
  return abs;
}

/** True when `dir` or one of its ancestors has a node_modules directory (so the API's imports can resolve). */
export function hasNodeModules(dir: string): boolean {
  let cur = resolve(dir);
  for (;;) {
    const nm = join(cur, 'node_modules');
    if (existsSync(nm) && statSync(nm).isDirectory()) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

const MIRROR_SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite']);

/**
 * Copy an API directory (sources, tests, configs; no dependencies or build output) under
 * .harness/tmp so module and type resolution walks up to the harness's node_modules.
 * Used by `harness check --api <dir>` for directories that have no dependencies installed.
 */
export function mirrorApi(root: string): string {
  const dest = join(HARNESS_ROOT, '.harness', 'tmp', `check-${basename(root)}-${process.pid}-${Date.now()}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(root, dest, {
    recursive: true,
    filter: (src) => !relative(root, src).split(sep).some((seg) => MIRROR_SKIP.has(seg)),
  });
  return dest;
}

async function cmdCheck(p: ParsedArgs, out: Out): Promise<number> {
  const bad = unknownFlags(p, ['api', 'rule', 'category', 'json']);
  if (bad !== null) {
    out(bad);
    return 2;
  }
  const root = apiDir(p, out);
  if (root === null) return 2;
  const { registry } = await loadAll();
  for (const e of registry.errors) out(`plugin error  ${e.file}: ${e.error}`);
  const rules = many(p, 'rule');
  const categories = many(p, 'category');
  const selectionError = checkSelectionError(registry.checks.map((r) => r.plugin), rules, categories);
  if (selectionError !== null) {
    out(selectionError);
    return 2;
  }
  const logs = new RunStore(join(HARNESS_ROOT, '.harness', 'checks', `${basename(root)}-${stamp()}`), HARNESS_ROOT).logs;
  const mirror = hasNodeModules(root) ? null : mirrorApi(root);
  if (mirror !== null) {
    out(`note: no node_modules at or above ${root}; checking a copy under ${toPosix(relative(HARNESS_ROOT, mirror))} that resolves dependencies from the harness`);
  }
  let report: Awaited<ReturnType<typeof runChecks>>;
  try {
    const checked = await runChecks({
      root: mirror ?? root,
      checks: registry.checks.map((r) => r.plugin),
      exec,
      harnessRoot: HARNESS_ROOT,
      logs,
      ...(rules.length > 0 ? { rules } : {}),
      ...(categories.length > 0 ? { categories } : {}),
    });
    report = mirror === null ? checked : { ...checked, root };
  } finally {
    if (mirror !== null) rmSync(mirror, { recursive: true, force: true });
  }
  if (p.bools.has('json')) out(JSON.stringify(report, null, 2));
  else out(report.text);
  return report.verdict.status === 'pass' && report.verdict.percent === 100 ? 0 : 1;
}

/**
 * A usage error for `check --rule/--category` that would select nothing (an unknown rule id, a
 * category no registered check has, or a combination with no check in common), else null.
 * Silently checking nothing would print an empty report instead of the mistake.
 */
export function checkSelectionError(checks: CheckPlugin[], rules: string[], categories: string[]): string | null {
  const ids = checks.map((c) => c.id);
  const cats = [...new Set(checks.map((c) => c.category))];
  const list = (xs: string[]): string => (xs.length > 0 ? xs.join(', ') : '(none)');
  const unknownRules = rules.filter((r) => !ids.includes(r));
  if (unknownRules.length > 0) {
    return `unknown rule${unknownRules.length > 1 ? 's' : ''} ${unknownRules.map((r) => `"${r}"`).join(', ')}. Registered rule ids: ${list(ids)}`;
  }
  const unknownCats = categories.filter((c) => !cats.includes(c));
  if (unknownCats.length > 0) {
    return `no registered check has category ${unknownCats.map((c) => `"${c}"`).join(', ')}. Registered categories: ${list(cats)}; rule ids: ${list(ids)}`;
  }
  if ((rules.length > 0 || categories.length > 0) && selectChecks(checks, categories, rules).length === 0) {
    return `--rule ${rules.join(',')} and --category ${categories.join(',')} select no check in common. Registered rule ids: ${list(checks.map((c) => `${c.id} [${c.category}]`))}`;
  }
  return null;
}

async function cmdPlugins(out: Out): Promise<number> {
  const { registry } = await loadAll();
  const groups: Array<[string, Array<{ name: string; file: string; description: string }>]> = [
    ['drivers', registry.drivers.map((r) => ({ name: r.plugin.name, file: r.file, description: r.plugin.description }))],
    ['tools', registry.tools.map((r) => ({ name: r.plugin.name, file: r.file, description: `[${r.plugin.effect}] ${r.plugin.description ?? ''}`.trimEnd() }))],
    ['hooks', registry.hooks.map((r) => ({ name: r.plugin.name, file: r.file, description: r.plugin.description ?? '' }))],
    ['gates', registry.gates.map((r) => ({ name: r.plugin.name, file: r.file, description: r.plugin.description ?? '' }))],
    ['checks', registry.checks.map((r) => ({ name: r.plugin.id, file: r.file, description: `[${r.plugin.category}] ${r.plugin.description ?? ''}`.trimEnd() }))],
  ];
  const nameW = ruleWidth(groups.flatMap(([, list]) => list.map((x) => x.name)));
  for (const [kind, list] of groups) {
    out(`${kind} (${list.length})`);
    for (const x of list) out(`  ${x.name.padEnd(nameW)} ${x.file.padEnd(40)} ${x.description}`);
  }
  if (registry.errors.length > 0) {
    out(`load errors (${registry.errors.length})`);
    for (const e of registry.errors) out(`  ${e.file}: ${e.error}`);
    return 1;
  }
  return 0;
}

function readTokenReport(config: HarnessConfig, ref: string): TokenReport {
  const file = existsSync(ref) && statSync(ref).isFile() ? resolve(ref) : join(evidenceDirs(config).tokensDir, `${ref}.json`);
  if (!existsSync(file)) throw new Error(`no token report at ${toPosix(relative(HARNESS_ROOT, file))}`);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return parseTokenReport(parsed);
}

async function cmdTokens(p: ParsedArgs, out: Out): Promise<number> {
  const config = loadConfig(HARNESS_ROOT);
  if (p.positionals[0] === 'compare') {
    const a = p.positionals[1];
    const b = p.positionals[2];
    if (a === undefined || b === undefined) {
      out('tokens compare needs <jitRunId> <baselineRunId>');
      return 2;
    }
    const cmp = compareRuns(readTokenReport(config, a), readTokenReport(config, b));
    const dir = evidenceDirs(config).tokensDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `compare-${cmp.jit.runId}-vs-${cmp.baseline.runId}.json`);
    writeFileSync(file, `${JSON.stringify(cmp, null, 2)}\n`, 'utf8');
    for (const line of formatComparison(cmp)) out(line);
    out(`written   ${toPosix(relative(HARNESS_ROOT, file))}`);
    return 0;
  }
  const ref = p.positionals[0];
  if (ref === undefined) {
    out('tokens needs <runId|path> or "compare <jitRunId> <baselineRunId>"');
    return 2;
  }
  const report = readTokenReport(config, ref);
  out(formatTokenReport(report));
  // A measured comparison (tokens compare) is preferred over a shadow estimate wherever one exists.
  for (const m of comparisonsFor(evidenceDirs(config).tokensDir, report.runId)) {
    out(
      `measured  ${m.jitRunId} vs --baseline ${m.baselineRunId}: ${m.reduction_pct}% per-run totals` +
        `${m.per_turn_reduction_pct !== null ? `, ${m.per_turn_reduction_pct}% per-turn average` : ''}` +
        `${m.caveats.length > 0 ? ` (${m.caveats.length} caveat(s))` : ''}  (preferred: ${toPosix(relative(HARNESS_ROOT, m.file))})`,
    );
  }
  return 0;
}

const RunFingerprintSchema = z.looseObject({
  driver: z.string().optional(),
  model: z.string().optional(),
  task: z.looseObject({ id: z.string().optional(), sha256: z.string() }),
  pluginFingerprint: z.record(z.string(), z.string()),
});

export function agnosticDiff(
  a: z.infer<typeof RunFingerprintSchema>,
  b: z.infer<typeof RunFingerprintSchema>,
): string[] {
  const diffs: string[] = [];
  if (a.task.sha256 !== b.task.sha256) diffs.push(`task sha differs: ${a.task.sha256.slice(0, 12)} vs ${b.task.sha256.slice(0, 12)}`);
  const files = [...new Set([...Object.keys(a.pluginFingerprint), ...Object.keys(b.pluginFingerprint)])].sort();
  for (const f of files) {
    const x = a.pluginFingerprint[f];
    const y = b.pluginFingerprint[f];
    if (x === undefined) diffs.push(`only in B: ${f}`);
    else if (y === undefined) diffs.push(`only in A: ${f}`);
    else if (x !== y) diffs.push(`changed: ${f} (${x.slice(0, 12)} vs ${y.slice(0, 12)})`);
  }
  return diffs;
}

async function cmdAgnostic(p: ParsedArgs, out: Out): Promise<number> {
  const [a, b] = p.positionals;
  if (a === undefined || b === undefined || p.positionals.length > 2) {
    out('agnostic needs exactly two runs: <runIdA|dir> <runIdB|dir>');
    return 2;
  }
  const runsDir = evidenceDirs(loadConfig(HARNESS_ROOT)).runsDir;
  const read = (ref: string): z.infer<typeof RunFingerprintSchema> => {
    const file = join(resolveRunDir(ref, runsDir), 'run.json');
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${toPosix(relative(HARNESS_ROOT, file))} is not valid JSON: ${errMsg(e)}`);
    }
    const r = RunFingerprintSchema.safeParse(json);
    if (!r.success) throw new Error(`${toPosix(relative(HARNESS_ROOT, file))} has no task sha / plugin fingerprint`);
    return r.data;
  };
  const ra = read(a);
  const rb = read(b);
  out(`A  ${a}  driver ${ra.driver ?? '?'}  model ${ra.model ?? '?'}`);
  out(`B  ${b}  driver ${rb.driver ?? '?'}  model ${rb.model ?? '?'}`);
  const diffs = agnosticDiff(ra, rb);
  if (diffs.length === 0) {
    out(`zero diff: same task sha ${ra.task.sha256.slice(0, 12)}, ${Object.keys(ra.pluginFingerprint).length} tool/hook/gate/check and shared helper files identical`);
    return 0;
  }
  out(`${diffs.length} difference(s):`);
  for (const d of diffs) out(`  ${d}`);
  return 1;
}

async function cmdShip(p: ParsedArgs, out: Out): Promise<number> {
  const bad = unknownFlags(p, ['dry-run', 'remote']);
  const runId = p.positionals[0];
  if (bad !== null || runId === undefined) {
    out(bad ?? 'ship needs <runId>');
    return 2;
  }
  const { ctx, registry } = await openRun(runId);
  const { ship } = await import('./ship.ts');
  const remote = one(p, 'remote');
  const r = await ship({ ctx, registry, dryRun: p.bools.has('dry-run'), ...(remote !== undefined ? { remote } : {}) });
  out(`ship  ${r.status}  branch ${r.branch}${r.commit !== undefined ? `  commit ${r.commit}` : ''}${r.prUrl !== undefined ? `  ${r.prUrl}` : ''}`);
  // A dry run shows the gates it just re-ran fresh (phase ship) before the plan, so the plan is never read without them.
  if (r.status === 'dry-run' && r.gates !== undefined) {
    out(`gates (re-run fresh, phase ship): ${r.gates.ok ? 'all green' : 'NOT green'}`);
    for (const line of r.gates.text.split('\n')) if (line.trim() !== '') out(`  ${line}`);
  }
  for (const reason of r.reasons) out(`  ${reason}`);
  return r.status === 'shipped' || r.status === 'dry-run' ? 0 : 1;
}

async function cmdTestmap(p: ParsedArgs, out: Out): Promise<number> {
  const root = apiDir(p, out);
  if (root === null) return 2;
  const map = await buildTestMap(createWorkspace(root, '.'));
  const text = testMapSummary(map, 500);
  out(text.length > 0 ? text : '(no test files)');
  return 0;
}

// ───────────────────────────── doctor ─────────────────────────────

/** Always scanned besides the plugin directories. */
const LEAK_SCAN_FIXED = ['tasks', 'src/core'];
/** The driver folder directly under a plugin directory: the only place a provider may be named. */
const DRIVERS_DIR = 'drivers';

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out.sort();
}

function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? null);
}

function importedPackages(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const pkg = packageOf(m[1] ?? m[2] ?? '');
    if (pkg !== null) out.add(pkg);
  }
  return out;
}

export interface ProviderVocabulary {
  /** Lower-case terms that must not appear outside the driver plugins. */
  terms: string[];
  /** Credential environment variable names the drivers read. */
  credentialVars: string[];
}

/**
 * The core names no provider; it learns the provider vocabulary from the driver
 * plugins themselves: SDK packages they import (that the core does not), the
 * names of the driver files that use them, the credential variables they read, and their default model
 * id prefixes. Sources: plugins/drivers/ plus `driverFiles` (harness-relative files the registry
 * loaded as driver plugins, wherever they live).
 */
export function providerVocabulary(harnessRoot: string, driverFiles: string[] = []): ProviderVocabulary {
  const coreText = walk(join(harnessRoot, 'src', 'core'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const corePkgs = importedPackages(coreText);
  const terms = new Set<string>();
  const creds = new Set<string>();
  const sources = new Set([...walk(join(harnessRoot, 'plugins', 'drivers')), ...driverFiles.map((f) => resolve(harnessRoot, f))]);
  for (const file of [...sources].filter((f) => f.endsWith('.ts') && existsSync(f)).sort()) {
    const text = readFileSync(file, 'utf8');
    const sdks = [...importedPackages(text)].filter((p) => !corePkgs.has(p));
    for (const sdk of sdks) {
      const head = (sdk.replace(/^@/, '').split('/')[0] ?? '').split('-')[0] ?? '';
      if (head.length >= 3) terms.add(head.toLowerCase());
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*)_API_KEY\b/g)) {
      creds.add(`${m[1] ?? ''}_API_KEY`);
      const prefix = (m[1] ?? '').toLowerCase();
      if (prefix.length >= 3) terms.add(prefix);
    }
    if (sdks.length > 0) {
      const driverName = basename(file, '.ts').toLowerCase();
      if (driverName.length >= 3) terms.add(driverName);
      for (const m of text.matchAll(/MODEL\w*\s*=\s*['"`]([a-z]{3,})-/g)) {
        if (m[1] !== undefined) terms.add(`${m[1]}-`);
      }
    }
  }
  return { terms: [...terms].sort(), credentialVars: [...creds].sort() };
}

/**
 * Files the provider-leak scan reads: everything under `tasks/` and `src/core/`, and every file
 * under every plugin directory EXCEPT the files the registry loaded as driver plugins and the
 * `drivers/` folder directly under a plugin directory. A file dropped anywhere else in a plugin
 * directory (a new folder, `lib/`, a stray note) is scanned.
 */
export function leakScanFiles(
  harnessRoot: string,
  opts: { pluginDirs?: string[]; driverFiles?: Iterable<string> } = {},
): string[] {
  const drivers = new Set([...(opts.driverFiles ?? [])].map((f) => toPosix(f)));
  const files: string[] = [];
  for (const d of LEAK_SCAN_FIXED) files.push(...walk(join(harnessRoot, d)));
  for (const d of opts.pluginDirs ?? ['plugins']) {
    const dir = resolve(harnessRoot, d);
    const driversDir = join(dir, DRIVERS_DIR);
    for (const file of walk(dir)) {
      if (file === driversDir || file.startsWith(driversDir + sep)) continue;
      if (drivers.has(toPosix(relative(harnessRoot, file)))) continue;
      files.push(file);
    }
  }
  return [...new Set(files)];
}

export function scanForLeaks(
  harnessRoot: string,
  terms: string[],
  opts: { pluginDirs?: string[]; driverFiles?: Iterable<string> } = {},
): string[] {
  if (terms.length === 0) return [];
  const hits: string[] = [];
  for (const file of leakScanFiles(harnessRoot, opts).sort()) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((line, i) => {
      const lower = line.toLowerCase();
      const term = terms.find((t) => lower.includes(t));
      if (term !== undefined) hits.push(`${toPosix(relative(harnessRoot, file))}:${i + 1}: [${term}] ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

async function toolVersion(cmd: string): Promise<string | null> {
  try {
    const r = await exec(cmd, ['--version'], { cwd: HARNESS_ROOT, timeoutMs: 10_000 });
    return r.code === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Isolation line + self-test: a confined node child must fail to write outside its writable dir, to
 * open an outbound socket, to read a canary file outside its read allow-list, and to see an env canary
 * (SANDBOX_CANARY_DATABASE_URL) planted in its caller's env. False (doctor fails) iff isolation is
 * unavailable in auto mode or any of those succeeded.
 */
export async function doctorIsolation(out: Out): Promise<boolean> {
  const mode = sandboxMode();
  if (mode === 'off') {
    out('isolation warn  sandbox off (HARNESS_SANDBOX / harness.config.json): agent code runs unconfined, recorded as UNPROVEN');
    return true;
  }
  const mechanism = detectMechanism();
  if (mechanism === 'none') {
    out(`isolation FAIL  no working sandbox on ${process.platform} (need sandbox-exec on macOS or bwrap on Linux); runs are refused. HARNESS_SANDBOX=off runs unconfined (UNPROVEN)`);
    return false;
  }
  const scratch = join(HARNESS_ROOT, '.harness', 'tmp', `doctor-isolation-${process.pid}-${Date.now()}`);
  try {
    const r = await isolationSelfTest(exec, scratch);
    out(`isolation ${r.ok ? 'ok  ' : 'FAIL'}  ${mechanism} (${POLICY_SUMMARY}); self-test: ${r.detail}`);
    return r.ok;
  } catch (e) {
    out(`isolation FAIL  ${mechanism}: self-test crashed: ${errMsg(e)}`);
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function cmdDoctor(out: Out): Promise<number> {
  let ok = true;
  const major = Number(process.versions.node.split('.')[0]);
  const nodeOk = major >= 22;
  ok &&= nodeOk;
  out(`node      ${nodeOk ? 'ok  ' : 'FAIL'}  ${process.version}${nodeOk ? '' : ' (need >= 22)'}`);

  let pluginDirs: string[] = ['plugins'];
  let driverFiles: string[] = [];
  try {
    const { config, registry } = await loadAll();
    pluginDirs = config.pluginDirs;
    driverFiles = registry.drivers.map((r) => r.file);
    const counts = `${registry.drivers.length} drivers, ${registry.tools.length} tools, ${registry.hooks.length} hooks, ${registry.gates.length} gates, ${registry.checks.length} checks`;
    out(`plugins   ${registry.errors.length === 0 ? 'ok  ' : 'FAIL'}  ${counts}`);
    for (const e of registry.errors) out(`    ${e.file}: ${e.error}`);
    if (registry.errors.length > 0) ok = false;
  } catch (e) {
    ok = false;
    out(`plugins   FAIL  ${errMsg(e)}`);
  }

  const vocab = providerVocabulary(HARNESS_ROOT, driverFiles);
  const hits = scanForLeaks(HARNESS_ROOT, vocab.terms, { pluginDirs, driverFiles });
  if (vocab.terms.length === 0) out('leaks     ??    no provider drivers found; nothing to scan for');
  else out(`leaks     ${hits.length === 0 ? 'ok  ' : 'FAIL'}  ${hits.length} hit(s) for [${vocab.terms.join(', ')}] outside driver plugins (scanned tasks/, src/core/ and every file under ${pluginDirs.join(', ')})`);
  for (const h of hits.slice(0, 50)) out(`    ${h}`);
  if (hits.length > 50) out(`    … ${hits.length - 50} more`);
  if (hits.length > 0) ok = false;

  for (const v of vocab.credentialVars) {
    const set = typeof process.env[v] === 'string' && (process.env[v] ?? '').length > 0;
    out(`env       ${set ? 'set ' : 'unset'} ${v}`);
  }

  const git = await toolVersion('git');
  if (git === null) ok = false;
  out(`git       ${git === null ? 'FAIL  not found' : `ok    ${git}`}`);
  const gh = await toolVersion('gh');
  out(`gh        ${gh === null ? 'warn  not found (ship will commit but cannot open a PR)' : `ok    ${gh}`}`);
  if (!(await doctorIsolation(out))) ok = false;
  out(ok ? 'doctor: ok' : 'doctor: problems found');
  return ok ? 0 : 1;
}

// ───────────────────────────── entry ─────────────────────────────

export async function main(argv: string[], out: Out = (l) => console.log(l)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const parsed = parseArgs(rest);
  if ('error' in parsed) {
    out(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.bools.has('help')) {
    out(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case 'run':
        return await cmdRun(parsed, out);
      case 'check':
        return await cmdCheck(parsed, out);
      case 'plugins':
        return await cmdPlugins(out);
      case 'tokens':
        return await cmdTokens(parsed, out);
      case 'agnostic':
        return await cmdAgnostic(parsed, out);
      case 'ship':
        return await cmdShip(parsed, out);
      case 'testmap':
        return await cmdTestmap(parsed, out);
      case 'task':
        return await cmdTask(parsed, out);
      case 'doctor':
        return await cmdDoctor(out);
      default:
        out(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    out(`error: ${errMsg(e)}`);
    return 1;
  }
}
