/**
 * Fake RunContext for plugin tests: a real temp workspace on disk (inside the repo,
 * under .harness/tmp), in-memory state and stub services.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import type {
  BrownfieldTask,
  CheckReport,
  CoreServices,
  Exec,
  GreenfieldTask,
  HarnessConfig,
  RegistryView,
  RunContext,
  RunState,
  Task,
  TestMap,
  TestObservation,
  TestRunReport,
  ToolCallInfo,
  ToolPlugin,
  ToolResult,
  Workspace,
} from '../../src/core/plugin-api.ts';

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function makeTmp(label: string): Promise<string> {
  const dir = path.join(HARNESS_ROOT, '.harness', 'tmp', `plugins-${label}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function nearestExisting(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

export function fakeWorkspace(repoRoot: string, rootRel: string): Workspace {
  const root = rootRel === '' ? repoRoot : path.join(repoRoot, rootRel);
  const realRoot = (): string => (existsSync(root) ? realpathSync(root) : root);
  const inside = (abs: string, base: string): boolean => abs === base || abs.startsWith(base + path.sep);
  const resolve = (rel: string): string => {
    const abs = path.resolve(root, rel);
    if (!inside(abs, root)) throw new Error(`path escapes API root: ${rel}`);
    const real = realpathSync(nearestExisting(abs));
    if (!inside(real, realRoot())) throw new Error(`path escapes API root via symlink: ${rel}`);
    return abs;
  };
  return {
    repoRoot,
    root,
    rootRel,
    resolve,
    rel(p: string): string {
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      if (!inside(abs, root)) throw new Error(`path escapes API root: ${p}`);
      return path.relative(root, abs).split(path.sep).join('/');
    },
    async read(rel: string): Promise<string | null> {
      try {
        return await readFile(resolve(rel), 'utf8');
      } catch {
        return null;
      }
    },
    async write(rel: string, content: string): Promise<void> {
      const abs = resolve(rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    },
    async exists(rel: string): Promise<boolean> {
      return existsSync(resolve(rel));
    },
    async list(patterns: string[]): Promise<string[]> {
      if (!existsSync(root)) return [];
      return glob(patterns, { cwd: root, dot: true, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'] });
    },
  };
}

export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolveP) => {
    const started = Date.now();
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolveP({ code, stdout: String(stdout), stderr: String(stderr), durationMs: Date.now() - started, timedOut: false });
    });
  });

export function greenfieldTask(): GreenfieldTask {
  return {
    kind: 'greenfield',
    id: 'items-api',
    title: 'Items API',
    behaviours: [],
    limits: { maxTurns: 10, maxOutputTokens: 1000 },
    output: 'api',
    template: 'express-zod',
    basePath: '/v1',
    resources: [],
  };
}

export function brownfieldTask(scope?: { allow: string[]; deny: string[] }): BrownfieldTask {
  return {
    kind: 'brownfield',
    id: 'items-change',
    title: 'Items change',
    behaviours: [],
    limits: { maxTurns: 10, maxOutputTokens: 1000 },
    target: 'api',
    change: 'add a field',
    scope: scope ?? { allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] },
    allowBreaking: false,
  };
}

export const testConfig: HarnessConfig = {
  pluginDirs: ['plugins'],
  disabled: [],
  protectedBranches: ['main'],
  worktreeDir: '.harness/worktrees',
  runsDir: 'runs',
  tokensDir: 'tokens',
  templatesDir: 'templates',
  history: { keepRecentTurns: 2 },
  limits: { maxReadLines: 5, maxListEntries: 3, maxSearchHits: 2 },
  sandbox: 'auto',
};

export function emptyRegistry(): RegistryView {
  return { drivers: [], tools: [], hooks: [], gates: [], checks: [], errors: [] };
}

export function newState(): RunState {
  return {
    turn: 1,
    tests: [],
    written: new Set(),
    initialHashes: new Map(),
    plan: [],
    events: [],
    scratch: new Map(),
    finishAttempts: 0,
  };
}

/** Import graph over test/ files: direct relative imports, `.js` → `.ts`. */
export async function simpleTestMap(ws: Workspace): Promise<TestMap> {
  const coverage: Record<string, string[]> = {};
  for (const t of await ws.list(['test/**/*.ts'])) {
    const content = (await ws.read(t)) ?? '';
    const srcs: string[] = [];
    for (const m of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = (m[1] ?? '').replace(/\.js$/, '.ts');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(t), spec.endsWith('.ts') ? spec : `${spec}.ts`));
      if (target.startsWith('src/')) srcs.push(target);
    }
    coverage[t] = srcs;
  }
  return { coverage, testsFor: (src) => Object.keys(coverage).filter((t) => (coverage[t] ?? []).includes(src)) };
}

export interface FakeHarness {
  ctx: RunContext;
  ws: Workspace;
  dir: string;
  /** Outcome the fake runner reports per test file (default 'pass'). */
  outcomes: Map<string, 'pass' | 'fail' | 'error'>;
  services: CoreServices;
}

export async function makeHarness(opts: {
  label: string;
  task?: Task;
  rootRel?: string;
  files?: Record<string, string>;
  services?: Partial<CoreServices>;
  registry?: RegistryView;
  exec?: Exec;
}): Promise<FakeHarness> {
  const dir = await makeTmp(opts.label);
  const rootRel = opts.rootRel ?? 'api';
  const ws = fakeWorkspace(dir, rootRel);
  await mkdir(ws.root, { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) await ws.write(rel, content);
  const state = newState();
  const outcomes = new Map<string, 'pass' | 'fail' | 'error'>();

  const runTests = async (files?: string[]): Promise<TestRunReport> => {
    const targets = files ?? (await ws.list(['test/**/*.test.ts'])).sort();
    const observations: TestObservation[] = [];
    for (const file of targets) {
      const content = (await ws.read(file)) ?? '';
      const status = outcomes.get(file) ?? 'pass';
      const obs: TestObservation = {
        file,
        hash: sha(content),
        status,
        collected: status === 'error' ? 0 : 1,
        failed: status === 'fail' ? 1 : 0,
        validRed: status === 'fail',
        reason: status,
        turn: state.turn,
        at: new Date().toISOString(),
      };
      observations.push(obs);
      state.tests.push(obs);
    }
    const failed = observations.filter((o) => o.status === 'fail').length;
    const tests = observations.reduce((n, o) => n + o.collected, 0);
    return {
      ok: failed === 0 && tests > 0 && observations.every((o) => o.status !== 'error'),
      totals: { files: observations.length, tests, passed: tests - failed, failed },
      observations,
      summary: `tests: ${failed} failed, ${tests - failed} passed (${tests}) in ${observations.length} files`,
      logPath: 'runs/x/logs/001-vitest.txt',
    };
  };
  const runChecks = async (): Promise<CheckReport> => ({
    root: ws.root,
    findings: [],
    rules: [],
    verdict: { status: 'pass', percent: 100 },
    text: 'verdict 100%',
    compact: 'verdict 100%',
  });

  const services: CoreServices = {
    runTests,
    runChecks,
    testMap: () => simpleTestMap(ws),
    runTestsReverted: async () => {
      throw new Error('the fake harness has no revert runner');
    },
    ...opts.services,
  };

  const ctx: RunContext = {
    run: {
      id: 'run-1',
      driver: 'scripted',
      model: 'none',
      startedAt: new Date().toISOString(),
      harnessRoot: HARNESS_ROOT,
      runDir: path.join(dir, 'run'),
      branch: 'harness/test',
      baseBranch: 'main',
      baseSha: 'HEAD',
    },
    task: opts.task ?? greenfieldTask(),
    workspace: ws,
    state,
    logs: { write: async (name) => `runs/run-1/logs/${name}.txt` },
    mode: { jit: true, compactReturns: true, compactHistory: true },
    config: testConfig,
    exec: opts.exec ?? realExec,
    services,
    registry: opts.registry ?? emptyRegistry(),
    emit: (e) => {
      state.events.push({ ...e, turn: state.turn, at: new Date().toISOString() });
    },
  };
  return { ctx, ws, dir, outcomes, services };
}

/** Parse input with the tool's schema (as the loop does) and run it. */
export async function callTool<I>(tool: ToolPlugin<I>, input: unknown, ctx: RunContext): Promise<ToolResult> {
  return tool.run(tool.input.parse(input), ctx);
}

export function callInfo<I>(tool: ToolPlugin<I>, input: unknown): ToolCallInfo {
  const parsed = tool.input.parse(input);
  return { id: 'c1', tool: tool.name, effect: tool.effect, input: parsed, paths: tool.paths ? tool.paths(parsed) : [] };
}
