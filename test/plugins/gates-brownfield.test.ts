/**
 * standards gate, brownfield policy (real git repo, real check runner, content-driven rules):
 * - strict (the default): the standards rules at 100% over the whole API, like greenfield; pre-existing
 *   violations in files outside the task scope are an "incompatible target" failure, never a pass.
 * - baseline mode (explicit `standards: baseline`): block only on what the run introduced versus a
 *   baseline measured on the base commit, labelled "baseline mode: below 100% allowed".
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckFinding, CheckPlugin, GatePlugin, GateResult, RunContext } from '../../src/core/plugin-api.ts';
import { runChecks } from '../../src/core/checks.ts';
import { runGates } from '../../src/core/gates.ts';
import { honesty, standardsLine } from '../../src/core/run.ts';
import standardsGate, { BASELINE_KEY, BASELINE_MODE, blocksOnlyOnUnprovenNow } from '../../plugins/gates/standards.ts';
import checkStandards from '../../plugins/tools/check_standards.ts';
import { brownfieldTask, callTool, greenfieldTask, HARNESS_ROOT, makeHarness, realExec, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const run = (g: GatePlugin, ctx: RunContext): Promise<GateResult> => g.run(ctx, 'finish');

async function vcs(cwd: string, ...args: string[]): Promise<void> {
  const r = await realExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

// ───────────────────────────── content-driven rules ─────────────────────────────

const ROUTE = /\.(get|post|put|patch|delete)\('([^']+)'/;

/** Standards rule: one unit per route line; a route line reading req.body without .parse( fails (message names the route). */
const bodyRule: CheckPlugin = {
  kind: 'check', id: 'zod-boundary', category: 'standards', unit: 'handlers',
  async run(ctx) {
    const out: CheckFinding[] = [];
    for (const file of ctx.sourceFiles) {
      const lines = (await ctx.read(file)).split('\n');
      let total = 0;
      const violations: CheckFinding['violations'] = [];
      lines.forEach((line, i) => {
        const m = ROUTE.exec(line);
        if (m === null) return;
        total++;
        if (line.includes('req.body') && !line.includes('.parse(req.body')) {
          violations.push({ location: `${file}:${i + 1}:1`, message: `${(m[1] ?? '').toUpperCase()} ${m[2] ?? ''}: request body is not parsed` });
        }
      });
      if (total > 0) out.push({ rule: 'zod-boundary', file, status: violations.length > 0 ? 'fail' : 'pass', units: { passed: total - violations.length, total }, violations });
    }
    return out;
  },
};

/** Lint rule: console calls. */
const noConsole: CheckPlugin = {
  kind: 'check', id: 'no-console', category: 'lint', unit: 'files',
  async run(ctx) {
    const out: CheckFinding[] = [];
    for (const file of ctx.sourceFiles) {
      const violations = (await ctx.read(file)).split('\n').flatMap((line, i) =>
        line.includes('console.') ? [{ location: `${file}:${i + 1}:${line.indexOf('console.') + 1}`, message: 'console call' }] : []);
      out.push({ rule: 'no-console', file, status: violations.length > 0 ? 'fail' : 'pass', units: { passed: violations.length > 0 ? 0 : 1, total: 1 }, violations });
    }
    return out;
  },
};

/** Cross-file standards rule: every `throw` line fails unless src/lib/errors.ts still exports problem(). */
const problemRule: CheckPlugin = {
  kind: 'check', id: 'problem-json', category: 'standards', unit: 'error paths',
  async run(ctx) {
    const helper = ctx.sourceFiles.includes('src/lib/errors.ts') && (await ctx.read('src/lib/errors.ts')).includes('export function problem');
    const out: CheckFinding[] = [];
    for (const file of ctx.sourceFiles) {
      const throws = (await ctx.read(file)).split('\n').flatMap((line, i) => (line.includes('throw ') ? [i + 1] : []));
      if (throws.length === 0) continue;
      const violations = helper ? [] : throws.map((n) => ({ location: `${file}:${n}:1`, message: 'error is not a problem+json response' }));
      out.push({ rule: 'problem-json', file, status: violations.length > 0 ? 'fail' : 'pass', units: { passed: throws.length - violations.length, total: throws.length }, violations });
    }
    return out;
  },
};

/** A rule whose parser gives up on a marker: skipped = UNPROVEN. */
const fragile: CheckPlugin = {
  kind: 'check', id: 'rest-conventions', category: 'standards', unit: 'routes',
  async run(ctx) {
    const out: CheckFinding[] = [];
    for (const file of ctx.sourceFiles) {
      const text = await ctx.read(file);
      if (text.includes('UNREADABLE')) throw new Error(`cannot parse ${file}`);
      const n = text.split('\n').filter((l) => ROUTE.test(l)).length;
      if (n > 0) out.push({ rule: 'rest-conventions', file, status: 'pass', units: { passed: n, total: n }, violations: [] });
    }
    return out;
  },
};

const RULES = [bodyRule, noConsole, problemRule, fragile];

// ───────────────────────────── fixtures ─────────────────────────────

const route = (method: string, path: string, parsed: boolean): string =>
  `router.${method}('${path}', (req, res) => { const b = ${parsed ? 'Body.parse(req.body)' : 'req.body'}; res.json(b); });`;
const ERRORS = 'export function problem(status: number) { return { status }; }\n';

interface Setup {
  kind?: 'greenfield' | 'brownfield';
  base: Record<string, string>;
  /** Files written after the base commit (the run's edits). */
  edits?: Record<string, string>;
  checks?: CheckPlugin[];
  /** Commit the base (false = no base commit: the baseline cannot be measured). */
  commit?: boolean;
  /** Brownfield standards policy (absent = the strict default). */
  standards?: 'strict' | 'baseline';
  scope?: { allow: string[]; deny: string[] };
}

async function setup(s: Setup) {
  const task = s.kind === 'greenfield' ? greenfieldTask() : { ...brownfieldTask(s.scope), ...(s.standards !== undefined ? { standards: s.standards } : {}) };
  const h = await makeHarness({ label: 'gates-bf', task, files: s.base });
  dirs.push(h.dir);
  if (s.commit !== false) {
    await vcs(h.dir, 'init', '-q');
    await vcs(h.dir, 'add', '-A');
    await vcs(h.dir, 'commit', '-q', '-m', 'base');
  }
  // run-start snapshot = the base commit, exactly as executeRun takes it
  for (const [rel, content] of Object.entries(s.base)) h.ctx.state.initialHashes.set(rel, sha(content));
  for (const [rel, content] of Object.entries(s.edits ?? {})) await h.ws.write(rel, content);
  const roots: string[] = [];
  const checks = s.checks ?? RULES;
  h.ctx.services.runChecks = (o) => {
    roots.push(o?.root ?? h.ws.root);
    return runChecks({ root: o?.root ?? h.ws.root, checks, exec: realExec, harnessRoot: HARNESS_ROOT, logs: h.ctx.logs, ...(o?.rules !== undefined ? { rules: o.rules } : {}) });
  };
  return { ...h, roots };
}

/** A small API in some layout: a router file, the errors helper, and a legacy file. */
function api(layout: { routes: string; legacy: string; resource: string }, legacyBody: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [layout.routes]: [
      route('get', `/v1/${layout.resource}`, true),
      route('post', `/v1/${layout.resource}`, true),
      `export function get() { throw problem(404); }`,
    ].join('\n') + '\n',
    'src/lib/errors.ts': ERRORS,
    [layout.legacy]: `${legacyBody}\n`,
    ...extra,
  };
}

const LAYOUTS = [
  { routes: 'src/routes/items.ts', legacy: 'src/legacy/old.ts', resource: 'items' },
  { routes: 'src/modules/projects/routes.ts', legacy: 'src/modules/projects/legacy-handlers.ts', resource: 'projects' },
  { routes: 'src/api/v1/order-lines.router.ts', legacy: 'src/compat/OrderLinesV0.ts', resource: 'order-lines' },
  { routes: 'src/http/controllers/customer_accounts.ts', legacy: 'src/http/deprecated/index.ts', resource: 'customer_accounts' },
];

// ───────────────────────────── tests ─────────────────────────────

describe('standards gate, brownfield baseline mode (opt-in): pre-existing violations do not block', () => {
  for (const layout of LAYOUTS) {
    it(`(a) a planted pre-existing standards violation in an untouched file passes and is listed (${layout.routes})`, async () => {
      const legacy = route('put', `/v0/${layout.resource}/:id`, false);
      const base = api(layout, legacy);
      // The run adds a compliant route to the router file.
      const edits = { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', `/v1/${layout.resource}/:id`, true)}\n` };
      const h = await setup({ standards: 'baseline', base, edits });
      const r = await run(standardsGate, h.ctx);
      const line = `pre-existing (not blocking): zod-boundary ${layout.legacy}:1:1  PUT /v0/${layout.resource}/:id: request body is not parsed`;
      expect(r.status, JSON.stringify(r)).toBe('pass');
      expect(r.summary).toMatch(/^baseline mode: below 100% allowed; verdict \d+% over the whole API \(brownfield: 1 pre-existing violation\(s\) in untouched files; base commit \d+%\)/);
      expect(r.summary).not.toMatch(/verdict 100%/); // the true whole-API percentage, not a cleaned-up one
      expect(r.details).toEqual([line]);
      expect(r.humanMustVerify).toEqual([expect.stringMatching(/^baseline mode: below 100% allowed \(the task opted in/), line]);
    });

    it(`(b) a violation the run introduces in a file it changed fails (${layout.routes})`, async () => {
      const base = api(layout, route('put', `/v0/${layout.resource}/:id`, false));
      const edits = { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', `/v1/${layout.resource}/:id`, false)}\n` };
      const h = await setup({ standards: 'baseline', base, edits });
      const r = await run(standardsGate, h.ctx);
      expect(r.status).toBe('fail');
      expect(r.summary).toContain('brownfield: 1 pre-existing violation(s) in untouched files');
      expect(r.details).toContain(`introduced (in a file this run changed): zod-boundary ${layout.routes}:4:1  PATCH /v1/${layout.resource}/:id: request body is not parsed`);
      expect(r.details?.some((d) => d.startsWith('pre-existing (not blocking): zod-boundary'))).toBe(true);
    });
  }

  it('(b) introduced violations fail for every rule category (standards and lint)', async () => {
    const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
    for (const [edit, rule] of [[route('patch', '/v1/items/:id', false), 'zod-boundary'], ['console.log("debug");', 'no-console']] as const) {
      const base = api(layout, 'export const legacy = 1;');
      const h = await setup({ standards: 'baseline', base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${edit}\n` } });
      const r = await run(standardsGate, h.ctx);
      expect(r.status, rule).toBe('fail');
      expect(r.details?.[0], rule).toMatch(new RegExp(`^introduced \\(in a file this run changed\\): ${rule} `));
    }
  });

  it('(b) a change elsewhere that breaks an untouched file is blocking, not "pre-existing"', async () => {
    const layout = LAYOUTS[1] ?? { routes: '', legacy: '', resource: '' };
    const base = api(layout, 'export function legacy() { throw problem(410); }');
    const h = await setup({ standards: 'baseline', base, edits: { 'src/lib/errors.ts': 'export const nothing = 0;\n' } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(expect.arrayContaining([
      `introduced (in a file this run did not change: a change elsewhere caused it): problem-json ${layout.legacy}:1:1  error is not a problem+json response`,
      `introduced (in a file this run did not change: a change elsewhere caused it): problem-json ${layout.routes}:3:1  error is not a problem+json response`,
      'problem-json: 2 failing error paths vs 0 at the base commit',
    ]));
  });

  it('(c) a rule the base commit proved that is UNPROVEN now fails; unproven at the base too stays unproven', async () => {
    const layout = LAYOUTS[2] ?? { routes: '', legacy: '', resource: '' };
    const base = api(layout, 'export const legacy = 1;');
    const broken = await setup({ standards: 'baseline', base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}// UNREADABLE\n` } });
    const r = await run(standardsGate, broken.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toMatch(/^rest-conventions: UNPROVEN now \(skipped: check crashed: cannot parse .*\) but proven at the base commit \(\d+\/\d+ routes\)$/);

    const already = await setup({ standards: 'baseline', base: api(layout, '// UNREADABLE legacy'), edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/x/:id', true)}\n` } });
    const u = await run(standardsGate, already.ctx);
    expect(u.status).toBe('unproven');
    expect(u.details?.[0]).toMatch(/^rest-conventions: skipped: .* \(unproven at the base commit too/);
  });

  it('(d) the same untouched-file standards violation: greenfield and default brownfield fail, only baseline mode passes', async () => {
    const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
    const base = api(layout, route('put', '/v0/items/:id', false));
    for (const [kind, standards, want] of [['greenfield', undefined, 'fail'], ['brownfield', undefined, 'fail'], ['brownfield', 'strict', 'fail'], ['brownfield', 'baseline', 'pass']] as const) {
      const h = await setup({ kind, base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}\n` }, ...(standards !== undefined ? { standards } : {}) });
      const r = await run(standardsGate, h.ctx);
      expect(r.status, `${kind} ${standards ?? 'default'}`).toBe(want);
    }
  });

  it('a pre-existing violation in a file the run edited (lines shifted) is not blocking; a second copy is', async () => {
    const layout = LAYOUTS[3] ?? { routes: '', legacy: '', resource: '' };
    const old = route('put', `/v0/${layout.resource}/:id`, false);
    const base = api(layout, old);
    const shifted = { [layout.legacy]: `// a comment the run added\n\n${old}\n` };
    const h = await setup({ standards: 'baseline', base, edits: shifted });
    const r = await run(standardsGate, h.ctx);
    expect(r.status, JSON.stringify(r)).toBe('pass');
    expect(r.summary).toContain('brownfield: 0 pre-existing violation(s) in untouched files, 1 in files this run changed');
    expect(r.details).toEqual([`pre-existing (not blocking; in a file this run changed): zod-boundary ${layout.legacy}:3:1  PUT /v0/${layout.resource}/:id: request body is not parsed`]);

    const twice = await setup({ standards: 'baseline', base, edits: { [layout.legacy]: `${old}\n${old}\n` } });
    const t = await run(standardsGate, twice.ctx);
    expect(t.status).toBe('fail');
    expect(t.details?.[0]).toContain('introduced (in a file this run changed)');
  });

  it('no base commit: a violation in a changed file fails; an untouched-file one is unproven, never green', async () => {
    const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
    const base = api(layout, route('put', '/v0/items/:id', false));
    const untouched = await setup({ standards: 'baseline', base, commit: false });
    const u = await run(standardsGate, untouched.ctx);
    expect(u.status).toBe('unproven');
    expect(u.summary).toContain('no baseline');
    const changed = await setup({ standards: 'baseline', base, commit: false, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', false)}\n` } });
    expect((await run(standardsGate, changed.ctx)).status).toBe('fail');
  });

  it('an all-green report needs no baseline; the baseline is measured once and cached in run state', async () => {
    const layout = LAYOUTS[1] ?? { routes: '', legacy: '', resource: '' };
    const clean = await setup({ standards: 'baseline', base: api(layout, 'export const legacy = 1;'), commit: false });
    expect(await run(standardsGate, clean.ctx)).toMatchObject({ status: 'pass', summary: 'verdict 100% (4 rules)' });
    expect(clean.roots).toEqual([clean.ws.root]);

    const dirty = await setup({ standards: 'baseline', base: api(layout, route('put', '/v0/x/:id', false)) });
    expect((await run(standardsGate, dirty.ctx)).status).toBe('pass');
    expect((await run(standardsGate, dirty.ctx)).status).toBe('pass');
    expect(dirty.roots.filter((r) => r !== dirty.ws.root)).toHaveLength(1); // one snapshot run for two gate runs
    expect(dirty.ctx.state.scratch.get(BASELINE_KEY)).toMatchObject({ sha: 'HEAD', rules: expect.any(Array) });
  });

  it('an unattributable violation is pre-existing only when the base commit had it too', async () => {
    const project = (message: string): CheckPlugin => ({
      kind: 'check', id: 'tsc-strict', category: 'standards', unit: 'errors',
      run: async (ctx) => {
        const bad = (await Promise.all(ctx.sourceFiles.map((f) => ctx.read(f)))).some((t) => t.includes('BROKEN'));
        // The checked root appears in the message (as tsc prints absolute paths): it differs between the snapshot and the worktree.
        return [{ rule: 'tsc-strict', file: '(project)', status: bad ? 'fail' : 'pass', units: bad ? { passed: 0, total: 1 } : { passed: 1, total: 1 }, violations: bad ? [{ location: '(project)', message: `${message} in ${ctx.root}/tsconfig.json` }] : [] }];
      },
    });
    const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
    const pre = await setup({ standards: 'baseline', base: api(layout, '// BROKEN'), checks: [bodyRule, project('TS5023: unknown option')] });
    const p = await run(standardsGate, pre.ctx);
    expect(p.status, JSON.stringify(p)).toBe('pass');
    expect(p.summary).toContain('1 not attributable to a file');
    const fresh = await setup({ standards: 'baseline', base: api(layout, 'export const ok = 1;'), edits: { [layout.legacy]: '// BROKEN\n' }, checks: [bodyRule, project('TS5023: unknown option')] });
    expect((await run(standardsGate, fresh.ctx)).status).toBe('fail');
  });
});

/**
 * A repository with debt: 8 pre-existing findings in three untouched legacy files (6 unparsed bodies, 2
 * console calls), so a whole-API report buries what one run introduces.
 */
function indebted(layout: { routes: string; legacy: string; resource: string }): Record<string, string> {
  const legacy = (consoleCall: boolean, v: string): string => [route('put', `/v0/${v}/:id`, false), route('delete', `/v0/${v}/:id`, false), ...(consoleCall ? ['console.log("legacy");'] : [])].join('\n');
  return api(layout, legacy(true, 'a'), { 'src/legacy/more.ts': `${legacy(true, 'b')}\n`, 'src/legacy/third.ts': `${legacy(false, 'c')}\n` });
}

describe('standards gate, baseline mode: the summary says what blocks first', () => {
  const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
  const base = indebted(layout);
  const introduced = `zod-boundary ${layout.routes}:4:1  PATCH /v1/items/:id: request body is not parsed`;

  it('one introduced finding among many pre-existing ones: the count and that finding lead the summary, before the label and the whole-API verdict', async () => {
    const h = await setup({ standards: 'baseline', base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', false)}\n` } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.summary.startsWith(`2 introduced by this run: ${introduced}; ${BASELINE_MODE}; verdict `), r.summary).toBe(true);
    expect(r.summary).toContain('(brownfield: 8 pre-existing violation(s) in untouched files; base commit ');
    // The finding and the rule's failing count that went up with it: the finding is the one named first.
    expect(r.failing).toBe(2);
    expect(r.details?.slice(0, 2)).toEqual([`introduced (in a file this run changed): ${introduced}`, 'zod-boundary: 7 failing handlers vs 6 at the base commit']);
    // In brief, one line per rule with a count (what a short view shows) ...
    expect(r.humanMustVerifyBrief).toEqual([
      expect.stringMatching(/^baseline mode: below 100% allowed \(the task opted in/),
      'pre-existing (not blocking): zod-boundary 6 in 3 files',
      'pre-existing (not blocking): no-console 2 in 2 files',
    ]);
    // ... while the records keep every pre-existing finding, one per line, as before.
    expect(r.humanMustVerify).toHaveLength(9);
    expect(r.humanMustVerify).toContain(`pre-existing (not blocking): zod-boundary ${layout.legacy}:1:1  PUT /v0/a/:id: request body is not parsed`);
  });

  it('twin: nothing introduced: no lead, the label first (as before), and still one count line per rule in brief', async () => {
    const h = await setup({ standards: 'baseline', base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', true)}\n` } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('pass');
    expect(r.summary.startsWith(`${BASELINE_MODE}; verdict `)).toBe(true);
    expect(r.summary).not.toContain('introduced by this run:');
    expect(r.humanMustVerifyBrief?.slice(1)).toEqual([expect.stringContaining('zod-boundary 6 in 3 files'), expect.stringContaining('no-console 2 in 2 files')]);
  });

  it('without a base commit, a violation in a changed file leads the summary too', async () => {
    const h = await setup({ standards: 'baseline', base, commit: false, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', false)}\n` } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.summary.startsWith(`1 violation(s) in files this run changed: ${introduced}; ${BASELINE_MODE}; verdict `), r.summary).toBe(true);
    expect(r.summary).toContain('no baseline (');
  });

  it('strict mode: an introduced lint finding leads the summary as well, without the baseline label', async () => {
    const clean = api(layout, 'export const legacy = 1;', { 'src/legacy/more.ts': 'console.log("old");\n' });
    const h = await setup({ base: clean, edits: { [layout.routes]: `${clean[layout.routes] ?? ''}console.log("debug");\n` } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.summary.startsWith(`2 introduced by this run: no-console ${layout.routes}:4:1  console call; verdict `), r.summary).toBe(true);
    expect(r.summary).toContain('(brownfield: 1 pre-existing violation(s) in untouched files');
    expect(r.summary).not.toContain(BASELINE_MODE);
  });
});

describe('check_standards says what the standards gate blocks on (baseline mode)', () => {
  const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
  const base = indebted(layout);
  const bad = { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', false)}\n` };
  const good = { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', true)}\n` };

  it('leads with the finding this run introduced; the pre-existing ones are one count line per rule, never listed', async () => {
    const h = await setup({ standards: 'baseline', base, edits: bad });
    const r = await callTool(checkStandards, {}, h.ctx);
    expect(r.ok).toBe(false);
    const lines = r.summary.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'BLOCKING: 2 introduced by this run (the standards gate fails until each is fixed):',
      `  introduced (in a file this run changed): zod-boundary ${layout.routes}:4:1  PATCH /v1/items/:id: request body is not parsed`,
      '  zod-boundary: 7 failing handlers vs 6 at the base commit',
    ]);
    expect(lines).toContain('pre-existing, not blocking: zod-boundary 6 in 3 files');
    expect(lines).toContain('pre-existing, not blocking: no-console 2 in 2 files');
    expect(lines.at(-1)).toBe('standards gate now: FAIL');
    // Short: not one pre-existing finding is listed.
    expect(r.summary).not.toMatch(/\/v0\//);
    expect(r.summary).not.toContain('src/legacy/');
    expect(lines.length).toBeLessThanOrEqual(7);
    // The gate's own classification, not a copy: the gate blocks on exactly those lines.
    const g = await run(standardsGate, h.ctx);
    expect(g.status).toBe('fail');
    expect(g.failing).toBe(2);
    expect(g.details?.slice(0, 2)).toEqual(lines.slice(1, 3).map((l) => l.trim()));
    // The full report is still the raw return (logged; the --baseline replay), after what blocks.
    const report = await h.ctx.services.runChecks();
    expect(r.raw?.startsWith(r.summary)).toBe(true);
    expect(r.raw).toContain(report.text);
  });

  it('twin: nothing introduced says so plainly (ok, the gate passes), with the per-rule counts', async () => {
    const h = await setup({ standards: 'baseline', base, edits: good });
    const r = await callTool(checkStandards, {}, h.ctx);
    expect(r.ok).toBe(true);
    const lines = r.summary.split('\n');
    expect(lines[0]).toBe('nothing this run introduced blocks; 8 pre-existing findings are not blocking');
    expect(lines).toContain('pre-existing, not blocking: zod-boundary 6 in 3 files');
    expect(lines.at(-1)).toBe('standards gate now: pass');
    expect((await run(standardsGate, h.ctx)).status).toBe('pass');
  });

  it('a subset of the rules never states the gate\'s verdict: { rules: [no-console] } while the gate fails on zod-boundary', async () => {
    const h = await setup({ standards: 'baseline', base, edits: bad });
    const r = await callTool(checkStandards, { rules: ['no-console'] }, h.ctx);
    const lines = r.summary.split('\n');
    expect(lines[0]).toBe('nothing this run introduced in the rules this call checked blocks; 2 pre-existing findings are not blocking');
    expect(lines).toContain('pre-existing, not blocking: no-console 2 in 2 files');
    expect(r.summary).not.toContain('standards gate now');
    expect(r.summary).not.toContain('over the whole API');
    expect(lines.at(-2)).toMatch(/^verdict \d+% over the rules this call checked \(no-console\); only what this run introduced blocks/);
    expect(lines.at(-1)).toBe('the rules this call checked (no-console): pass. The standards gate checks every rule and was not judged by this call: check_standards without "rules" says what it blocks on');
    // ok is those rules' own result (as a subset's verdict is in strict mode), never the gate's; the records say so too.
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ subset: { rules: ['no-console'], status: 'pass' } });
    expect(r.data).not.toHaveProperty('gate');
    expect((await run(standardsGate, h.ctx)).status).toBe('fail');
    // The same tree over every rule: the gate's own verdict.
    const every = await callTool(checkStandards, {}, h.ctx);
    expect(every.ok).toBe(false);
    expect(every.summary.split('\n').at(-1)).toBe('standards gate now: FAIL');
  });

  it('twin: a subset that holds the introduced finding lists it as blocking, ok false, and still does not speak for the gate', async () => {
    const h = await setup({ standards: 'baseline', base, edits: bad });
    const r = await callTool(checkStandards, { rules: ['zod-boundary'] }, h.ctx);
    const lines = r.summary.split('\n');
    expect(lines.slice(0, 2)).toEqual([
      'BLOCKING: 2 introduced by this run in the rules this call checked (the standards gate fails until each is fixed):',
      `  introduced (in a file this run changed): zod-boundary ${layout.routes}:4:1  PATCH /v1/items/:id: request body is not parsed`,
    ]);
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain('standards gate now');
    expect(lines.at(-1)).toMatch(/^the rules this call checked \(zod-boundary\): FAIL\. The standards gate checks every rule and was not judged by this call/);
    expect(r.data).toMatchObject({ subset: { rules: ['zod-boundary'], status: 'fail' }, blocking: 2 });
  });

  it('a subset on the web profile judges its own rules (the whole gate\'s "type check or lint counted" is not asked of it); twin: every rule is', async () => {
    const h = await setup({ standards: 'baseline', base, edits: good, checks: [bodyRule] });
    const web: RunContext = { ...h.ctx, stack: 'web' };
    const every = await callTool(checkStandards, {}, web);
    expect(every.ok).toBe(false);
    expect(every.summary.split('\n').at(-1)).toMatch(/^standards gate now: UNPROVEN: /);
    expect((await run(standardsGate, web)).status).toBe('unproven');
    const sub = await callTool(checkStandards, { rules: ['zod-boundary'] }, web);
    expect(sub.ok).toBe(true);
    expect(sub.summary.split('\n').at(-1)).toMatch(/^the rules this call checked \(zod-boundary\): pass\. The standards gate checks every rule/);
  });

  it('{ all: true } lists the report\'s failing lines after what blocks (a report that lists every violation: no note that it stops)', async () => {
    const h = await setup({ standards: 'baseline', base, edits: bad });
    const r = await callTool(checkStandards, { all: true }, h.ctx);
    const report = await h.ctx.services.runChecks();
    expect(r.summary.startsWith('BLOCKING: 2 introduced by this run')).toBe(true);
    expect(r.summary.endsWith(`the standards report's failing lines (pre-existing included):\n${report.compact}`)).toBe(true);
    expect(r.summary).toContain(`${layout.legacy}:1:1  PUT /v0/a/:id: request body is not parsed`);
    // The default call says what "all" adds; this one has added it.
    expect((await callTool(checkStandards, {}, h.ctx)).summary).toContain('"all": true adds the report\'s failing lines, pre-existing included');
    expect(r.summary).not.toContain('"all": true adds');
  });

  it('more than 20 blocking findings: the default lists 20 and counts the rest; twin: { all: true } lists every one, then the report', async () => {
    const debt = Array.from({ length: 30 }, (_, i) => `console.log("legacy ${i}");`).join('\n');
    const owed = api(layout, debt);
    const many = Array.from({ length: 25 }, (_, i) => `console.log("debug ${i}");`).join('\n');
    const h = await setup({ standards: 'baseline', base: owed, edits: { [layout.routes]: `${owed[layout.routes] ?? ''}${many}\n` } });
    const last = `  introduced (in a file this run changed): no-console ${layout.routes}:28:1  console call`;
    const rule = '  no-console: 2 failing files vs 1 at the base commit';
    const first = await callTool(checkStandards, {}, h.ctx);
    const lines = first.summary.split('\n');
    expect(lines[0]).toBe('BLOCKING: 26 introduced by this run (the standards gate fails until each is fixed):');
    expect(lines.slice(1, 21).every((l) => l.startsWith('  introduced (in a file this run changed): no-console '))).toBe(true);
    expect(lines[21]).toBe('  … 6 more (the same call with "all": true lists every blocking line)');
    expect(first.summary).not.toContain(last);
    expect(first.summary).not.toContain(rule);
    expect(lines).toContain('pre-existing, not blocking: no-console 30 in 1 file');
    const all = await callTool(checkStandards, { all: true }, h.ctx);
    const allLines = all.summary.split('\n');
    const blocking = allLines.slice(1, allLines.findIndex((l, i) => i > 0 && !l.startsWith('  ')));
    expect(blocking).toHaveLength(26);
    expect(blocking).toContain(last);
    expect(blocking).toContain(rule);
    expect(all.summary).not.toContain('more (the same call');
    // Exactly what the gate blocks on.
    expect((await run(standardsGate, h.ctx)).failing).toBe(26);
    // Then the report, saying that it lists only its first violations.
    const report = await h.ctx.services.runChecks();
    expect(report.compact).toMatch(/… \d+ more violations/);
    expect(all.summary.endsWith(`the standards report's failing lines (pre-existing included; it lists the first violations and counts the rest):\n${report.compact}`)).toBe(true);
  });

  it('a rule the checker cannot prove now nor at the base commit: nothing blocks, yet never ok, and the gate\'s UNPROVEN is said', async () => {
    const unreadable = indebted(layout);
    unreadable[layout.legacy] = `${unreadable[layout.legacy] ?? ''}// UNREADABLE legacy\n`;
    const h = await setup({ standards: 'baseline', base: unreadable, edits: { [layout.routes]: `${unreadable[layout.routes] ?? ''}${route('patch', '/v1/items/:id', true)}\n` } });
    const r = await callTool(checkStandards, {}, h.ctx);
    const lines = r.summary.split('\n');
    expect(lines[0]).toBe('nothing this run introduced blocks; 8 pre-existing findings are not blocking');
    expect(lines).toContainEqual(expect.stringMatching(/^UNPROVEN \(never green\): rest-conventions: skipped: check crashed: cannot parse .* \(unproven at the base commit too/));
    expect(lines.at(-1)).toMatch(/^standards gate now: UNPROVEN: /);
    expect(r.ok).toBe(false);
    expect((await run(standardsGate, h.ctx)).status).toBe('unproven');
  });

  it('twin: a rule the checker proved at the base commit and cannot prove now blocks, and the gate fails', async () => {
    const h = await setup({ standards: 'baseline', base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}// UNREADABLE now\n` } });
    const r = await callTool(checkStandards, {}, h.ctx);
    const lines = r.summary.split('\n');
    expect(lines[0]).toMatch(/^BLOCKING: 1 introduced by this run/);
    expect(lines[1]).toMatch(/^ {2}rest-conventions: UNPROVEN now \(skipped: check crashed: cannot parse .*\) but proven at the base commit/);
    expect(lines.some((l) => l.startsWith('UNPROVEN (never green)'))).toBe(false);
    expect(lines.at(-1)).toBe('standards gate now: FAIL');
    expect(r.ok).toBe(false);
    expect((await run(standardsGate, h.ctx)).status).toBe('fail');
  });

  it('the gate\'s result says when it blocks only on rules unproven now (blocksOnlyOnUnprovenNow); twins: an introduced finding, and both', async () => {
    const unreadableNow = `${base[layout.routes] ?? ''}// UNREADABLE now\n`;
    const only = await run(standardsGate, (await setup({ standards: 'baseline', base, edits: { [layout.routes]: unreadableNow } })).ctx);
    expect(only.status).toBe('fail');
    expect(blocksOnlyOnUnprovenNow(only)).toBe(true);
    const introduced = await run(standardsGate, (await setup({ standards: 'baseline', base, edits: bad })).ctx);
    expect(introduced.status).toBe('fail');
    expect(blocksOnlyOnUnprovenNow(introduced)).toBe(false);
    const both = await run(standardsGate, (await setup({ standards: 'baseline', base, edits: { [layout.routes]: `${unreadableNow}${route('patch', '/v1/items/:id', false)}\n` } })).ctx);
    expect(both.status).toBe('fail');
    expect(both.details?.slice(0, both.failing).some((d) => d.includes(': UNPROVEN now ('))).toBe(true);
    expect(blocksOnlyOnUnprovenNow(both)).toBe(false);
    // Not all listed (more blocking lines than details): never read as "only".
    expect(blocksOnlyOnUnprovenNow({ ...only, failing: (only.details?.length ?? 0) + 1 })).toBe(false);
    expect(blocksOnlyOnUnprovenNow({ ...only, status: 'unproven' })).toBe(false);
  });

  it('no base commit: today\'s report, after a line saying the comparison was unavailable', async () => {
    const h = await setup({ standards: 'baseline', base, commit: false, edits: bad });
    const r = await callTool(checkStandards, {}, h.ctx);
    const report = await h.ctx.services.runChecks();
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/^the comparison with the base commit is unavailable \(base snapshot failed: .*\): violations in files this run changed block, and the others cannot be proven pre-existing\. standards gate now: FAIL\n/);
    expect(r.summary.endsWith(`\n${report.compact}`)).toBe(true);
  });

  it('twin: strict brownfield and greenfield return today\'s compact report exactly (same fixture, same edit)', async () => {
    for (const kind of ['brownfield', 'greenfield'] as const) {
      const h = await setup({ kind, base, edits: bad });
      const r = await callTool(checkStandards, {}, h.ctx);
      const report = await h.ctx.services.runChecks();
      expect(r, kind).toMatchObject({ ok: false, summary: report.compact, raw: report.text, data: { verdict: report.verdict, rules: report.rules } });
      expect(r.summary, kind).toContain('/v0/');
    }
  });
});

describe('standards gate, brownfield strict (the default): 100% over the whole API', () => {
  const layout = LAYOUTS[0] ?? { routes: '', legacy: '', resource: '' };
  const legacy = route('put', '/v0/items/:id', false);

  it('a pre-existing standards violation in an in-scope file fails: the run must fix it', async () => {
    const base = api(layout, legacy);
    const h = await setup({ base, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', true)}\n` } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status, JSON.stringify(r)).toBe('fail');
    expect(r.summary).toMatch(/^verdict \d+% over the whole API \(brownfield, strict: the standards rules must be 100%\): 1 standards violation\(s\) to fix$/);
    expect(r.details).toEqual([`must fix (in scope): zod-boundary ${layout.legacy}:1:1  PUT /v0/items/:id: request body is not parsed`]);
    expect(r.summary).not.toContain(BASELINE_MODE);
  });

  it('pre-existing violations in files the task scope forbids: "incompatible target" with the list, fail (never a silent pass)', async () => {
    const base = api(layout, legacy, { 'src/vendor/old.ts': `${route('delete', '/v0/items/:id', false)}\n` });
    const scope = { allow: ['src/**/*.ts', 'test/**/*.ts'], deny: ['src/legacy/**', 'src/vendor/**'] };
    const h = await setup({ base, scope, edits: { [layout.routes]: `${base[layout.routes] ?? ''}${route('patch', '/v1/items/:id', true)}\n` } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status, JSON.stringify(r)).toBe('fail');
    expect(r.summary).toMatch(/^incompatible target: 2 pre-existing violation\(s\) in files outside the task scope \(src\/legacy\/old\.ts, src\/vendor\/old\.ts\): the standards rules cannot reach 100% without editing them/);
    expect(r.failing).toBe(2);
    expect(r.details?.[0]).toBe('incompatible target: 2 pre-existing violation(s) in files outside the task scope (src/legacy/old.ts, src/vendor/old.ts)');
    expect(r.humanMustVerify?.[0]).toContain('incompatible target: 2 pre-existing violation(s)');
  });

  it('a standards violation the run causes in a forbidden file (via a change elsewhere) is blocking, not "incompatible"', async () => {
    const base = api(layout, 'export function legacy() { throw problem(410); }');
    const scope = { allow: ['src/**/*.ts', 'test/**/*.ts'], deny: ['src/legacy/**'] };
    const h = await setup({ base, scope, edits: { 'src/lib/errors.ts': 'export const nothing = 0;\n' } });
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.summary).not.toContain('incompatible target');
    expect(r.details).toContain(`introduced (in a file outside the task scope: a change elsewhere caused it): problem-json ${layout.legacy}:1:1  error is not a problem+json response`);
  });

  it('standards at 100%: pass; other rules still follow the base-commit comparison', async () => {
    const clean = await setup({ base: api(layout, 'export const legacy = 1;') });
    expect(await run(standardsGate, clean.ctx)).toMatchObject({ status: 'pass', summary: 'verdict 100% (4 rules)' });
    const lint = await setup({ base: api(layout, 'console.log("old");') });
    const l = await run(standardsGate, lint.ctx);
    expect(l.status, JSON.stringify(l)).toBe('pass');
    expect(l.summary).toContain('1 pre-existing violation(s) in untouched files');
    expect(l.summary).not.toContain(BASELINE_MODE);
  });
});

describe('the task front end normalizes the standards policy', () => {
  it('canonical, aliased and absent spellings', async () => {
    const { normalizeTask } = await import('../../src/core/task.ts');
    const base = { kind: 'brownfield', id: 'x', title: 'x', target: 'api', change: 'c' };
    const t = (extra: Record<string, unknown>) => normalizeTask({ ...base, ...extra });
    expect(t({}).task).not.toHaveProperty('standards');
    expect(t({ standards: 'baseline' }).task).toMatchObject({ standards: 'baseline' });
    const aliased = t({ 'standards-mode': 'Diff-Aware' });
    expect(aliased.task).toMatchObject({ standards: 'baseline' });
    expect(aliased.warnings).toContain('standards "Diff-Aware" -> "baseline"');
    expect(t({ standardsPolicy: '100%' }).task).toMatchObject({ standards: 'strict' });
    expect(() => t({ standards: 'sometimes' })).toThrow(/standards/);
    expect(normalizeTask({ ...base, standards: 'baseline' }, { strict: true }).task).toMatchObject({ standards: 'baseline' });
    const green = normalizeTask({ kind: 'greenfield', id: 'g', title: 'g', brief: 'b', standards: 'baseline' });
    expect(green.task).not.toHaveProperty('standards');
    expect(green.task.carried).toEqual({ standards: 'baseline' });
  });
});

describe('gate humanMustVerify reaches the honesty report', () => {
  it('runGates keeps string items and honesty lists them under "human must verify"', async () => {
    const h = await makeHarness({ label: 'gates-bf-honesty', task: brownfieldTask() });
    dirs.push(h.dir);
    const gate: GatePlugin = {
      kind: 'gate', name: 'standards', phases: ['finish'],
      run: async () => ({ status: 'pass', summary: 'ok', humanMustVerify: ['pre-existing (not blocking): x', 7, 'pre-existing (not blocking): y'] as unknown as string[] }),
    };
    const out = await runGates([{ plugin: gate, file: 'plugins/gates/standards.ts', sha256: 'x' }], h.ctx, 'finish');
    expect(out.results[0]?.humanMustVerify).toEqual(['pre-existing (not blocking): x', 'pre-existing (not blocking): y']);
    const hon = honesty(brownfieldTask(), out.results, null);
    expect(hon.humanMustVerify).toEqual(expect.arrayContaining(['gate:standards: pre-existing (not blocking): x', 'gate:standards: pre-existing (not blocking): y']));
    // No brief given: none is invented.
    expect(out.results[0]).not.toHaveProperty('humanMustVerifyBrief');
  });

  it('runGates keeps the brief form (string items only) next to the full list; honesty still reports the full list', async () => {
    const h = await makeHarness({ label: 'gates-bf-brief', task: brownfieldTask() });
    dirs.push(h.dir);
    const gate: GatePlugin = {
      kind: 'gate', name: 'standards', phases: ['finish'],
      run: async () => ({
        status: 'pass', summary: 'ok',
        humanMustVerify: ['pre-existing (not blocking): x 1', 'pre-existing (not blocking): x 2'],
        humanMustVerifyBrief: ['pre-existing (not blocking): x 2 in 1 file', null] as unknown as string[],
      }),
    };
    const out = await runGates([{ plugin: gate, file: 'plugins/gates/standards.ts', sha256: 'x' }], h.ctx, 'finish');
    expect(out.results[0]?.humanMustVerifyBrief).toEqual(['pre-existing (not blocking): x 2 in 1 file']);
    const hon = honesty(brownfieldTask(), out.results, null);
    expect(hon.humanMustVerify).toEqual(expect.arrayContaining(['gate:standards: pre-existing (not blocking): x 1', 'gate:standards: pre-existing (not blocking): x 2']));
    expect(hon.humanMustVerify.join('\n')).not.toContain('in 1 file');
  });

  it('the run summary keeps the true whole-API verdict and says the brownfield gate compares with the base commit', () => {
    const report = {
      root: '/x', findings: [], text: '', compact: '',
      rules: [{ rule: 'zod-boundary', category: 'standards', unit: 'handlers', status: 'fail' as const, passed: 3, total: 4, files: 1 }],
      verdict: { status: 'fail' as const, percent: 75 },
    };
    expect(standardsLine(report, false, 'brownfield', 'baseline')).toMatch(/^FAIL 75% {2}zod-boundary fail {2}\(baseline mode: below 100% allowed; the standards gate blocks only what this run introduced/);
    expect(standardsLine(report, false, 'brownfield')).toBe('FAIL 75%  zod-boundary fail');
    expect(standardsLine(report, false, 'greenfield')).toBe('FAIL 75%  zod-boundary fail');
  });
});
