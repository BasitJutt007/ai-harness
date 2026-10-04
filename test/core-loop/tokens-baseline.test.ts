/**
 * Baseline honesty ("the same task on the same driver with context fetchers and compaction
 * disabled"):
 *  - the front-load holds files + standards docs only (tool schemas are already in every
 *    request's tools array, counted once);
 *  - --baseline offers no context fetcher, decided by effect and the declared `fetcher` flag,
 *    never by name (a dropped-in read tool is withheld too); the shadow baseline offers the same;
 *  - the repository is re-rendered from the CURRENT tree every turn, so a file written in turn 1
 *    is in turn 2's baseline request; the baseline prompt says it is included;
 *  - a turn's two counts always come from one counter; an offline driver's usage is never
 *    reported as provider usage.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { countRequest } from '../../plugins/lib/tokenize.ts';
import { fetcherNames, isContextFetcher, withoutFetchers } from '../../src/core/context.ts';
import { estimateTokens, runAgent, type RunAgentOptions } from '../../src/core/loop.ts';
import { frontLoad, standardDoc, systemPrompt } from '../../src/core/prompt.ts';
import { validatePlugin } from '../../src/core/registry.ts';
import { baselineSystemRenderer } from '../../src/core/run.ts';
import { BASELINE_DEFINITION, TokenLedger } from '../../src/core/tokens.ts';
import type { CheckPlugin, Message, ModelRequest, Part, ToolEffect, ToolPlugin, ToolSpec, Workspace } from '../../src/core/types.ts';
import { call, fakeCtx, FakeDriver, fakeStore, finishTool, firstMessage, GREENFIELD, reply, specs, writeTool } from './fakes.ts';

const files: Record<string, string> = {
  'src/app.ts': 'export const app = 1;',
  'package.json': '{}',
  'node_modules/x/index.js': 'skip me',
  'img.png': 'PNG\u0000bin',
};
const ws: Workspace = {
  repoRoot: '/r', root: '/r', rootRel: '.',
  resolve: (p: string) => p, rel: (p: string) => p,
  read: async (p: string) => files[p] ?? null,
  write: async () => undefined, exists: async () => true,
  list: async () => Object.keys(files),
};

const full: CheckPlugin = { kind: 'check', id: 'zod-boundary', category: 'standards', description: 'one line', unit: 'handlers', doc: 'FULL DOC TEXT', run: async () => [] };
const described: CheckPlugin = { kind: 'check', id: 'orm-rule', category: 'orm', description: 'ORM ONE LINE', run: async () => [] };
const bare: CheckPlugin = { kind: 'check', id: 'lint-rule', category: 'lint', run: async () => [] };
const checks = [full, described, bare];
const tools: ToolSpec[] = [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('frontLoad (shadow baseline system prompt)', () => {
  it('holds every text file under the API root and every standards doc, and no tool schema', async () => {
    const fl = await frontLoad({ ws, checks, tools });
    expect(fl).toContain('=== src/app.ts ===\nexport const app = 1;');
    expect(fl).toContain('=== package.json ===');
    expect(fl).not.toContain('node_modules');
    expect(fl).not.toContain('img.png');
    expect(fl).toContain('=== standard: zod-boundary ===\nFULL DOC TEXT');
    expect(fl).toContain('=== standard: orm-rule ===\nORM ONE LINE');
    expect(fl).toContain('=== standard: lint-rule ===\nlint-rule');
    expect(fl).not.toContain('=== tool:');
    expect(fl).not.toContain('"inputSchema"');
    expect(fl).not.toContain('"properties"');
    // tools are optional: same output with or without them
    expect(await frontLoad({ ws, checks })).toBe(fl);
  });

  it('counts tool schemas exactly once on both sides of the comparison', async () => {
    const system = systemPrompt({ task: GREENFIELD, checks, tools });
    const fl = await frontLoad({ ws, checks, tools });
    const req = { messages: [], tools, maxOutputTokens: 1 };
    const actual = countRequest({ ...req, system });
    const baseline = countRequest({ ...req, system: `${system}\n\n${fl}` });
    const withoutTools = countRequest({ ...req, tools: [], system: `${system}\n\n${fl}` }) - countRequest({ ...req, tools: [], system });
    expect(baseline - actual).toBe(withoutTools);
    expect(BASELINE_DEFINITION).toMatch(/tool schemas counted once/);
  });

  it('standardDoc and the system prompt index fall back when doc / description are missing', () => {
    expect(standardDoc(full)).toBe('FULL DOC TEXT');
    expect(standardDoc(described)).toBe('ORM ONE LINE');
    expect(standardDoc(bare)).toBe('lint-rule');
    const sp = systemPrompt({ task: GREENFIELD, checks, tools });
    expect(sp).toContain('- zod-boundary: one line');
    expect(sp).toContain('- orm-rule: ORM ONE LINE');
    expect(sp).toContain('- lint-rule: lint-rule');
    expect(sp).not.toContain('undefined');
    expect(sp).not.toContain('FULL DOC TEXT');
  });

  it('the prompt is mode-dependent: the normal prompt says nothing is preloaded, the --baseline prompt that everything is included', () => {
    const jit = systemPrompt({ task: GREENFIELD, checks, tools });
    const pre = systemPrompt({ task: GREENFIELD, checks, tools: [], preloaded: true });
    expect(jit).toContain('Nothing is preloaded; fetch on demand: read_file (line ranges)');
    expect(jit).toContain('fetch_standard <rule> for the full text');
    expect(pre).not.toContain('Nothing is preloaded');
    expect(pre).not.toContain('fetch_standard');
    expect(pre).toContain('The repository (every text file under the API root, re-read from the current tree before every turn) and the full text of every standard are included below; there are no file-reading tools.');
    expect(pre).toContain('Standards (full text below):');
  });
});

// ───────────────────────────── --baseline: no context fetchers ─────────────────────────────

/** A tool of the given shape (its run is trivial; only effect and flag matter here). */
function toolOf(name: string, effect: ToolEffect, fetcher?: boolean): ToolPlugin<unknown> {
  const t: ToolPlugin<Record<string, unknown>> = {
    kind: 'tool',
    name,
    description: name,
    input: z.record(z.string(), z.unknown()),
    effect,
    ...(fetcher !== undefined ? { fetcher } : {}),
    async run() {
      return { ok: true, summary: `${name} ran` };
    },
  };
  return t as ToolPlugin<unknown>;
}

/** Shapes of tools a harness may carry: shipped names, dropped-in names, explicit flags both ways. */
const SHAPES: Array<{ name: string; effect: ToolEffect; fetcher?: boolean; withheld: boolean }> = [
  { name: 'read_file', effect: 'read', withheld: true },
  { name: 'list_files', effect: 'read', withheld: true },
  { name: 'search_code', effect: 'read', withheld: true },
  { name: 'fetch_standard', effect: 'read', withheld: true },
  { name: 'peek_config', effect: 'read', withheld: true }, // dropped in: unknown name, read effect
  { name: 'grep-routes', effect: 'read', fetcher: true, withheld: true },
  { name: 'openapi_dump', effect: 'exec', fetcher: true, withheld: true }, // not a read tool, but declares it fetches context
  { name: 'clock', effect: 'read', fetcher: false, withheld: false }, // a read tool that fetches no repository context
  { name: 'write_file', effect: 'write', withheld: false },
  { name: 'save_note', effect: 'write', fetcher: false, withheld: false },
  { name: 'run_tests', effect: 'exec', withheld: false },
  { name: 'contract_diff', effect: 'exec', withheld: false },
  { name: 'plan', effect: 'control', withheld: false },
  { name: 'finish', effect: 'control', withheld: false },
];

describe('context fetchers: decided by effect and the fetcher flag, never by name', () => {
  const shaped = SHAPES.map((s) => toolOf(s.name, s.effect, s.fetcher));

  it('isContextFetcher / fetcherNames / withoutFetchers over a table of tool shapes', () => {
    for (const [i, s] of SHAPES.entries()) {
      const t = shaped[i];
      if (t === undefined) throw new Error('missing tool');
      expect(isContextFetcher(t), s.name).toBe(s.withheld);
    }
    expect([...fetcherNames(specs(shaped), shaped)].sort()).toEqual(SHAPES.filter((s) => s.withheld).map((s) => s.name).sort());
    expect(withoutFetchers(specs(shaped), shaped).map((t) => t.name)).toEqual(SHAPES.filter((s) => !s.withheld).map((s) => s.name));
    // a spec with no plugin behind it is not assumed to be a fetcher
    expect(withoutFetchers([...specs(shaped), { name: 'orphan', description: 'x', inputSchema: {} }], shaped).map((t) => t.name)).toContain('orphan');
  });

  it('the registry validates the flag: a boolean or nothing', () => {
    const base = { kind: 'tool', name: 'peek', input: z.object({}), effect: 'read', run: async () => ({ ok: true, summary: '' }) };
    expect('plugin' in validatePlugin({ ...base, fetcher: false })).toBe(true);
    expect('plugin' in validatePlugin(base)).toBe(true);
    expect(validatePlugin({ ...base, fetcher: 'yes' })).toMatchObject({ error: expect.stringMatching(/invalid tool plugin/) });
  });

  for (const baseline of [true, false]) {
    it(`${baseline ? '--baseline offers none of them' : 'a normal run offers every tool; its shadow baseline offers none of the fetchers'}`, async () => {
      const { ctx, logs } = fakeCtx({ tools: shaped, baseline });
      const driver = new FakeDriver([reply([call('c1', 'peek_config', {}), call('c2', 'clock', {})]), reply([{ type: 'text', text: 'ok' }], 'end_turn')]);
      await runAgent({
        driver, ctx, store: fakeStore(logs),
        ledger: new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: baseline ? 'baseline' : 'jit' }),
        first: firstMessage(), system: 'S', baselineSystem: 'S+F', tools: specs(shaped), maxTurns: 2, maxOutputTokens: 100, retryDelaysMs: [],
      });
      const kept = SHAPES.filter((s) => !s.withheld).map((s) => s.name);
      expect(driver.requests[0]?.tools.map((t) => t.name)).toEqual(baseline ? kept : SHAPES.map((s) => s.name));
      const baselineReqs = driver.counted.filter((r) => r.system === 'S+F');
      expect(baselineReqs).toHaveLength(2);
      for (const r of baselineReqs) expect(r.tools.map((t) => t.name)).toEqual(kept);
      // a call to a withheld fetcher in baseline mode is an unknown tool, never run
      const results = (driver.requests[1]?.messages ?? []).flatMap((m) => m.parts);
      const content = (id: string): string => {
        const p = results.find((x) => x.type === 'tool_result' && x.callId === id);
        return p?.type === 'tool_result' ? p.content : '';
      };
      expect(content('c1')).toMatch(baseline ? /^unknown tool "peek_config"/ : /^peek_config ran/);
      expect(content('c2')).toMatch(/^clock ran/);
    });
  }
});

// ───────────────────────────── the current tree, every turn ─────────────────────────────

/** An in-memory API root: tools write into `files`, the front-load lists and reads it. */
function memWorkspace(files: Map<string, string>): Workspace {
  return {
    repoRoot: '/mem', root: '/mem', rootRel: '.',
    resolve: (p) => `/mem/${p}`, rel: (p) => p,
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => {
      files.set(p, c);
    },
    exists: async (p) => files.has(p),
    list: async () => [...files.keys()],
  };
}

function readTool(files: Map<string, string>): ToolPlugin<unknown> {
  const t: ToolPlugin<{ path: string }> = {
    kind: 'tool',
    name: 'read_file',
    description: 'read',
    input: z.object({ path: z.string() }),
    effect: 'read',
    async run(i) {
      const c = files.get(i.path);
      return c === undefined ? { ok: false, summary: `${i.path} does not exist` } : { ok: true, summary: c, raw: `RAW ${c}` };
    },
  };
  return t as ToolPlugin<unknown>;
}

const MARKER = 'export const WIDGET_MARKER_7f3a = 42;';

function callNames(r: ModelRequest | undefined): string[] {
  return (r?.messages ?? []).flatMap((m: Message) => m.parts).flatMap((p: Part) => (p.type === 'tool_call' ? [p.name] : []));
}

describe('the baseline request is re-rendered from the current tree every turn', () => {
  for (const baseline of [true, false]) {
    it(`${baseline ? '--baseline (sent)' : 'shadow (counted)'}: a file written in turn 1 is in turn 2's baseline request`, async () => {
      const files = new Map([['src/app.ts', 'export const app = 1;']]);
      const fileTools = [readTool(files), writeTool((i) => files.set(i.path, i.content)), finishTool()];
      const { ctx, logs } = fakeCtx({ tools: fileTools, baseline });
      const ws = memWorkspace(files);
      const docs: CheckPlugin[] = [{ kind: 'check', id: 'zod-boundary', category: 'standards', description: 'one line', doc: 'ZOD DOC IN FULL', run: async () => [] }];
      const driver = new FakeDriver([
        reply([call('r1', 'read_file', { path: 'src/app.ts' }), call('w1', 'write_file', { path: 'src/routes/widgets.ts', content: MARKER })]),
        reply([{ type: 'text', text: 'ok' }], 'end_turn'),
      ]);
      const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: baseline ? 'baseline' : 'jit' });
      const opts: RunAgentOptions = {
        driver, ctx: { ...ctx, workspace: ws }, store: fakeStore(logs), ledger,
        first: firstMessage(),
        system: systemPrompt({ task: GREENFIELD, checks: docs, tools: specs(fileTools) }),
        baselineSystem: baselineSystemRenderer({ task: GREENFIELD, checks: docs, tools: withoutFetchers(specs(fileTools), fileTools), ws }),
        tools: specs(fileTools), maxTurns: 2, maxOutputTokens: 100, retryDelaysMs: [],
      };
      await runAgent(opts);
      // the baseline request of each turn: sent in --baseline mode, counted second in a normal run
      const perTurn = baseline ? driver.requests : driver.counted.filter((_, i) => i % 2 === 1);
      expect(perTurn).toHaveLength(2);
      expect(perTurn[0]?.system).toContain('=== src/app.ts ===\nexport const app = 1;');
      expect(perTurn[0]?.system).not.toContain('WIDGET_MARKER_7f3a');
      expect(perTurn[1]?.system).toContain(`=== src/routes/widgets.ts ===\n${MARKER}`);
      for (const r of perTurn) {
        expect(r.system).toContain('included below; there are no file-reading tools');
        expect(r.system).not.toContain('Nothing is preloaded');
        expect(r.system).toContain('=== standard: zod-boundary ===\nZOD DOC IN FULL');
        expect(r.tools.map((t) => t.name)).toEqual(['write_file', 'finish']);
      }
      const rep = ledger.report();
      if (baseline) {
        // what was sent is the baseline: the model's own (refused) fetch call stays in its history
        expect(callNames(perTurn[1])).toEqual(['read_file', 'write_file']);
        for (const t of rep.turns) expect(t.actual_input_tokens).toBe(t.baseline_input_tokens);
        expect(rep.baseline_kind).toBe('measured');
      } else {
        // the shadow leaves the run's fetch call out (its content is front-loaded) and keeps the write
        expect(callNames(perTurn[1])).toEqual(['write_file']);
        expect(JSON.stringify(perTurn[1]?.messages)).not.toContain('RAW export const app');
        expect(driver.requests[1]?.system).toContain('Nothing is preloaded');
        expect(callNames(driver.requests[1])).toEqual(['read_file', 'write_file']);
        expect(rep.baseline_kind).toBe('shadow');
        expect(rep.attribution_chars.fetch_traffic_left_out).toBeGreaterThan(0);
      }
    });
  }

  it("a failed re-render reuses the previous turn's front-load (with an error event); a failed first render is a loop error", async () => {
    let n = 0;
    const render = async (): Promise<string> => {
      n += 1;
      if (n === 2) throw new Error('disk gone');
      return `BASELINE-${n}`;
    };
    const one = [finishTool()];
    const { ctx, logs, events } = fakeCtx({ tools: one, baseline: true });
    const driver = new FakeDriver([reply([{ type: 'text', text: 'a' }], 'end_turn'), reply([{ type: 'text', text: 'b' }], 'end_turn'), reply([{ type: 'text', text: 'c' }], 'end_turn')]);
    const base = { driver, ctx, store: fakeStore(logs), first: firstMessage(), system: 'S', tools: specs(one), maxOutputTokens: 100, retryDelaysMs: [] };
    const led = (): TokenLedger => new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'c', mode: 'baseline' });
    await runAgent({ ...base, ledger: led(), baselineSystem: render, maxTurns: 3 });
    expect(driver.requests.map((r) => r.system)).toEqual(['BASELINE-1', 'BASELINE-1', 'BASELINE-3']);
    expect(events.some((e) => e.kind === 'error' && /could not be re-rendered: disk gone/.test(e.message))).toBe(true);
    const failing = async (): Promise<string> => Promise.reject(new Error('no tree'));
    const r = await runAgent({ ...base, ledger: led(), baselineSystem: failing, maxTurns: 1 });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/no tree/);
  });
});

// ───────────────────────────── one counter per turn; no fake provider usage ─────────────────────────────

/** A FakeDriver whose counter fails for the requests `fails` picks. */
class FlakyCounter extends FakeDriver {
  fails: (req: ModelRequest) => boolean = () => false;
  override async countTokens(req: ModelRequest): Promise<number> {
    if (this.fails(req)) {
      this.counted.push(req);
      throw new Error('count endpoint unavailable');
    }
    return super.countTokens(req);
  }
}

describe('counting', () => {
  for (const which of ['actual', 'baseline'] as const) {
    it(`when the ${which} count fails, BOTH counts of that turn are chars/4 estimates (never two counters in one ratio)`, async () => {
      const one = [finishTool()];
      const { ctx, logs, events } = fakeCtx({ tools: one });
      const driver = new FlakyCounter([reply([{ type: 'text', text: 'a' }], 'end_turn'), reply([{ type: 'text', text: 'b' }], 'end_turn')]);
      driver.fails = (r) => driver.requests.length === 0 && r.system === (which === 'baseline' ? 'S+FRONT' : 'S');
      const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'driver counter', mode: 'jit' });
      await runAgent({ driver, ctx, store: fakeStore(logs), ledger, first: firstMessage(), system: 'S', baselineSystem: 'S+FRONT', tools: specs(one), maxTurns: 2, maxOutputTokens: 100, retryDelaysMs: [] });
      const rep = ledger.report();
      const [t1, t2] = rep.turns;
      const actualReq = driver.requests[0];
      if (actualReq === undefined || t1 === undefined || t2 === undefined) throw new Error('missing turn');
      expect(t1.estimated).toBe(true);
      expect(t1.actual_input_tokens).toBe(estimateTokens(actualReq));
      expect(t1.baseline_input_tokens).toBeGreaterThan(t1.actual_input_tokens);
      expect(t2.estimated).toBeUndefined(); // the next turn is counted by the driver again
      expect(rep.counter).toBe('chars/4 estimate for 2 count(s): driver counter was unavailable');
      // a failed actual count does not even ask the driver for that turn's baseline
      expect(driver.counted).toHaveLength(which === 'actual' ? 3 : 4);
      expect(events.some((e) => e.kind === 'error' && new RegExp(`countTokens\\(${which}\\) failed.*actual and baseline counts are chars/4 estimates`).test(e.message))).toBe(true);
    });
  }

  it('estimateTokens counts the tool schemas too (both sides of a turn are estimated alike)', () => {
    const req: ModelRequest = { system: 'abcd', messages: [], tools: [], maxOutputTokens: 1 };
    const withTools: ModelRequest = { ...req, tools: [{ name: 'x', description: 'y'.repeat(400), inputSchema: {} }] };
    expect(estimateTokens(withTools)).toBeGreaterThan(estimateTokens(req) + 99);
  });

  it('a driver that reports no provider usage (an offline replay) is never recorded as provider usage', async () => {
    const one = [finishTool()];
    const { ctx, logs } = fakeCtx({ tools: one });
    const offline = { parts: [{ type: 'text' as const, text: 'a' }], stop: 'end_turn' as const, usage: { inputTokens: 999, outputTokens: 99, cachedInputTokens: 9, reported: false }, model: 'm' };
    const driver = new FakeDriver([offline]);
    const ledger = new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'c', mode: 'jit' });
    await runAgent({ driver, ctx, store: fakeStore(logs), ledger, first: firstMessage(), system: 'S', baselineSystem: 'S+F', tools: specs(one), maxTurns: 1, maxOutputTokens: 100, retryDelaysMs: [] });
    const rep = ledger.report();
    expect(rep.provider_usage).toBe('none');
    expect(rep.turns[0]).toMatchObject({ provider_reported_input_tokens: 0, provider_cached_input_tokens: 0, output_tokens: 0 });
    expect(rep.turns[0]?.actual_input_tokens).toBeGreaterThan(0); // the counter still counted the request
  });
});
