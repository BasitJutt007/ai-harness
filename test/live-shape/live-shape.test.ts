/**
 * Live readiness of the real provider drivers, without keys or network.
 *
 * The REAL harness run (executeRun: registry, task file, worktree, scaffold, tools, hooks,
 * gates, token ledger, evidence) drives the REAL drivers, which talk through the REAL
 * installed SDK clients; only the SDKs' `fetch` is replaced by an in-process fake that
 * validates every request against the provider's wire rules and answers in the provider's
 * response format (test/live-shape/fake-providers.ts). The fake replays the first turns of
 * fixtures/scripted/users-api.json plus one premature source write that observed-red must
 * block, then stops calling tools, so each run ends `stalled` (wire correctness is the
 * point, not a finished API).
 *
 * Also covered end to end: the one-shot 400 downgrade (compat mode) through the real SDK
 * error classes, with the run continuing after it.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CLIENT_OPTIONS as CLAUDE_OPTIONS, createClaudeDriver } from '../../plugins/drivers/claude.ts';
import { CLIENT_OPTIONS as OPENAI_OPTIONS, createOpenAIDriver } from '../../plugins/drivers/openai.ts';
import { loadScript } from '../../plugins/drivers/scripted.ts';
import { agnosticDiff } from '../../src/core/cli.ts';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import type { DriverPlugin, RunEvent } from '../../src/core/types.ts';
import { collector, execWithoutGh, readEvents, readRunJson, SCRIPTS, tempRepo, TokenFileSchema, USERS_TASK, type TempRepo } from '../e2e/helpers.ts';
import {
  CLAUDE_EXPECTED_BETAS,
  fakeClaude,
  fakeOpenAI,
  type FakeClaude,
  type FakeOpenAI,
  type FakeTurn,
  type WireRequest,
} from './fake-providers.ts';

// ───────────────────────────── trajectory ─────────────────────────────

const script = loadScript(join(SCRIPTS, 'users-api.json'));

function scriptTurn(i: number): { text?: string; calls: FakeTurn['calls'] } {
  const t = script.turns[i];
  if (t === undefined) throw new Error(`users-api.json has no turn ${i}`);
  return t;
}

const PLAN = scriptTurn(0);
const WRITE_TEST = scriptTurn(1);
const RUN_RED = scriptTurn(2);
const MOUNT = scriptTurn(3);
const MOUNT_CALL = MOUNT.calls[0];
if (MOUNT_CALL === undefined) throw new Error('users-api.json turn 4 has no call');

/** 4 tool-using turns, then text-only turns until the loop declares the run stalled. */
const TRAJECTORY: FakeTurn[] = [
  { thinking: 'Start with a plan and look at the scaffold.', ...PLAN },
  {
    thinking: 'Write the behaviour test, and also try mounting the router right away.',
    text: 'Write the test, then mount the router.',
    calls: [...WRITE_TEST.calls, { name: MOUNT_CALL.name, input: MOUNT_CALL.input }],
  },
  { thinking: 'The mount was refused until a red is observed. Run the test.', ...RUN_RED },
  { thinking: 'Red observed; the mount is unlocked now.', ...MOUNT },
  { thinking: 'Pause.', text: 'Pausing here.', calls: [] },
  { thinking: 'Pause.', text: 'Still pausing.', calls: [] },
  { thinking: 'Pause.', text: 'Done for now.', calls: [] },
];
const TOOL_TURNS = 4;
const TOTAL_TURNS = TRAJECTORY.length; // idle turns 5, 6, 7 → stalled at 7

// ───────────────────────────── drivers wired to the fakes ─────────────────────────────

/** The registered driver names, built through the drivers' client seam with the real SDK and a fake fetch. */
function claudeVia(fake: FakeClaude): DriverPlugin {
  return {
    kind: 'driver',
    name: 'claude',
    description: 'claude driver over the real SDK with an in-process fake endpoint',
    create: (opts) => createClaudeDriver({ ...opts, env: { ANTHROPIC_API_KEY: 'test' } }, (apiKey) => new Anthropic({ apiKey, ...CLAUDE_OPTIONS, fetch: fake.fetch })),
  };
}

function openaiVia(fake: FakeOpenAI): DriverPlugin {
  return {
    kind: 'driver',
    name: 'openai',
    description: 'openai driver over the real SDK with an in-process fake endpoint',
    create: (opts) => createOpenAIDriver({ ...opts, env: { OPENAI_API_KEY: 'test' } }, (apiKey) => new OpenAI({ apiKey, ...OPENAI_OPTIONS, fetch: fake.fetch })),
  };
}

let tmp: TempRepo;

async function run(plugin: DriverPlugin, maxTurns: number): Promise<{ summary: RunSummary; text: string }> {
  const out = collector();
  const summary = await executeRun({
    taskFile: USERS_TASK,
    driver: plugin.name,
    driverOptions: {},
    baseline: false,
    ship: false,
    maxTurns,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: out.out,
    extraDrivers: [plugin],
  });
  return { summary, text: out.text() };
}

interface TranscriptRow {
  turn: number;
  stop: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  assistant: Array<{ type: string; id?: string; name?: string; driver?: string }>;
  results: Array<{ type: string; callId?: string; content?: string; isError?: boolean }> | null;
}

function transcript(runDir: string): TranscriptRow[] {
  return readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TranscriptRow);
}

const TokenRows = TokenFileSchema.extend({
  turns: z.array(
    z.looseObject({
      turn: z.number().int(),
      actual_input_tokens: z.number().int().positive(),
      baseline_input_tokens: z.number().int().positive(),
      provider_reported_input_tokens: z.number().int(),
      provider_cached_input_tokens: z.number().int(),
    }),
  ).min(1),
});

function tokenFile(path: string): z.infer<typeof TokenRows> {
  return TokenRows.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function hookBlocks(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => e.kind === 'hook' && e.decision === 'block');
}

function driverErrors(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => e.kind === 'error' && e.source === 'driver');
}

function createRequests(fake: { requests: WireRequest[] }, path: string): WireRequest[] {
  return fake.requests.filter((r) => r.url.pathname === path);
}

/** Shared expectations of a full trajectory run (both drivers). */
function expectHarnessBehaviour(summary: RunSummary, driver: string): void {
  expect(summary.status).toBe('stalled');
  expect(summary.turns).toBe(TOTAL_TURNS);
  expect(summary.driver).toBe(driver);

  const events = readEvents(summary.runDir);
  expect(driverErrors(events)).toEqual([]); // no failed countTokens, no complete() retry
  const blocks = hookBlocks(events);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ source: 'observed-red', turn: 2, data: { tool: 'write_file', paths: ['src/routes/index.ts'] } });

  const rows = transcript(summary.runDir);
  expect(rows.map((r) => r.turn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(rows.map((r) => r.stop)).toEqual(['tool_calls', 'tool_calls', 'tool_calls', 'tool_calls', 'end_turn', 'end_turn', 'end_turn']);
  // turn 1: plan / read_file / outline all ran
  expect(rows[0]?.results?.map((r) => r.isError)).toEqual([false, false, false]);
  // turn 2: the test write passed, the premature source write was blocked by the hook
  expect(rows[1]?.results?.map((r) => r.isError)).toEqual([false, true]);
  expect(rows[1]?.results?.[1]?.content).toMatch(/^BLOCKED by observed-red/);
  // turn 3: the harness ran the test and saw it fail (red observed)
  expect(rows[2]?.results?.[0]?.content ?? '').toMatch(/fail/i);
  // turn 4: the same write is now allowed and landed in the worktree
  expect(rows[3]?.results?.map((r) => r.isError)).toEqual([false]);
  const mounted = readFileSync(join(summary.worktree, 'generated', 'users-api', 'src', 'routes', 'index.ts'), 'utf8');
  expect(mounted).toBe(MOUNT_CALL?.input['content']);
  // every tool call id the provider issued is answered by the harness, in order
  for (const r of rows.slice(0, TOOL_TURNS)) {
    const ids = r.assistant.filter((p) => p.type === 'tool_call').map((p) => p.id);
    expect(r.results?.map((p) => p.callId)).toEqual(ids);
  }

  // token report: one row per turn, actual and baseline both counted, baseline larger
  const tokens = tokenFile(summary.tokensPath);
  expect(summary.tokensPath.startsWith(tmp.tokensDir)).toBe(true);
  expect(tokens.turns.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  for (const t of tokens.turns) expect(t.baseline_input_tokens).toBeGreaterThan(t.actual_input_tokens);
  expect(tokens.totals.reduction_pct).toBeGreaterThan(0);

  const runJson = readRunJson(summary.runDir) as Record<string, unknown>;
  expect(runJson['status']).toBe('stalled');
  expect(runJson['driver']).toBe(driver);
}

// ───────────────────────────── runs ─────────────────────────────

let claude: FakeClaude;
let openai: FakeOpenAI;
let claudeRun: { summary: RunSummary; text: string };
let openaiRun: { summary: RunSummary; text: string };
let claudeCompat: FakeClaude;
let openaiCompat: FakeOpenAI;
let claudeCompatRun: { summary: RunSummary; text: string };
let claudeLate: FakeClaude;
let claudeLateRun: { summary: RunSummary; text: string };
let openaiCompatRun: { summary: RunSummary; text: string };

const EXTRAS_REJECTION = 'thinking.block_binding: Extra inputs are not permitted';

beforeAll(async () => {
  tmp = tempRepo('live-shape');
  claude = fakeClaude(TRAJECTORY);
  claudeRun = await run(claudeVia(claude), 10);
  openai = fakeOpenAI(TRAJECTORY);
  openaiRun = await run(openaiVia(openai), 10);
  claudeCompat = fakeClaude(TRAJECTORY, { rejectFirstWith: EXTRAS_REJECTION });
  claudeCompatRun = await run(claudeVia(claudeCompat), TOOL_TURNS);
  claudeLate = fakeClaude(TRAJECTORY, { rejectFirstWith: EXTRAS_REJECTION, rejectAtTurn: 3 });
  claudeLateRun = await run(claudeVia(claudeLate), TOOL_TURNS);
  openaiCompat = fakeOpenAI(TRAJECTORY, { rejectMaxCompletionTokens: true });
  openaiCompatRun = await run(openaiVia(openaiCompat), TOOL_TURNS);
}, 600_000);

afterAll(() => {
  tmp?.cleanup();
});

describe('claude driver: real harness loop through the real SDK', () => {
  it('no request was rejected by the Messages API validators', () => {
    expect(claude.rejections).toEqual([]);
    expect(claude.injected).toEqual([]);
    expect(claude.served()).toBe(TOTAL_TURNS);
  });

  it('the harness behaved as with any driver (hooks, tools, tokens, evidence)', () => {
    expectHarnessBehaviour(claudeRun.summary, 'claude');
    expect(claudeRun.summary.model).toBe('claude-opus-5-5');
  });

  it('every completion went to the beta endpoint with both betas, full extras and replayed thinking', () => {
    const creates = createRequests(claude, '/v1/messages');
    expect(creates).toHaveLength(TOTAL_TURNS);
    for (const r of creates) {
      expect(r.url.searchParams.get('beta')).toBe('true');
      const betas = (r.headers.get('anthropic-beta') ?? '').split(',');
      expect(betas).toEqual(expect.arrayContaining([CLAUDE_EXPECTED_BETAS.fallbacks, CLAUDE_EXPECTED_BETAS.blockBinding]));
      expect(r.body).toMatchObject({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        fallbacks: 'default',
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        cache_control: { type: 'ephemeral' },
        tool_choice: { type: 'auto' },
      });
    }
    // turn 3's request carries turn 2's thinking block verbatim, then both tool results (one an error)
    const third = creates[2]?.body['messages'];
    if (!Array.isArray(third)) throw new Error('no messages');
    const assistant: unknown = third[third.length - 2];
    const user: unknown = third[third.length - 1];
    expect(assistant).toMatchObject({ role: 'assistant' });
    const blocks = (assistant as { content: Array<{ type: string; thinking?: string; name?: string }> }).content;
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use']);
    expect(blocks[0]?.thinking).toBe(TRAJECTORY[1]?.thinking);
    expect(user).toMatchObject({ role: 'user', content: [{ type: 'tool_result', is_error: false }, { type: 'tool_result', is_error: true }] });
    expect(JSON.stringify(user)).toContain('BLOCKED by observed-red');
  });

  it('token counting used count_tokens (plain endpoint, no thinking) for actual and baseline every turn', () => {
    const counts = createRequests(claude, '/v1/messages/count_tokens');
    expect(counts).toHaveLength(2 * TOTAL_TURNS);
    for (const r of counts) {
      expect(r.headers.get('anthropic-beta')).toBeNull();
      expect(JSON.stringify(r.body)).not.toContain('"thinking"');
    }
    const tokens = tokenFile(claudeRun.summary.tokensPath);
    // the ledger holds exactly what the endpoint counted: actual, then baseline, per turn
    expect(tokens.turns.flatMap((t) => [t.actual_input_tokens, t.baseline_input_tokens])).toEqual(claude.counted);
    // provider usage parsed through the SDK: input + cache read + cache write; cache read as cached
    expect(tokens.turns.map((t) => t.provider_reported_input_tokens)).toEqual(claude.reportedInput);
    expect(tokens.turns[0]?.provider_cached_input_tokens).toBe(0);
    expect(tokens.turns[1]?.provider_cached_input_tokens).toBeGreaterThan(0);
  });

  it('thinking blocks travel through the core as opaque parts', () => {
    const rows = transcript(claudeRun.summary.runDir);
    for (const r of rows) expect(r.assistant[0]).toMatchObject({ type: 'opaque', driver: 'claude' });
  });
});

describe('openai driver: real harness loop through the real SDK', () => {
  it('no request was rejected by the Chat Completions validators', () => {
    expect(openai.rejections).toEqual([]);
    expect(openai.injected).toEqual([]);
    expect(openai.served()).toBe(TOTAL_TURNS);
  });

  it('the harness behaved as with any driver (hooks, tools, tokens, evidence)', () => {
    expectHarnessBehaviour(openaiRun.summary, 'openai');
    expect(openaiRun.summary.model).toBe('gpt-5.5');
  });

  it('requests carry system first, function tools, max_completion_tokens and role:tool answers', () => {
    const reqs = createRequests(openai, '/v1/chat/completions');
    expect(reqs).toHaveLength(TOTAL_TURNS);
    for (const r of reqs) {
      expect(r.body).toMatchObject({ model: 'gpt-5.5', max_completion_tokens: 16000, tool_choice: 'auto' });
      expect(r.body['messages']).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' })]));
    }
    const third = reqs[2]?.body['messages'];
    if (!Array.isArray(third)) throw new Error('no messages');
    const tail: unknown[] = third.slice(-3);
    expect(tail[0]).toMatchObject({ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'write_file' } }, { type: 'function', function: { name: 'write_file' } }] });
    expect(tail[1]).toMatchObject({ role: 'tool' });
    expect(tail[2]).toMatchObject({ role: 'tool' });
    expect(JSON.stringify(tail[2])).toContain('BLOCKED by observed-red');
  });

  it('token report: local counts per turn and provider usage parsed through the SDK', () => {
    const tokens = tokenFile(openaiRun.summary.tokensPath);
    expect(tokens.turns.map((t) => t.provider_reported_input_tokens)).toEqual(openai.reportedInput);
    expect(tokens.turns[1]?.provider_cached_input_tokens).toBeGreaterThan(0);
  });
});

describe('model agnosticism across the two real drivers', () => {
  it('run.json fingerprints are identical (zero diff)', () => {
    const a = readRunJson(claudeRun.summary.runDir);
    const b = readRunJson(openaiRun.summary.runDir);
    expect(agnosticDiff(a, b)).toEqual([]);
    expect(Object.keys(a.pluginFingerprint).length).toBeGreaterThan(10);
  });

  it('both runs ended in the same clean, reported state', () => {
    for (const r of [claudeRun, openaiRun]) {
      expect(r.text).toContain('status     stalled  turns 7');
      expect(r.text).toMatch(/verdict    NOT DONE \(loop ended stalled\)/);
      expect(r.text).toMatch(/tokens     actual \d+  baseline \d+/);
    }
  });
});

describe('400 downgrade through the real SDK', () => {
  it('claude: a 400 naming an optional extra switches to the plain endpoint and the run continues', () => {
    expect(claudeCompat.rejections).toEqual([]);
    expect(claudeCompat.injected).toHaveLength(1);
    expect(claudeCompat.injected[0]?.url.searchParams.get('beta')).toBe('true');
    const creates = createRequests(claudeCompat, '/v1/messages');
    expect(creates).toHaveLength(1 + TOOL_TURNS); // the rejected beta call + every turn on the plain endpoint
    for (const r of creates.slice(1)) {
      expect(r.url.searchParams.has('beta')).toBe(false);
      expect(r.headers.get('anthropic-beta')).toBeNull();
      expect(Object.keys(r.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system', 'tool_choice', 'tools']);
    }
    const s = claudeCompatRun.summary;
    expect(s.status).toBe('max_turns');
    expect(s.turns).toBe(TOOL_TURNS);
    expect(s.model).toBe('claude-opus-5-5 (compat)');
    expect(readRunJson(s.runDir)).toMatchObject({ model: 'claude-opus-5-5 (compat)', initialModel: 'claude-opus-5-5' });
    const events = readEvents(s.runDir);
    expect(driverErrors(events)).toEqual([]); // the driver absorbed the 400; the loop never retried
    expect(hookBlocks(events).map((e) => e.source)).toEqual(['observed-red']);
    expect(tokenFile(s.tokensPath).turns).toHaveLength(TOOL_TURNS);
  });

  it('claude: a downgrade mid-run strips the thinking blocks already in history and the run continues', () => {
    expect(claudeLate.rejections).toEqual([]);
    expect(claudeLate.injected).toHaveLength(1);
    const creates = createRequests(claudeLate, '/v1/messages');
    expect(creates).toHaveLength(1 + TOOL_TURNS);
    expect(creates.slice(0, 3).map((r) => r.url.searchParams.get('beta'))).toEqual(['true', 'true', 'true']);
    for (const r of creates.slice(3)) {
      expect(r.url.searchParams.has('beta')).toBe(false);
      expect(JSON.stringify(r.body['messages'])).not.toContain('"thinking"');
    }
    const s = claudeLateRun.summary;
    expect(s.status).toBe('max_turns');
    expect(s.model).toBe('claude-opus-5-5 (compat)');
    expect(driverErrors(readEvents(s.runDir))).toEqual([]);
    const rows = transcript(s.runDir);
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
    expect(rows[3]?.results?.map((r) => r.isError)).toEqual([false]);
  });

  it('openai: a 400 unsupported max_completion_tokens switches to max_tokens and the run continues', () => {
    expect(openaiCompat.rejections).toEqual([]);
    expect(openaiCompat.injected).toHaveLength(1);
    const reqs = createRequests(openaiCompat, '/v1/chat/completions');
    expect(reqs).toHaveLength(1 + TOOL_TURNS);
    for (const r of reqs.slice(1)) {
      expect(r.body['max_tokens']).toBe(16000);
      expect('max_completion_tokens' in r.body).toBe(false);
    }
    const s = openaiCompatRun.summary;
    expect(s.status).toBe('max_turns');
    expect(s.turns).toBe(TOOL_TURNS);
    expect(s.model).toBe('gpt-5.5 (compat)');
    const events = readEvents(s.runDir);
    expect(driverErrors(events)).toEqual([]);
    expect(hookBlocks(events).map((e) => e.source)).toEqual(['observed-red']);
  });

  it('the downgraded runs still have zero fingerprint diff with the full runs', () => {
    const base = readRunJson(claudeRun.summary.runDir);
    for (const r of [claudeCompatRun, claudeLateRun, openaiCompatRun]) expect(agnosticDiff(base, readRunJson(r.summary.runDir))).toEqual([]);
  });
});
