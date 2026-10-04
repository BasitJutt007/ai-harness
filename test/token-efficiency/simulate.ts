/**
 * Long-run token simulation through the REAL loop, context views, prompts, front-load
 * and tool plugins. Only the model (a fixed 40-turn transcript) and the slow services
 * (test runner, standards checks) are synthetic, with sizes taken from real runs.
 *
 * The API root is a copy of templates/express-zod (what a greenfield run starts from);
 * writes use the reference users-api sources from fixtures/scripted/users-api.
 * Token counts use the scripted driver's counter (js-tiktoken o200k_base).
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { countRequest } from '../../plugins/lib/tokenize.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { runAgent, type AgentStore } from '../../src/core/loop.ts';
import { withoutFetchers } from '../../src/core/context.ts';
import { compactTree, scaffoldApiOf, systemPrompt, taskBrief } from '../../src/core/prompt.ts';
import { loadRegistry, toolSpecs } from '../../src/core/registry.ts';
import { baselineSystemRenderer } from '../../src/core/run.ts';
import { shippedOnly } from './shipped.ts';
import { loadTask } from '../../src/core/task.ts';
import { TokenLedger, type TokenReport, type TurnTokens } from '../../src/core/tokens.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type {
  CheckReport,
  ContextMode,
  Driver,
  GatePlugin,
  ModelRequest,
  ModelResponse,
  Part,
  RunContext,
  RunState,
  TestObservation,
  TestRunReport,
  Workspace,
} from '../../src/core/types.ts';

const FIXTURE = join(HARNESS_ROOT, 'fixtures', 'scripted', 'users-api');
const fixture = (rel: string): string => readFileSync(join(FIXTURE, rel), 'utf8');

// ───────────────────────────── synthetic services (sizes from real runs) ─────────────────────────────

const FAIL_REASONS = [
  'expected 404 to be 201 // Object.is equality',
  "expected undefined to be '/v1/users/…' // Object.is equality",
  'expected 404 to be 409 // Object.is equality',
  'expected 404 to be 422 // Object.is equality',
  'expected 404 to be 200 // Object.is equality',
  'expected 404 to be 204 // Object.is equality',
];
const CASES = [
  'POST /v1/users > creates a user: 201, Location header, role defaults to member',
  'POST /v1/users > rejects a duplicate email with 409 problem+json',
  'POST /v1/users > rejects an invalid body with 422 naming each field',
  'POST /v1/users > replays the response for a repeated Idempotency-Key',
  'GET /v1/users > paginates with limit and cursor, visiting every user once',
  'GET /v1/users/{userId} > returns 404 problem+json for an unknown id',
  'PATCH /v1/users/{userId} > updates only the given fields',
  'PATCH /v1/users/{userId} > rejects an empty patch with 422',
  'DELETE /v1/users/{userId} > returns 204 and the user is gone',
];

function testSummary(file: string, failed: number, total: number, files: number): string {
  const lines = [`tests: ${failed} failed, ${total - failed} passed (${total}) in ${files} files`];
  for (let i = 0; i < failed; i += 1) {
    lines.push(`FAIL ${file} > ${CASES[i % CASES.length] ?? ''}: ${FAIL_REASONS[i % FAIL_REASONS.length] ?? ''}`);
  }
  return lines.join('\n');
}

/** Outcome per run_tests call, in call order: [failed, total]. */
const TEST_RUNS: Array<[number, number]> = [[23, 27], [6, 27], [2, 27], [0, 54], [0, 54], [4, 9], [0, 63], [0, 63], [0, 63]];

const STANDARDS_PASS = [
  'problem-json      pass    29/29 error paths',
  'rest-conventions  pass     5/5 routes',
  'tsc-strict        pass     0 errors',
  'zod-boundary      pass     5/5 handlers',
  'verdict           100%    → all rules green',
].join('\n');
const STANDARDS_FAIL_COMPACT = [
  'zod-boundary      FAIL  src/routes/users.ts              3/5 handlers',
  '  src/routes/users.ts:18 GET /v1/users responds with an unparsed body (wrap it in Schema.parse)',
  '  src/routes/users.ts:44 DELETE /v1/users/:userId reads req.params without a Zod schema',
  'problem-json      FAIL  (runtime)                        28/29 error paths',
  '  POST /v1/users with a malformed JSON body returned text/html 400, expected application/problem+json',
  '────────────────────────────────────────────────────────────',
  'problem-json      fail    28/29 error paths',
  'rest-conventions  pass     5/5 routes',
  'tsc-strict        pass     0 errors',
  'zod-boundary      fail     3/5 handlers',
  'verdict           93%     → 2 rules failing',
].join('\n');

function fullStandards(compact: string): string {
  const files = ['src/app.ts', 'src/lib/errors.ts', 'src/lib/idempotency.ts', 'src/lib/pagination.ts', 'src/lib/problem.ts', 'src/routes/index.ts', 'src/routes/users.ts', 'src/schemas/user.ts', 'src/server.ts', 'src/store/users.ts'];
  const lines: string[] = [];
  for (const rule of ['problem-json', 'zod-boundary']) for (const f of files) lines.push(`${rule.padEnd(18)}pass  ${f.padEnd(33)}1/1 checked`);
  lines.push('rest-conventions  pass  src/routes/users.ts              5/5 routes', 'tsc-strict        pass  (project)                        0 errors');
  return `${lines.join('\n')}\n${compact}`;
}

const STANDARDS_RUNS = [STANDARDS_FAIL_COMPACT, STANDARDS_PASS, STANDARDS_PASS];

/**
 * The runner's console output for a test run (one line per test, then one block per failure
 * with diff and code frame, then totals): TestRunReport.console, which run_tests hands to the
 * shadow baseline as its raw return (what a naive harness would replay).
 */
function consoleOutput(file: string, failed: number, total: number): string {
  const out = [` RUN  v5 /api`, ''];
  for (let i = 0; i < total; i += 1) {
    out.push(` ${i < failed ? '×' : '✓'} ${file} > ${CASES[i % CASES.length] ?? ''} ${12 + (i % 7)}ms`);
  }
  for (let i = 0; i < failed; i += 1) {
    out.push(
      '',
      ` FAIL  ${file} > ${CASES[i % CASES.length] ?? ''}`,
      `AssertionError: ${FAIL_REASONS[i % FAIL_REASONS.length] ?? ''}`,
      '',
      '- Expected',
      '+ Received',
      '',
      '- 201',
      '+ 404',
      '',
      ` ❯ ${file}:${40 + i * 7}:24`,
      `     ${38 + i * 7}|       .send({ email: 'a${i}@example.com', name: 'Ann' });`,
      `     ${39 + i * 7}|`,
      `     ${40 + i * 7}|     expect(res.status).toBe(201);`,
      '       |                        ^',
      `     ${41 + i * 7}|     expect(res.headers.location).toMatch(/^\\/v1\\/users\\//);`,
      '',
      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[${i + 1}/${failed}]⎯`,
    );
  }
  out.push('', ` Test Files  ${failed > 0 ? '1 failed' : '1 passed'} (1)`, `      Tests  ${failed} failed | ${total - failed} passed (${total})`, '   Duration  1.42s');
  return out.join('\n');
}

function services(state: RunState): RunContext['services'] {
  let testRun = 0;
  let checkRun = 0;
  const svc: RunContext['services'] = {
    async runTestsReverted(): Promise<TestRunReport> {
      throw new Error('not simulated');
    },
    async runTests(files?: string[]): Promise<TestRunReport> {
      const [failed, total] = TEST_RUNS[testRun] ?? [0, 63];
      testRun += 1;
      const list = files ?? ['test/users.test.ts', 'test/lib/problem.test.ts', 'test/lib/errors.test.ts'];
      const observations: TestObservation[] = list.map((file, i) => ({
        file,
        hash: 'h',
        status: failed > 0 && i === 0 ? 'fail' : 'pass',
        collected: total,
        failed: i === 0 ? failed : 0,
        validRed: failed > 0 && i === 0,
        reason: 'sim',
        turn: state.turn,
        at: new Date(0).toISOString(),
      }));
      return {
        ok: failed === 0,
        totals: { files: list.length, tests: total, passed: total - failed, failed },
        observations,
        summary: testSummary(list[0] ?? 'test/users.test.ts', failed, total, list.length),
        logPath: 'runs/sim/logs/vitest.txt',
        console: consoleOutput(list[0] ?? 'test/users.test.ts', failed, total),
      };
    },
    async runChecks(): Promise<CheckReport> {
      const compact = STANDARDS_RUNS[checkRun] ?? STANDARDS_PASS;
      checkRun += 1;
      const pass = compact === STANDARDS_PASS;
      return {
        root: '/sim',
        findings: [],
        rules: [],
        verdict: { status: pass ? 'pass' : 'fail', percent: pass ? 100 : 93 },
        text: fullStandards(compact),
        compact,
      };
    },
    async testMap() {
      return { coverage: { 'test/users.test.ts': ['src/routes/users.ts'] }, testsFor: () => ['test/users.test.ts'] };
    },
  };
  return svc;
}

// ───────────────────────────── the 40-turn transcript ─────────────────────────────

type Call = { name: string; input: Record<string, unknown> };
type Step = { text: string; calls: (ws: Workspace) => Promise<Call[]> };

const fixed = (text: string, ...calls: Call[]): Step => ({ text, calls: async () => calls });

/** edit_file over `lines` consecutive lines starting at line `at` (a realistic block edit). */
function blockEdit(text: string, path: string, at: number, lines: number, tweak: (s: string) => string): Step {
  return {
    text,
    calls: async (ws) => {
      const content = (await ws.read(path)) ?? '';
      const all = content.split('\n');
      let n = lines;
      let find = all.slice(at - 1, at - 1 + n).join('\n');
      while (content.split(find).length !== 2 && at - 1 + n < all.length) {
        n += 1;
        find = all.slice(at - 1, at - 1 + n).join('\n');
      }
      return [{ name: 'edit_file', input: { path, find, replace: tweak(find) } }];
    },
  };
}

const note = (s: string): string => `${s}\n// reviewed: keep handlers thin; validation lives in the schemas`;

export const STEPS: Step[] = [
  fixed('I will plan the work, then look at the scaffold before writing the tests.',
    { name: 'plan', input: { steps: ['Read the scaffold helpers', 'Write test/users.test.ts covering every behaviour', 'Run it red', 'Implement schemas, store and routes', 'Run green', 'check_standards', 'finish'] } },
    { name: 'list_files', input: {} }),
  fixed('Read the app factory and the route registry.', { name: 'read_file', input: { path: 'src/app.ts' } }, { name: 'read_file', input: { path: 'src/routes/index.ts' } }),
  fixed('Now the problem helpers.', { name: 'read_file', input: { path: 'src/lib/problem.ts' } }),
  fixed('Pagination helpers for the list endpoint.', { name: 'read_file', input: { path: 'src/lib/pagination.ts' } }),
  fixed('Idempotency middleware for POST/PATCH.', { name: 'read_file', input: { path: 'src/lib/idempotency.ts' } }),
  fixed('Error middleware and an existing test for the conventions.', { name: 'outline', input: { path: 'src/lib/errors.ts' } }, { name: 'read_file', input: { path: 'test/lib/problem.test.ts' } }),
  fixed('Where are routers registered?', { name: 'search_code', input: { pattern: 'registerRoutes' } }),
  fixed('Check the REST conventions rule text.', { name: 'fetch_standard', input: { rule: 'rest-conventions' } }),
  fixed('And the zod boundary rule.', { name: 'fetch_standard', input: { rule: 'zod-boundary' } }),
  fixed('Write the behaviour tests first.', { name: 'write_file', input: { path: 'test/users.test.ts', content: fixture('test/users.test.ts') } }),
  fixed('Run them to observe red.', { name: 'run_tests', input: { files: ['test/users.test.ts'] } }),
  fixed('Red observed. Add the schemas.', { name: 'write_file', input: { path: 'src/schemas/user.ts', content: fixture('src/schemas/user.ts') } }),
  fixed('Add the in-memory store.', { name: 'write_file', input: { path: 'src/store/users.ts', content: fixture('src/store/users.ts') } }),
  fixed('Add the routes.', { name: 'write_file', input: { path: 'src/routes/users.ts', content: fixture('src/routes/users.ts') } }),
  fixed('Mount the router.', { name: 'write_file', input: { path: 'src/routes/index.ts', content: fixture('src/routes/index.ts') } }),
  fixed('Run the tests.', { name: 'run_tests', input: { files: ['test/users.test.ts'] } }),
  fixed('Some cases still fail; look at the routes again.', { name: 'read_file', input: { path: 'src/routes/users.ts' } }),
  blockEdit('Fix the create handler.', 'src/routes/users.ts', 21, 5, note),
  fixed('Re-run.', { name: 'run_tests', input: { files: ['test/users.test.ts'] } }),
  fixed('Check the failing pagination assertions in the test.', { name: 'read_file', input: { path: 'test/users.test.ts', startLine: 120, endLine: 200 } }),
  blockEdit('The test used the wrong cursor field; fix it.', 'test/users.test.ts', 130, 8, (s) => `${s}\n`),
  fixed('Run everything.', { name: 'run_tests', input: {} }),
  fixed('Green. Check the standards.', { name: 'check_standards', input: {} }),
  fixed('Read the problem-json rule for the malformed body case.', { name: 'fetch_standard', input: { rule: 'problem-json' } }),
  fixed('Look at the list and delete handlers.', { name: 'read_file', input: { path: 'src/routes/users.ts', startLine: 14, endLine: 50 } }),
  blockEdit('Parse the list body through the page schema.', 'src/routes/users.ts', 16, 4, note),
  blockEdit('Parse the delete params.', 'src/routes/users.ts', 40, 6, note),
  fixed('Re-check the standards.', { name: 'check_standards', input: {} }),
  fixed('Run the full suite.', { name: 'run_tests', input: {} }),
  fixed('Review the store before adding pagination edge-case tests.', { name: 'read_file', input: { path: 'src/store/users.ts' } }),
  fixed('Add a dedicated pagination test.', {
    name: 'write_file',
    input: { path: 'test/users-pagination.test.ts', content: fixture('test/users.test.ts').split('\n').slice(0, 90).join('\n') },
  }),
  fixed('Run it.', { name: 'run_tests', input: { files: ['test/users-pagination.test.ts'] } }),
  blockEdit('Make the cursor stable across deletes.', 'src/store/users.ts', 20, 9, note),
  fixed('Run it again.', { name: 'run_tests', input: {} }),
  fixed('Where is Idempotency-Key handled?', { name: 'search_code', input: { pattern: 'Idempotency-Key', glob: '**/*.ts' } }),
  fixed('Check the replay header logic.', { name: 'read_file', input: { path: 'src/lib/idempotency.ts', startLine: 1, endLine: 60 } }),
  blockEdit('Document the replay behaviour at the route.', 'src/routes/users.ts', 1, 3, note),
  fixed('Final full run.', { name: 'run_tests', input: {} }),
  fixed('Final standards check.', { name: 'check_standards', input: {} }),
  fixed('All green; finish.', { name: 'finish', input: { summary: 'Users API with list/get/create/update/delete, tests red then green, standards 100%.' } }),
];

// ───────────────────────────── running it ─────────────────────────────

export interface SimResult {
  report: TokenReport;
  /** Every request actually sent to the model, in turn order. */
  requests: ModelRequest[];
  rows: TurnTokens[];
  status: string;
  turns: number;
}

class RecordingLedger extends TokenLedger {
  readonly captured: TurnTokens[] = [];
  override record(t: TurnTokens): void {
    this.captured.push(t);
    super.record(t);
  }
}

function simDriver(ws: Workspace, seen: ModelRequest[]): Driver {
  let n = 0;
  return {
    name: 'sim',
    model: 'sim:40-turn',
    tokenCounter: 'js-tiktoken o200k_base',
    async complete(req: ModelRequest): Promise<ModelResponse> {
      seen.push(req);
      const step = STEPS[n];
      n += 1;
      const parts: Part[] = [];
      if (step !== undefined) {
        parts.push({ type: 'text', text: step.text });
        (await step.calls(ws)).forEach((c, i) => parts.push({ type: 'tool_call', id: `call_${n}_${i}`, name: c.name, input: c.input }));
      }
      return { parts, stop: parts.length > 1 ? 'tool_calls' : 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, model: 'sim:40-turn' };
    },
    async countTokens(req: ModelRequest): Promise<number> {
      return countRequest(req);
    },
  };
}

const passGate: GatePlugin = {
  kind: 'gate',
  name: 'sim-pass',
  description: 'always passes (simulation)',
  phases: ['finish'],
  run: async () => ({ status: 'pass', summary: 'simulated' }),
};

export interface SimOptions {
  keepRecentTurns?: number;
  mode?: ContextMode;
  /** false: leave the scaffold API out of the brief (to measure what it costs); default true, as run.ts does. */
  scaffoldApi?: boolean;
}

export async function simulate(opts: SimOptions = {}): Promise<SimResult> {
  const config0 = loadConfig(HARNESS_ROOT);
  const config = opts.keepRecentTurns === undefined ? config0 : { ...config0, history: { keepRecentTurns: opts.keepRecentTurns } };
  // the shipped tools and checks only: plugins dropped in later must not move the measurement
  const registry = shippedOnly(await loadRegistry(config0, HARNESS_ROOT));
  const loaded = await loadTask(join(HARNESS_ROOT, 'tasks', 'users-api.task.yaml'));
  const task = loaded.task;

  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `token-efficiency-${randomUUID().slice(0, 8)}`);
  const root = join(dir, 'api');
  mkdirSync(root, { recursive: true });
  cpSync(join(HARNESS_ROOT, 'templates', 'express-zod'), root, {
    recursive: true,
    filter: (p) => !p.split(/[\\/]/).some((s) => s === 'node_modules' || s === 'dist'),
  });
  try {
    const ws = createWorkspace(dir, 'api');
    const state: RunState = {
      turn: 0, tests: [], written: new Set(), initialHashes: new Map(), plan: [], events: [], scratch: new Map(), finishAttempts: 0,
    };
    const mode: ContextMode = opts.mode ?? { jit: true, compactReturns: true, compactHistory: true };
    const view = { ...registry, hooks: [], gates: [{ plugin: passGate, file: 'sim', sha256: '0' }] };
    const ctx: RunContext = {
      run: { id: 'sim', driver: 'sim', model: 'sim', startedAt: new Date(0).toISOString(), harnessRoot: HARNESS_ROOT, runDir: join(dir, 'run'), branch: 'harness/sim', baseBranch: 'sim', baseSha: 'HEAD' },
      task,
      workspace: ws,
      state,
      logs: { write: async (name) => `runs/sim/logs/${name}.txt` },
      mode,
      config,
      exec: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
      services: services(state),
      registry: view,
      emit: () => undefined,
    };
    const tools = toolSpecs(registry.tools, task.kind);
    const checks = registry.checks.map((r) => r.plugin);
    const system = systemPrompt({ task, checks, tools });
    // Exactly what run.ts builds: the --baseline prompt + the CURRENT tree + the standards, re-rendered every turn.
    const baselineSystem = baselineSystemRenderer({ task, checks, tools: withoutFetchers(tools, registry.tools.map((r) => r.plugin)), ws });
    // The same brief run.ts sends for a greenfield task: tree plus the scaffold's exported signatures.
    const tree = compactTree(await ws.list(['**/*']));
    const brief = taskBrief(task, opts.scaffoldApi === false ? { tree } : { tree, scaffoldApi: await scaffoldApiOf(ws) });
    const first = { role: 'user' as const, parts: [{ type: 'text' as const, text: brief }] };
    const ledger = new RecordingLedger({ runId: 'sim', task: task.id, driver: 'sim', model: 'sim', counter: 'js-tiktoken o200k_base', mode: 'jit' });
    const store: AgentStore = { logs: ctx.logs, appendTranscript: () => undefined, writeJson: () => undefined };
    const requests: ModelRequest[] = [];
    const res = await runAgent({
      driver: simDriver(ws, requests), ctx, store, ledger, first, system, baselineSystem, tools,
      maxTurns: STEPS.length, maxOutputTokens: 16000, retryDelaysMs: [],
    });
    return { report: ledger.report(), requests, rows: ledger.captured, status: res.status, turns: res.turns };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
