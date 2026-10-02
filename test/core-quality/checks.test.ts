import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createCheckContext, formatReport, runChecks } from '../../src/core/checks.ts';
import { createServices } from '../../src/core/services.ts';
import type { CheckContext, CheckFinding, CheckPlugin, Exec, LogStore, RegistryView, RunState, Workspace } from '../../src/core/types.ts';

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = join(HARNESS_ROOT, '.harness', 'tmp', `core-quality-checks-${randomBytes(4).toString('hex')}`);
const logs: LogStore = { write: async (name) => `runs/test/logs/001-${name}.txt` };
const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false });

function check(id: string, unit: string, findings: CheckFinding[] | (() => never), category = 'standards'): CheckPlugin {
  return {
    kind: 'check', id, category, unit, description: id, doc: `${id} doc`,
    run: async () => (Array.isArray(findings) ? findings : findings()),
  };
}
function pass(rule: string, file: string, n: number): CheckFinding {
  return { rule, file, status: 'pass', units: { passed: n, total: n }, violations: [] };
}

const green: CheckPlugin[] = [
  check('zod-boundary', 'handlers', [pass('zod-boundary', 'src/routes/users.ts', 5), pass('zod-boundary', 'src/routes/orders.ts', 7)]),
  check('problem-json', 'error paths', [pass('problem-json', '(runtime)', 4), pass('problem-json', 'src/app.ts', 5)]),
  check('tsc-strict', 'errors', [pass('tsc-strict', '(project)', 1)]),
  check('rest-conventions', 'routes', [pass('rest-conventions', 'src/routes/users.ts', 6)]),
];

async function findingsOf(checks: CheckPlugin[]): Promise<CheckFinding[]> {
  const out: CheckFinding[] = [];
  for (const c of checks) out.push(...(await c.run({} as CheckContext)));
  return out;
}

beforeAll(async () => {
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', allowImportingTsExtensions: true, noEmit: false } }),
    'src/a.ts': 'export function f(xs: number[]): number { const x = xs[0]; return x + 1; }\n',
    'src/a.test.ts': 'export {};\n',
    'src/types.d.ts': 'export {};\n',
    'test/a.test.ts': "import { f } from '../src/a.ts';\nf([1]);\n",
    'test/helpers.ts': 'export const h = 1;\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('formatReport', () => {
  it('renders the fixed-width all-green report with 100%', async () => {
    const r = formatReport(await findingsOf(green), green, root);
    expect(r.verdict).toEqual({ status: 'pass', percent: 100 });
    expect(r.text).toBe([
      'zod-boundary      pass  src/routes/users.ts              5/5 handlers',
      'zod-boundary      pass  src/routes/orders.ts             7/7 handlers',
      'problem-json      pass  (runtime)                        4/4 error paths',
      'problem-json      pass  src/app.ts                       5/5 error paths',
      'tsc-strict        pass  (project)                        0 errors',
      'rest-conventions  pass  src/routes/users.ts              6/6 routes',
      '────────────────────────────────────────────────────────────',
      'zod-boundary      pass    12/12 handlers',
      'problem-json      pass     9/9 error paths',
      'tsc-strict        pass     0 errors',
      'rest-conventions  pass     6/6 routes',
      'verdict           100%    → all rules green',
    ].join('\n'));
    // compact: only the summary block when everything passes
    expect(r.compact.split('\n')[0]).toBe('─'.repeat(60));
    expect(r.rules.map((x) => [x.rule, x.status, x.passed, x.total, x.files])).toEqual([
      ['zod-boundary', 'pass', 12, 12, 2], ['problem-json', 'pass', 9, 9, 2], ['tsc-strict', 'pass', 1, 1, 1], ['rest-conventions', 'pass', 6, 6, 1],
    ]);
  });

  it('fails with NN% and lists violations; tsc-strict prints its error count', async () => {
    const checks: CheckPlugin[] = [
      check('zod-boundary', 'handlers', [
        pass('zod-boundary', 'src/routes/users.ts', 5),
        { rule: 'zod-boundary', file: 'src/routes/orders.ts', status: 'fail', units: { passed: 1, total: 2 },
          violations: [{ location: `${root}/src/routes/orders.ts:42:5`, message: 'POST /v1/orders: response body is not parsed with a Zod schema' }] },
      ]),
      check('tsc-strict', 'errors', [
        { rule: 'tsc-strict', file: 'src/a.ts', status: 'fail', units: { passed: 0, total: 1 },
          violations: [{ location: 'src/a.ts:1:3', message: 'TS2532: Object is possibly undefined.' }, { location: 'src/a.ts:2:1', message: 'any keyword' }] },
        { rule: 'tsc-strict', file: '(project)', status: 'fail', units: { passed: 0, total: 0 }, violations: [] },
      ]),
    ];
    const r = formatReport(await findingsOf(checks), checks, root);
    expect(r.verdict).toEqual({ status: 'fail', percent: 75 });
    const lines = r.text.split('\n');
    expect(lines).toContain('zod-boundary      FAIL  src/routes/orders.ts             1/2 handlers');
    expect(lines).toContain('    src/routes/orders.ts:42:5  POST /v1/orders: response body is not parsed with a Zod schema');
    expect(lines).toContain('tsc-strict        FAIL  src/a.ts                         2 errors');
    expect(lines).toContain('zod-boundary      FAIL     6/7 handlers');
    expect(lines).toContain('tsc-strict        FAIL     2 errors');
    expect(lines.at(-1)).toBe('verdict           75%     → failing: zod-boundary, tsc-strict');
    expect(r.compact).not.toContain('src/routes/users.ts');
    expect(r.compact).toContain('zod-boundary      FAIL  src/routes/orders.ts');
  });

  it('a skip makes the verdict UNPROVEN even when everything else passes', async () => {
    const checks = [green[0], green[1], green[3], check('tsc-strict', 'errors', [
      { rule: 'tsc-strict', file: '(project)', status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'tsc could not run' },
    ])].filter((c): c is CheckPlugin => c !== undefined);
    const r = formatReport(await findingsOf(checks), checks, root);
    expect(r.verdict.status).toBe('unproven');
    expect(r.text).toContain('tsc-strict        skip  (project)                        skipped: tsc could not run');
    expect(r.text).toContain('tsc-strict        unproven 0 errors');
    expect(r.text.split('\n').at(-1)).toBe('verdict           UNPROVEN → not proven: tsc-strict (skipped)');
    expect(r.compact).toContain('skipped: tsc could not run');
  });

  it('standards rule with 0 units is unproven 0/0; non-standards rule with no findings is n/a', async () => {
    const checks = [
      check('zod-boundary', 'handlers', []),
      check('rest-conventions', 'routes', [{ rule: 'rest-conventions', file: '(project)', status: 'pass', units: { passed: 0, total: 0 }, violations: [] }]),
      check('drizzle-schema', 'tables', [], 'orm'),
      check('problem-json', 'error paths', [pass('problem-json', 'src/app.ts', 2)]),
    ];
    const r = formatReport(await findingsOf(checks), checks, root);
    const lines = r.text.split('\n');
    // per-file lines agree with the summary: a standards rule with 0 units is unproven, never n/a or pass
    expect(lines).toContain('zod-boundary      unproven  (none)                           0/0 handlers');
    expect(lines).toContain('rest-conventions  unproven  (project)                        0/0 routes');
    expect(lines).toContain('zod-boundary      unproven 0/0 handlers');
    expect(lines).toContain('rest-conventions  unproven 0/0 routes');
    expect(lines).toContain('drizzle-schema    n/a   (none)                           0/0 tables');
    expect(lines).toContain('drizzle-schema    n/a      0/0 tables');
    // the unproven lines are in the compact report (what the model sees); the n/a ones are not
    expect(r.compact).toContain('zod-boundary      unproven  (none)');
    expect(r.compact).not.toContain('drizzle-schema    n/a   (none)');
    expect(r.rules.map((x) => [x.rule, x.status])).toEqual([
      ['zod-boundary', 'unproven'], ['rest-conventions', 'unproven'], ['drizzle-schema', 'n/a'], ['problem-json', 'pass'],
    ]);
    expect(r.verdict.status).toBe('unproven');
    expect(lines.at(-1)).toBe('verdict           UNPROVEN → not proven: zod-boundary (0 units), rest-conventions (0 units)');
  });

  it('a non-standards rule with nothing to check has status n/a and is ignored by the verdict', async () => {
    const checks = [
      ...green,
      check('drizzle-schema', 'tables', [], 'orm'),
      check('no-todo', 'files', [{ rule: 'no-todo', file: '(project)', status: 'pass', units: { passed: 0, total: 0 }, violations: [] }], 'lint'),
    ];
    const r = formatReport(await findingsOf(checks), checks, root);
    expect(r.rules.filter((x) => x.status === 'n/a').map((x) => x.rule)).toEqual(['drizzle-schema', 'no-todo']);
    expect(r.verdict).toEqual({ status: 'pass', percent: 100 });
    expect(r.text).toContain('no-todo           n/a   (project)                        0/0 files');
    expect(r.text).toContain('no-todo           n/a      0/0 files');
  });

  it('only non-standards rules with no findings → nothing checked → UNPROVEN', () => {
    const checks = [check('drizzle-schema', 'tables', [], 'orm')];
    expect(formatReport([], checks, root).verdict).toEqual({ status: 'unproven', percent: 0 });
  });

  it('compact caps violation lines at 25', () => {
    const violations = Array.from({ length: 30 }, (_, i) => ({ location: `src/x.ts:${i + 1}:1`, message: 'bad' }));
    const checks = [check('zod-boundary', 'handlers', [])];
    const r = formatReport([{ rule: 'zod-boundary', file: 'src/x.ts', status: 'fail', units: { passed: 0, total: 30 }, violations }], checks, root);
    expect(r.compact.split('\n').filter((l) => l.startsWith('    src/x.ts:'))).toHaveLength(25);
    expect(r.compact).toContain('… 5 more violations');
    expect(r.text.split('\n').filter((l) => l.startsWith('    src/x.ts:'))).toHaveLength(30);
  });
});

describe('runChecks', () => {
  it('a throwing check becomes one skip finding → UNPROVEN; others still run', async () => {
    const boom = check('tsc-strict', 'errors', () => { throw new Error('kaboom'); });
    const checks = [green[0], boom].filter((c): c is CheckPlugin => c !== undefined);
    const r = await runChecks({ root, checks, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(r.root).toBe(root);
    expect(r.findings.filter((f) => f.rule === 'tsc-strict')).toEqual([
      { rule: 'tsc-strict', file: '(project)', status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'check crashed: kaboom' },
    ]);
    expect(r.findings.filter((f) => f.rule === 'zod-boundary')).toHaveLength(2);
    expect(r.verdict.status).toBe('unproven');
    expect(r.text).toContain('UNPROVEN');
  });

  it('filters by categories and rules', async () => {
    const lint = check('no-console', 'files', [pass('no-console', 'src/a.ts', 1)], 'lint');
    const all = [...green, lint];
    const byCat = await runChecks({ root, checks: all, exec, harnessRoot: HARNESS_ROOT, logs, categories: ['lint'] });
    expect(byCat.rules.map((x) => x.rule)).toEqual(['no-console']);
    const byRule = await runChecks({ root, checks: all, exec, harnessRoot: HARNESS_ROOT, logs, rules: ['tsc-strict', 'zod-boundary'] });
    expect(byRule.rules.map((x) => x.rule)).toEqual(['zod-boundary', 'tsc-strict']);
    expect(byRule.verdict).toEqual({ status: 'pass', percent: 100 });
  });
});

describe('createCheckContext', () => {
  it('lists files, caches source files and builds a forced-strict program', async () => {
    const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(ctx.sourceFiles).toEqual(['src/a.ts']);
    expect(ctx.testFiles).toEqual(['src/a.test.ts', 'test/a.test.ts', 'test/helpers.ts']);
    expect(await ctx.read('src/a.ts')).toContain('function f');
    const sf = ctx.sourceFile('src/a.ts');
    expect(ctx.sourceFile('src/a.ts')).toBe(sf);
    const program = ctx.program();
    expect(ctx.program()).toBe(program);
    const opts = program.getCompilerOptions();
    expect(opts.strict).toBe(true);
    expect(opts.noUncheckedIndexedAccess).toBe(true);
    expect(opts.noEmit).toBe(true);
    const diags = ts.getPreEmitDiagnostics(program).map((d) => d.code);
    expect(diags).toContain(18048); // 'x' is possibly 'undefined' (only under noUncheckedIndexedAccess)
  });

  it('dependencies() merges dependencies + devDependencies; {} without package.json; run info is optional', async () => {
    const bare = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(bare.dependencies()).toEqual({});
    expect(bare.taskKind).toBeUndefined();
    expect(bare.base).toBeUndefined();

    const withPkg = join(root, 'with-pkg');
    await mkdir(withPkg, { recursive: true });
    await writeFile(join(withPkg, 'package.json'), JSON.stringify({
      dependencies: { express: '^5.0.0', zod: '^4.0.0' },
      devDependencies: { vitest: '^5.0.0', zod: '^4.1.0', bogus: 3 },
    }));
    const base = { repoRoot: root, rootRel: 'with-pkg', sha: 'a'.repeat(40) };
    const ctx = await createCheckContext({ root: withPkg, exec, harnessRoot: HARNESS_ROOT, logs, taskKind: 'brownfield', base });
    expect(ctx.dependencies()).toEqual({ express: '^5.0.0', zod: '^4.1.0', vitest: '^5.0.0' });
    expect(ctx.taskKind).toBe('brownfield');
    expect(ctx.base).toEqual(base);

    await writeFile(join(withPkg, 'package.json'), '{ not json');
    const broken = await createCheckContext({ root: withPkg, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(broken.dependencies()).toEqual({});
  });

  it('runChecks hands taskKind/base to every check', async () => {
    const seen: Array<{ kind: string | undefined; sha: string | undefined }> = [];
    const probe: CheckPlugin = {
      kind: 'check', id: 'probe', category: 'custom',
      run: async (c) => {
        seen.push({ kind: c.taskKind, sha: c.base?.sha });
        return [pass('probe', 'src/a.ts', 1)];
      },
    };
    await runChecks({ root, checks: [probe], exec, harnessRoot: HARNESS_ROOT, logs, taskKind: 'greenfield', base: { repoRoot: root, rootRel: '.', sha: 'b'.repeat(40) } });
    await runChecks({ root, checks: [probe], exec, harnessRoot: HARNESS_ROOT, logs });
    expect(seen).toEqual([{ kind: 'greenfield', sha: 'b'.repeat(40) }, { kind: undefined, sha: undefined }]);
  });
});

describe('services.runChecks during a run', () => {
  it('populates taskKind and base (worktree root, API root, base sha)', async () => {
    const seen: unknown[] = [];
    const probe: CheckPlugin = {
      kind: 'check', id: 'probe', category: 'custom',
      run: async (c) => {
        seen.push({ kind: c.taskKind, base: c.base });
        return [pass('probe', 'src/a.ts', 1)];
      },
    };
    const ws = { repoRoot: dirname(root), root, rootRel: 'api' } as unknown as Workspace;
    const registry: RegistryView = { drivers: [], tools: [], hooks: [], gates: [], checks: [{ plugin: probe, file: 'p.ts', sha256: '0' }], errors: [] };
    const state = { turn: 1, tests: [] } as unknown as RunState;
    const services = createServices({ ws, registry, state, logs, exec, harnessRoot: HARNESS_ROOT, taskKind: 'brownfield', baseSha: 'c'.repeat(40) });
    await services.runChecks();
    expect(seen).toEqual([{ kind: 'brownfield', base: { repoRoot: dirname(root), rootRel: 'api', sha: 'c'.repeat(40) } }]);
  });
});

describe('rule column width', () => {
  it('widens to the longest rule id + 2 so every column stays aligned', () => {
    const long = check('orm-explicit-columns-strict', 'queries', [pass('orm-explicit-columns-strict', 'src/db.ts', 3)], 'orm');
    const short = check('zod-boundary', 'handlers', [pass('zod-boundary', 'src/routes/users.ts', 5)]);
    const r = formatReport([pass('orm-explicit-columns-strict', 'src/db.ts', 3), pass('zod-boundary', 'src/routes/users.ts', 5)], [long, short], root);
    const w = 'orm-explicit-columns-strict'.length + 2;
    for (const line of r.text.split('\n').filter((l) => !l.startsWith('─'))) {
      expect(line.slice(0, w).trimEnd().length).toBeLessThan(w - 1);
      expect(line[w]).not.toBe(' ');
    }
    // short ids still use the 18-column minimum
    const s = formatReport([pass('zod-boundary', 'src/routes/users.ts', 5)], [short], root);
    expect(s.text.split('\n')[0]?.indexOf('pass')).toBe(18);
  });
});
