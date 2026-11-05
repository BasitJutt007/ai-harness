/**
 * Session test support: a throwaway web repository (its own git repo, a temp state home), a driver that
 * replays scripted responses (and can stream, wait for an abort, or fire a Ctrl-C), the real registry
 * (optionally with stand-in gates), and a runner that captures everything the owner would see.
 * Nothing here touches the owner's ~/.sf-harness or the harness repository's git.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { ScriptedInput, type ScriptStep } from '../../src/session/input.ts';
import { runSession, type SessionDeps, type SessionResult } from '../../src/session/session.ts';
import type { Driver, Exec, GatePlugin, GateStatus, HarnessConfig, ModelRequest, ModelResponse, Part, PluginRecord, RegistryView, TestBaseline } from '../../src/core/types.ts';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface WebRepo {
  base: string;
  repo: string;
  /** SF_HARNESS_HOME of the test. */
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export const PACKAGE_JSON = JSON.stringify(
  { name: 'tiny-web', private: true, type: 'module', scripts: { test: 'vitest run' }, dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0', vitest: '^4.0.0', typescript: '^5.0.0' } },
  null,
  2,
);

/**
 * A committed web repo (react + vite, vitest) on `branch` (default fix/greeting, cut from main; a
 * development branch exists for the contract's Base). `extra` adds files to the first commit.
 */
export function webRepo(opts: { branch?: string; extra?: Record<string, string>; under?: string } = {}): WebRepo {
  const base = realpathSync(mkdtempSync(join(opts.under ?? tmpdir(), 'session-')));
  const repo = join(base, 'tiny-web');
  const home = join(base, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const files: Record<string, string> = {
    'package.json': `${PACKAGE_JSON}\n`,
    'src/greeting.ts': "export function greeting(name: string): string {\n  return `Hello, ${name}`;\n}\n",
    'test/greeting.test.ts': "import { expect, test } from 'vitest';\nimport { greeting } from '../src/greeting.ts';\n\ntest('greets', () => {\n  expect(greeting('Ada')).toBe('Hello, Ada');\n});\n",
    'README.md': '# tiny-web\n',
    ...opts.extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'branch', 'development');
  const branch = opts.branch ?? 'fix/greeting';
  if (branch !== 'main') git(repo, 'switch', '-q', '-c', branch);
  return { base, repo, home, env: { ...process.env, SF_HARNESS_HOME: home, NO_COLOR: '1' }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reported: false } as const;

export function text(t: string): ModelResponse {
  return { parts: [{ type: 'text', text: t }], stop: 'end_turn', usage, model: 'scripted:session-test' };
}

let callSeq = 0;
export function calls(...cs: Array<[string, Record<string, unknown>]>): ModelResponse {
  const parts: Part[] = cs.map(([name, input]) => ({ type: 'tool_call', id: `c${(callSeq += 1)}`, name, input }));
  return { parts, stop: 'tool_calls', usage, model: 'scripted:session-test' };
}

export type Step = ModelResponse | ((req: ModelRequest, signal: AbortSignal | undefined) => Promise<ModelResponse>);

/** Replays steps; streams text in small deltas; records every request it was sent. */
export class SessionDriver implements Driver {
  readonly name = 'scripted';
  readonly model = 'scripted:session-test';
  readonly tokenCounter = 'chars/4 (test)';
  readonly requests: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly steps: Step[]) {}

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    this.requests.push(req);
    const s = this.steps[this.i];
    this.i += 1;
    if (s === undefined) return text('(script exhausted)');
    return typeof s === 'function' ? s(req, signal) : s;
  }

  async stream(req: ModelRequest, signal: AbortSignal | undefined, onDelta: (t: string) => void): Promise<ModelResponse> {
    const r = await this.complete(req, signal);
    for (const p of r.parts) if (p.type === 'text') for (let k = 0; k < p.text.length; k += 4) onDelta(p.text.slice(k, k + 4));
    return r;
  }

  async countTokens(req: ModelRequest): Promise<number> {
    return Math.ceil(JSON.stringify(req.messages).length / 4);
  }

  get used(): number {
    return this.i;
  }
}

/** A contract the propose_contract tool would send. */
export function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'greeting-name',
    problem: 'The greeting ignores the visitor name on the home page.',
    owner: 'web team',
    stakeholder: 'Ada Owner',
    metric: { name: 'greeting tests passing', window: 'per test run' },
    scenarios: [{ when: 'a visitor named Ada opens the page', then: 'the page says Hello, Ada' }],
    notIncluded: ['translations'],
    commit: 'fix(greeting): greet visitors by the name they gave',
    ...over,
  };
}

/** A test the agent writes. node:test and node:assert are builtins: the throwaway repo has no node_modules (dependency-policy). */
export const TEST_BODY = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greeting } from '../src/greeting.ts';\n\ntest('greets Ada by name', () => {\n  assert.equal(greeting('Ada'), 'Hello, Ada');\n});\n";

export const BASELINE: TestBaseline = { at: new Date(0).toISOString(), totals: { files: 1, tests: 1, passed: 1, failed: 0 }, skipped: [], failed: [], loadErrors: [] };

let registryCache: RegistryView | null = null;
export async function realRegistry(): Promise<RegistryView> {
  registryCache ??= await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
  return registryCache;
}

/** A stand-in gate (phases finish and ship) with a fixed status. */
export function gate(name: string, status: GateStatus = 'pass'): PluginRecord<GatePlugin> {
  return {
    plugin: { kind: 'gate', name, phases: ['finish', 'ship'], async run() { return { status, summary: `${name} says ${status} (test stand-in)` }; } },
    file: `test/${name}.ts`,
    sha256: '0'.repeat(64),
  };
}

export const REQUIRED_STANDINS = ['stakeholder-yes', 'tests-green', 'observed-red', 'scope', 'orphans', 'standards', 'secrets'];

/** The real tools and hooks, with stand-in gates (all pass unless `statuses` says otherwise) and no checks. */
export async function registryWithGates(statuses: Record<string, GateStatus> = {}): Promise<RegistryView> {
  const real = await realRegistry();
  return { ...real, gates: REQUIRED_STANDINS.map((g) => gate(g, statuses[g] ?? 'pass')), checks: [] };
}

export interface Ran {
  result: SessionResult;
  out: string;
  input: ScriptedInput;
  driver: SessionDriver;
  /** The session's records directory. */
  dir: string;
  runJson: Record<string, unknown>;
}

/** Run a session to its end (the script's last line, then end of input). */
export async function runScripted(
  r: WebRepo,
  steps: Step[],
  lines: ScriptStep[],
  opts: { channel?: 'tty' | 'pipe'; registry?: RegistryView; exec?: Exec; config?: HarnessConfig; input?: ScriptedInput; extra?: Partial<SessionDeps> } = {},
): Promise<Ran> {
  const input = opts.input ?? new ScriptedInput(lines, opts.channel ?? 'tty');
  const driver = new SessionDriver(steps);
  let out = '';
  const result = await runSession({
    cwd: r.repo,
    input,
    output: { write: (t) => void (out += t), isTTY: false },
    env: r.env,
    exec: opts.exec ?? coreExec,
    registry: opts.registry ?? (await realRegistry()),
    driver,
    measureBaseline: async () => BASELINE,
    isolation: { mode: 'auto', mechanism: 'sandbox-exec', policy: 'test' },
    sessionId: `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...opts.extra,
  });
  const dir = result.sessionDir ?? '';
  const runJson = dir !== '' && existsSync(join(dir, 'run.json')) ? (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>) : {};
  return { result, out, input, driver, dir, runJson };
}

/** The ledger entries' types of an item in the session's items root, or [] when there is no ledger. */
export function ledgerTypes(ran: Ran, slug: string): string[] {
  const root = String(ran.runJson['itemsRoot'] ?? '');
  const file = join(root, 'items', slug, 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { event: { type: string } }).event.type);
}

export function transcript(ran: Ran): unknown[] {
  return readFileSync(join(ran.dir, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as unknown);
}
