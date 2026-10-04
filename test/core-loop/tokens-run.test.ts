/**
 * The token baseline through a real `executeRun` (worktree, scaffold, registry, run.json,
 * tokens/<run>.json), once normally and once with --baseline, plus a run whose counter fails.
 * A recording driver wraps the scripted one and stops the run (operator abort) right after its
 * last scripted turn, so the slow final gates are skipped: only the requests matter here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { isContextFetcher } from '../../src/core/context.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import { compareRuns, parseTokenReport, type TokenReport } from '../../src/core/tokens.ts';
import type { Driver, DriverPlugin, ModelRequest, Part } from '../../src/core/types.ts';
import { collector, execWithoutGh, readRunJson, tempRepo, USERS_TASK, type TempRepo } from '../e2e/helpers.ts';

const MARKER = 'WIDGET_MARKER_51c9';
const TEST_FILE = 'test/widgets.test.ts';
const TEST_BODY = `import { describe, expect, it } from 'vitest';\n\ndescribe('${MARKER}', () => {\n  it('runs', () => {\n    expect(1).toBe(1);\n  });\n});\n`;

interface Recorder {
  requests: ModelRequest[];
  counted: ModelRequest[];
}

/** Wraps the scripted driver: records every request, aborts after call `stopAfter`, optionally fails every count. */
async function recordingDriver(rec: Recorder, stopAfter: number, controller: AbortController, failCount = false): Promise<DriverPlugin> {
  const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
  const scripted = reg.drivers.find((d) => d.plugin.name === 'scripted')?.plugin;
  if (scripted === undefined) throw new Error('scripted driver not registered');
  return {
    kind: 'driver',
    name: 'recording',
    description: 'test driver: records requests around the scripted driver',
    create(opts): Driver {
      const inner = scripted.create(opts);
      return {
        name: 'recording',
        model: inner.model,
        tokenCounter: inner.tokenCounter,
        async complete(req, signal) {
          rec.requests.push(req);
          const res = await inner.complete(req, signal);
          if (rec.requests.length >= stopAfter) controller.abort();
          return res;
        },
        async countTokens(req) {
          rec.counted.push(req);
          if (failCount) throw new Error('count endpoint unavailable');
          return inner.countTokens(req);
        },
      };
    },
  };
}

let tmp: TempRepo;
let script = '';
const runs: Record<'jit' | 'baseline' | 'flaky', { summary: RunSummary; rec: Recorder; text: string }> = {} as never;

async function run(kind: 'jit' | 'baseline' | 'flaky', turns: number): Promise<void> {
  const rec: Recorder = { requests: [], counted: [] };
  const controller = new AbortController();
  const out = collector();
  const summary = await executeRun({
    taskFile: USERS_TASK,
    driver: 'recording',
    driverOptions: { script },
    baseline: kind === 'baseline',
    ship: false,
    maxTurns: turns,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: out.out,
    signal: controller.signal,
    extraDrivers: [await recordingDriver(rec, turns, controller, kind === 'flaky')],
  });
  runs[kind] = { summary, rec, text: out.text() };
}

beforeAll(async () => {
  tmp = tempRepo('tokens-run');
  const dir = join(tmp.dir, 'script');
  mkdirSync(dir, { recursive: true });
  script = join(dir, 'widgets.json');
  writeFileSync(
    script,
    JSON.stringify({
      description: 'turn 1 fetches and writes a file; turn 2 only plans',
      turns: [
        { calls: [{ name: 'read_file', input: { path: 'src/app.ts' } }, { name: 'write_file', input: { path: TEST_FILE, content: TEST_BODY } }] },
        { calls: [{ name: 'plan', input: { steps: ['implement the widgets'] } }] },
      ],
    }),
  );
  await run('jit', 2);
  await run('baseline', 2);
  await run('flaky', 1);
}, 240_000);
afterAll(() => tmp.cleanup());

function tokens(kind: 'jit' | 'baseline' | 'flaky'): TokenReport {
  return parseTokenReport(JSON.parse(readFileSync(runs[kind].summary.tokensPath, 'utf8')));
}

function callNames(r: ModelRequest | undefined): string[] {
  return (r?.messages ?? []).flatMap((m) => m.parts).flatMap((p: Part) => (p.type === 'tool_call' ? [p.name] : []));
}

async function fetcherToolNames(): Promise<string[]> {
  const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
  return reg.tools.filter((r) => isContextFetcher(r.plugin) && (r.plugin.availableIn ?? ['greenfield']).includes('greenfield')).map((r) => r.plugin.name);
}

describe('normal run: shadow baseline', () => {
  it('run.json offers the fetchers; the token file says its baseline is a shadow estimate and how to measure it', async () => {
    const { summary, text } = runs.jit;
    expect(summary.turns).toBe(2);
    const run = readRunJson(summary.runDir) as Record<string, unknown>;
    expect(run['toolsOffered']).toEqual(expect.arrayContaining(await fetcherToolNames()));
    expect(run).not.toHaveProperty('contextFetchersWithheld');
    expect(run['tokens']).toMatchObject({ baseline_kind: 'shadow', provider_usage: 'none' });
    const t = tokens('jit');
    expect(t).toMatchObject({ baseline_kind: 'shadow', method: 'shadow-baseline', mode: 'jit', provider_usage: 'none' });
    expect(t.baseline_note).toContain('harness run <task> --baseline');
    expect(t.turns.map((r) => r.provider_reported_input_tokens)).toEqual([0, 0]); // scripted: no provider
    expect(text).toMatch(/^tokens\s+actual \d+\s+baseline \d+\s+reduction [\d.]+%.*no provider-reported usage/m);
    expect(text).toMatch(/baseline is a shadow estimate \(never sent\); measured: harness run <task> --baseline/);
  });

  it("turn 2's shadow holds the file turn 1 wrote, no fetcher schema, and not the run's fetch call", async () => {
    const { rec } = runs.jit;
    const shadow = rec.counted.filter((_, i) => i % 2 === 1); // actual, then shadow, per turn
    expect(shadow).toHaveLength(2);
    expect(shadow[0]?.system).not.toContain(MARKER);
    expect(shadow[1]?.system).toContain(`=== ${TEST_FILE} ===\n${TEST_BODY}`);
    expect(shadow[1]?.system).toContain('included below; there are no file-reading tools');
    const fetchers = await fetcherToolNames();
    for (const r of shadow) for (const f of fetchers) expect(r.tools.map((x) => x.name)).not.toContain(f);
    expect(callNames(shadow[1])).toEqual(['write_file']);
    // the request actually sent is the JIT one
    expect(rec.requests[1]?.system).toContain('Nothing is preloaded');
    expect(callNames(rec.requests[1])).toEqual(['read_file', 'write_file']);
  });
});

describe('--baseline run: measured', () => {
  it('withholds every context fetcher and records which; actual == baseline every turn', async () => {
    const { summary, rec } = runs.baseline;
    const fetchers = await fetcherToolNames();
    const run = readRunJson(summary.runDir) as Record<string, unknown>;
    expect(run['contextFetchersWithheld']).toEqual(fetchers);
    for (const f of fetchers) expect(run['toolsOffered']).not.toContain(f);
    for (const r of rec.requests) for (const f of fetchers) expect(r.tools.map((x) => x.name)).not.toContain(f);
    const t = tokens('baseline');
    expect(t).toMatchObject({ baseline_kind: 'measured', method: 'measured-baseline', mode: 'baseline' });
    for (const row of t.turns) expect(row.actual_input_tokens).toBe(row.baseline_input_tokens);
    expect(runs.baseline.text).toMatch(/baseline measured: this --baseline run sent the baseline request every turn/);
  });

  it('every request front-loads the CURRENT tree and the standards, and says so', () => {
    const { rec } = runs.baseline;
    expect(rec.requests).toHaveLength(2);
    const [first, second] = rec.requests;
    expect(first?.system).toContain('=== src/app.ts ===');
    expect(first?.system).not.toContain(MARKER);
    expect(second?.system).toContain(`=== ${TEST_FILE} ===\n${TEST_BODY}`);
    for (const r of rec.requests) {
      expect(r.system).toContain('included below; there are no file-reading tools');
      expect(r.system).not.toContain('Nothing is preloaded');
      expect(r.system).toMatch(/=== standard: [a-z-]+ ===/);
    }
    // the script's fetch call was refused as an unknown tool; the write went through
    const results = (second?.messages ?? []).flatMap((m) => m.parts).flatMap((p) => (p.type === 'tool_result' ? [p] : []));
    expect(results.map((p) => p.isError)).toEqual([true, false]);
    expect(results[0]?.content).toMatch(/^unknown tool "read_file"/);
    expect(results[1]?.content).toContain(TEST_FILE); // the raw return (a diff), not a compact summary
  });

  it('tokens compare: both ratios, and the caveats of an offline replay', () => {
    const c = compareRuns(tokens('jit'), tokens('baseline'));
    expect(c.jit.turns).toBe(2);
    expect(c.baseline.turns).toBe(2);
    expect(c.reduction_pct).toBeGreaterThan(0);
    expect(c.per_turn_reduction_pct).toBe(c.reduction_pct);
    expect(c.provider_reported_reduction_pct).toBeNull();
    expect(c.caveats.some((x) => /no provider-reported usage/.test(x))).toBe(true);
    expect(c.caveats.some((x) => /different (drivers|models|tasks|token counters)/.test(x))).toBe(false);
  });
});

describe('a counter that fails', () => {
  it('run.json and the token report name the chars/4 fallback, never the failed counter alone', () => {
    const { summary } = runs.flaky;
    const run = readRunJson(summary.runDir) as Record<string, unknown>;
    expect(run['tokenCounter']).toMatch(/^chars\/4 estimate for 2 count\(s\): .+ was unavailable$/);
    const t = tokens('flaky');
    expect(t.counter).toBe(run['tokenCounter']);
    expect(t.turns.every((r) => r.estimated === true)).toBe(true);
  });
});
