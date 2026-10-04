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
import standardsGate, { BASELINE_KEY, BASELINE_MODE } from '../../plugins/gates/standards.ts';
import { brownfieldTask, greenfieldTask, HARNESS_ROOT, makeHarness, realExec, removeTmp, sha } from './helpers.ts';

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
