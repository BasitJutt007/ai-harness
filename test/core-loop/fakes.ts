/** In-memory fakes for core-loop unit tests (no other builders' modules needed). */
import { z } from 'zod';
import type {
  Driver,
  GatePlugin,
  HarnessConfig,
  HookPlugin,
  LogStore,
  Message,
  ModelRequest,
  ModelResponse,
  Part,
  PluginRecord,
  RunContext,
  RunEvent,
  RunState,
  Task,
  ToolPlugin,
  ToolSpec,
} from '../../src/core/types.ts';
import { messageChars } from '../../src/core/context.ts';

export const CONFIG: HarnessConfig = {
  pluginDirs: ['plugins'],
  disabled: [],
  protectedBranches: ['main'],
  worktreeDir: '.harness/worktrees',
  runsDir: 'runs',
  tokensDir: 'tokens',
  templatesDir: 'templates',
  history: { keepRecentTurns: 2 },
  limits: { maxReadLines: 160, maxListEntries: 200, maxSearchHits: 40 },
  sandbox: 'auto',
};

export const GREENFIELD: Task = {
  kind: 'greenfield',
  id: 'users-api',
  title: 'Users API',
  output: 'generated/users-api',
  template: 'express-zod',
  basePath: '/v1',
  behaviours: ['Creating a user whose email already exists returns 409.'],
  limits: { maxTurns: 10, maxOutputTokens: 1000 },
  resources: [
    {
      name: 'user',
      plural: 'users',
      operations: ['list', 'get', 'create', 'update', 'delete'],
      fields: [
        { name: 'email', type: 'email', required: true, unique: true, readOnly: false },
        { name: 'name', type: 'string', required: true, unique: false, readOnly: false, min: 1, max: 100 },
        { name: 'role', type: 'enum', required: false, unique: false, readOnly: false, values: ['admin', 'member'], default: 'member' },
      ],
    },
  ],
};

export function rec<P extends PluginRecord['plugin']>(plugin: P, file = 'plugins/x.ts'): PluginRecord<P> {
  return { plugin, file, sha256: '0'.repeat(64) };
}

export function newState(): RunState {
  return {
    turn: 0,
    tests: [],
    written: new Set(),
    initialHashes: new Map(),
    plan: [],
    events: [],
    scratch: new Map(),
    finishAttempts: 0,
  };
}

export interface FakeLogs extends LogStore {
  written: Array<{ name: string; content: string }>;
}

export function fakeLogs(): FakeLogs {
  const written: Array<{ name: string; content: string }> = [];
  return {
    written,
    async write(name, content) {
      written.push({ name, content });
      return `runs/test/logs/${String(written.length).padStart(3, '0')}-${name}.txt`;
    },
  };
}

export function fakeCtx(opts: {
  tools?: ToolPlugin<unknown>[];
  hooks?: HookPlugin[];
  gates?: GatePlugin[];
  task?: Task;
  baseline?: boolean;
} = {}): { ctx: RunContext; events: RunEvent[]; logs: FakeLogs } {
  const state = newState();
  const logs = fakeLogs();
  const events: RunEvent[] = [];
  const ctx: RunContext = {
    run: {
      id: 'run-1',
      driver: 'fake',
      model: 'fake-model',
      startedAt: new Date(0).toISOString(),
      harnessRoot: '/tmp/h',
      runDir: '/tmp/h/runs/run-1',
      branch: 'harness/run-1',
      baseBranch: 'main',
      baseSha: 'abc',
    },
    task: opts.task ?? GREENFIELD,
    workspace: {
      repoRoot: '/tmp/r',
      root: '/tmp/r/api',
      rootRel: 'api',
      resolve: (p) => `/tmp/r/api/${p}`,
      rel: (p) => p,
      read: async () => null,
      write: async () => undefined,
      exists: async () => false,
      list: async () => [],
    },
    state,
    logs,
    mode: opts.baseline
      ? { jit: false, compactReturns: false, compactHistory: false }
      : { jit: true, compactReturns: true, compactHistory: true },
    config: CONFIG,
    exec: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
    services: {
      runTests: async () => {
        throw new Error('not in unit tests');
      },
      runChecks: async () => {
        throw new Error('not in unit tests');
      },
      testMap: async () => ({ coverage: {}, testsFor: () => [] }),
      runTestsReverted: async () => {
        throw new Error('not in unit tests');
      },
    },
    registry: {
      drivers: [],
      tools: (opts.tools ?? []).map((t) => rec(t)),
      hooks: (opts.hooks ?? []).map((h) => rec(h)),
      gates: (opts.gates ?? []).map((g) => rec(g)),
      checks: [],
      errors: [],
    },
    emit(e) {
      const full: RunEvent = { ...e, turn: state.turn, at: new Date(0).toISOString() };
      events.push(full);
      state.events.push(full);
    },
  };
  return { ctx, events, logs };
}

export function fakeStore(logs: LogStore): {
  logs: LogStore;
  transcript: unknown[];
  json: Map<string, unknown>;
  appendTranscript(e: unknown): void;
  writeJson(n: string, v: unknown): void;
} {
  const transcript: unknown[] = [];
  const json = new Map<string, unknown>();
  return {
    logs,
    transcript,
    json,
    appendTranscript(e) {
      transcript.push(e);
    },
    writeJson(n, v) {
      json.set(n, v);
    },
  };
}

/** A driver that replays canned responses (or throws them) and records requests. */
export class FakeDriver implements Driver {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly tokenCounter = 'chars/4';
  readonly requests: ModelRequest[] = [];
  readonly counted: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly script: Array<ModelResponse | Error | ((req: ModelRequest) => ModelResponse)>) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const step = this.script[this.i];
    this.i += 1;
    if (step === undefined) return reply([{ type: 'text', text: 'nothing left' }], 'end_turn');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(req);
    return step;
  }

  async countTokens(req: ModelRequest): Promise<number> {
    this.counted.push(req);
    return Math.ceil((req.system.length + messageChars(req.messages)) / 4);
  }
}

export function reply(parts: Part[], stop: ModelResponse['stop'] = 'tool_calls'): ModelResponse {
  return { parts, stop, usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 }, model: 'fake-model' };
}

export function call(id: string, name: string, input: unknown): Part {
  return { type: 'tool_call', id, name, input };
}

export function firstMessage(text = 'Task brief'): Message {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

export function specs(tools: ToolPlugin<unknown>[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: {} }));
}

// ── fake tools ──

export function writeTool(onRun?: (input: { path: string; content: string }) => void): ToolPlugin<unknown> {
  const input = z.object({ path: z.string(), content: z.string() });
  const tool: ToolPlugin<{ path: string; content: string }> = {
    kind: 'tool',
    name: 'write_file',
    description: 'write a file',
    input,
    effect: 'write',
    paths: (i) => [i.path],
    async run(i) {
      onRun?.(i);
      return { ok: true, summary: `wrote ${i.path} (new, ${i.content.split('\n').length} lines)`, raw: i.content };
    },
  };
  return tool as ToolPlugin<unknown>;
}

export const TEST_SUMMARY = `tests: 3 passed (3) in 1 file\n${'PASS test/a.test.ts > case\n'.repeat(6)}`;

export function bigTool(rawSize = 5000): ToolPlugin<unknown> {
  const tool: ToolPlugin<Record<string, never>> = {
    kind: 'tool',
    name: 'run_tests',
    description: 'run tests',
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    effect: 'exec',
    async run() {
      return { ok: true, summary: TEST_SUMMARY, raw: 'R'.repeat(rawSize) };
    },
  };
  return tool as ToolPlugin<unknown>;
}

export function finishTool(): ToolPlugin<unknown> {
  const tool: ToolPlugin<{ summary: string }> = {
    kind: 'tool',
    name: 'finish',
    description: 'request finish',
    input: z.object({ summary: z.string() }),
    effect: 'control',
    async run(i) {
      return { ok: true, summary: 'finish requested', finish: { summary: i.summary } };
    },
  };
  return tool as ToolPlugin<unknown>;
}
