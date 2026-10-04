/**
 * Fail-closed core: inverted and presence-only cases, the runner process outcome, validated check findings,
 * required gates, the run's own UNPROVEN items, test-runner detection in source, the contract diff's blind
 * spots, and the spec-coverage opt-out. Each bypass is paired with the legitimate case that still passes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { formatReport, validFinding } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { requiredGates, runGates } from '../../src/core/gates.ts';
import { notDoneReason, runUnprovenItems } from '../../src/core/run.ts';
import { normalizeTask } from '../../src/core/task.ts';
import { countsAsMissingModuleRed, countsAsRed, joinCases, reportSuccess, runnerSucceeded } from '../../src/core/testing.ts';
import { resolveSpecifier, staticTestCases } from '../../src/core/testmap.ts';
import type { CaseResolver } from '../../src/core/testmap.ts';
import type { CheckPlugin, GatePlugin, GateResult, PluginRecord, RunContext } from '../../src/core/types.ts';
import { diffContracts, schemaSource } from '../../plugins/lib/contract.ts';
import type { Contract, ContractEndpoint } from '../../plugins/lib/contract.ts';
import { newBoundaryViolations } from '../../plugins/hooks/source-boundary.ts';
import { brownfieldTask, greenfieldTask, makeHarness, removeTmp } from '../plugins/helpers.ts';

const resolver: CaseResolver = {
  resolve: (spec) => resolveSpecifier('test/u.test.ts', spec, new Set(['src/users.ts'])),
  reachesSource: (t) => t.startsWith('src/'),
};
const cases = (body: string) => staticTestCases('test/u.test.ts', `import { make } from '../src/users.ts';\nimport assert from 'node:assert';\n${body}`, resolver);

describe('inverted cases (it.fails / test.failing) are never red or green', () => {
  it('marks the case, and every case of a suite with an inverting modifier', () => {
    const cs = cases([
      "it.fails('a', () => { expect(make()).toBe(1); });",
      "test.failing('b', () => { expect(make()).toBe(1); });",
      "describe.fails('s', () => { it('c', () => { expect(make()).toBe(1); }); });",
      "it('plain', () => { expect(make()).toBe(1); });",
    ].join('\n'));
    expect(cs.map((c) => [c.name, c.inverted === true])).toEqual([['a', true], ['b', true], ['s > c', true], ['plain', false]]);
    const joined = joinCases(cs, [
      { ancestorTitles: [], title: 'a', status: 'failed', failureMessages: [] },
      { ancestorTitles: [], title: 'plain', status: 'failed', failureMessages: [] },
    ], false);
    expect(countsAsRed(joined[0]!)).toBe(false);
    expect(joined[0]?.inverted).toBe(true);
    expect(countsAsRed(joined[3]!)).toBe(true);
  });
});

describe('presence-only assertions are no proof for a missing module', () => {
  it('toBeDefined / toBeTruthy / toBeInstanceOf / assert.ok / toHaveProperty(k) are presence-only; value assertions are not', () => {
    const cs = cases([
      "it('defined', () => { expect(make).toBeDefined(); expect(make()).not.toBeUndefined(); });",
      "it('truthy', () => { expect(make()).toBeTruthy(); assert.ok(make()); assert(make()); });",
      "it('prop', () => { expect(make()).toHaveProperty('id'); expect(make()).toBeInstanceOf(Object); });",
      "it('value', () => { expect(make()).toBeDefined(); expect(make().id).toBe(1); });",
      "it('assert value', () => { assert.equal(make().id, 1); });",
      "it('assert compare', () => { assert(make().id === 1); });",
      "it('prop value', () => { expect(make()).toHaveProperty('id', 1); });",
    ].join('\n'));
    expect(cs.map((c) => [c.name, c.exercisesSource, c.presenceOnly === true])).toEqual([
      ['defined', true, true], ['truthy', true, true], ['prop', true, true],
      ['value', true, false], ['assert value', true, false], ['assert compare', true, false], ['prop value', true, false],
    ]);
    const joined = joinCases(cs, [], true);
    expect(joined.map(countsAsMissingModuleRed)).toEqual([false, false, false, true, true, true, true]);
  });
});

describe('the runner process outcome decides green too', () => {
  it('exit 0, not timed out, report success not false', () => {
    expect(runnerSucceeded({ code: 0, timedOut: false })).toBe(true);
    expect(runnerSucceeded({ code: 0, timedOut: false, success: true })).toBe(true);
    expect(runnerSucceeded({ code: 1, timedOut: false })).toBe(false);
    expect(runnerSucceeded({ code: null, timedOut: true })).toBe(false);
    expect(runnerSucceeded({ code: 0, timedOut: false, success: false })).toBe(false);
    expect(reportSuccess('{"success":false,"testResults":[]}')).toBe(false);
    expect(reportSuccess('{"testResults":[]}')).toBeUndefined();
    expect(reportSuccess('not json')).toBeUndefined();
  });
});

describe('check findings are validated, never trusted', () => {
  const check: CheckPlugin = { kind: 'check', id: 'r', category: 'quality', description: '', run: async () => [] };
  const rule = (findings: Parameters<typeof formatReport>[0]) => formatReport(findings, [check], '/x').rules[0];

  it('non-finite / negative units, passed > total, unknown status → skip (UNPROVEN) with the reason', () => {
    const bad = [
      { rule: 'r', file: 'a.ts', status: 'pass', units: { passed: Number.NaN, total: 1 }, violations: [] },
      { rule: 'r', file: 'a.ts', status: 'pass', units: { passed: -1, total: 0 }, violations: [] },
      { rule: 'r', file: 'a.ts', status: 'pass', units: { passed: 5, total: 2 }, violations: [] },
      { rule: 'r', file: 'a.ts', status: 'ok', units: { passed: 1, total: 1 }, violations: [] },
      { rule: 'r', file: 'a.ts', status: 'pass', units: { passed: Number.POSITIVE_INFINITY, total: Number.POSITIVE_INFINITY }, violations: [] },
    ];
    for (const f of bad) {
      const v = validFinding(f, 'r');
      expect(v.status).toBe('skip');
      expect(v.skipReason).toMatch(/^invalid finding from the check: /);
      expect(rule([f as never])?.status).toBe('unproven');
    }
  });

  it('a pass carrying violations is a fail', () => {
    const f = { rule: 'r', file: 'a.ts', status: 'pass' as const, units: { passed: 1, total: 1 }, violations: [{ location: 'a.ts:1:1', message: 'x' }] };
    expect(validFinding(f, 'r').status).toBe('fail');
    expect(rule([f])?.status).toBe('fail');
  });

  it('legitimate: a well-formed pass stays a pass', () => {
    const f = { rule: 'r', file: 'a.ts', status: 'pass' as const, units: { passed: 2, total: 2 }, violations: [] };
    expect(validFinding(f, 'r')).toEqual(f);
    expect(rule([f])?.status).toBe('pass');
  });
});

describe('required gates: a missing or n/a required gate is unproven', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map(removeTmp));
  });
  const gate = (name: string, r: GateResult): PluginRecord<GatePlugin> => ({
    plugin: { kind: 'gate', name, phases: ['finish', 'ship'], run: async () => r }, file: `plugins/gates/${name}.ts`, sha256: 'x',
  });
  const pass: GateResult = { status: 'pass', summary: 'ok' };
  async function ctx(task = brownfieldTask()): Promise<RunContext> {
    const h = await makeHarness({ label: 'required-gates', task });
    dirs.push(h.dir);
    return h.ctx;
  }

  it('per task kind and phase', () => {
    expect(requiredGates(brownfieldTask(), 'finish')).toEqual(['tests-green', 'observed-red', 'scope', 'orphans', 'standards', 'contract-lock']);
    expect(requiredGates(greenfieldTask(), 'ship')).toEqual(['tests-green', 'observed-red', 'scope', 'orphans', 'standards', 'spec-coverage', 'secrets']);
    expect(requiredGates({ ...greenfieldTask(), brief: 'b', specCoverage: 'human' }, 'finish')).not.toContain('spec-coverage');
  });

  it('a disabled (unregistered) required gate and a required gate saying n/a make the run not ok', async () => {
    const c = await ctx();
    const required = requiredGates(c.task, 'finish');
    const all = required.map((n) => gate(n, pass));
    const missing = await runGates(all.filter((g) => g.plugin.name !== 'observed-red'), c, 'finish', { required });
    expect(missing.ok).toBe(false);
    expect(missing.results.find((r) => r.gate === 'observed-red')).toMatchObject({ status: 'unproven' });
    const na = await runGates(all.map((g) => (g.plugin.name === 'contract-lock' ? gate('contract-lock', { status: 'n/a', summary: 'skipped' }) : g)), c, 'finish', { required });
    expect(na.ok).toBe(false);
    expect(na.results.find((r) => r.gate === 'contract-lock')?.summary).toContain('required gate reported n/a');
  });

  it('legitimate: every required gate registered and passing is ok', async () => {
    const c = await ctx();
    const required = requiredGates(c.task, 'finish');
    expect((await runGates(required.map((n) => gate(n, pass)), c, 'finish', { required })).ok).toBe(true);
  });
});

describe("the run's own UNPROVEN items block DONE", () => {
  const sandboxed = { mode: 'auto', mechanism: 'sandbox-exec', policy: 'p' } as unknown as Parameters<typeof runUnprovenItems>[0]['isolation'];
  const off = { mode: 'off', mechanism: 'none', policy: 'p' } as unknown as Parameters<typeof runUnprovenItems>[0]['isolation'];

  it('isolation off, unsupported target parts and a crashed standards report are each UNPROVEN', () => {
    expect(runUnprovenItems({ isolation: off, targetNotes: [], checksCrashed: false })).toEqual(['isolation: off (agent code ran unconfined)']);
    expect(runUnprovenItems({ isolation: sandboxed, targetNotes: ['runner mocha is not supported'], checksCrashed: true }))
      .toEqual(['target: runner mocha is not supported', 'checks: the standards report could not be produced']);
    expect(notDoneReason('done', 'done', true, ['isolation: off (agent code ran unconfined)'])).toBe('UNPROVEN: isolation: off (agent code ran unconfined)');
    expect(notDoneReason('max_turns', 'max_turns', false, [])).toBe('loop ended max_turns');
  });

  it('legitimate: a sandboxed run on a fully supported target has none', () => {
    expect(runUnprovenItems({ isolation: sandboxed, targetNotes: [], checksCrashed: false })).toEqual([]);
  });
});

describe('source-boundary: production code may not detect the test runner', () => {
  const reads = [
    'export const t = process.env.VITEST;',
    "export const t = process.env['VITEST_WORKER_ID'];",
    'export const t = process.env.JEST_WORKER_ID;',
    "export const t = process.env.NODE_ENV === 'test';",
    "export const t = 'test' !== process.env.NODE_ENV;",
    "export function f() { switch (process.env.NODE_ENV) { case 'test': return 1; default: return 2; } }",
    "export const t = 'VITEST' in process.env;",
    'const { VITEST } = process.env; export const t = VITEST;',
    'export const t = import.meta.env.MODE;',
    'export const t = import.meta.env.VITEST;',
    'export const t = import.meta.vitest;',
  ];
  it.each(reads)('a new read is a violation: %s', (src) => {
    const v = newBoundaryViolations('src/app.ts', 'export const t = 1;\n', src);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.message).toContain('tells the code it runs under a test runner');
  });

  it('a read present before the write stays allowed; ordinary env reads are fine', () => {
    const legacy = "export const quiet = process.env.NODE_ENV === 'test';\n";
    expect(newBoundaryViolations('src/app.ts', legacy, `${legacy}export const port = 1;\n`)).toEqual([]);
    expect(newBoundaryViolations('src/app.ts', null, "export const port = process.env.PORT ?? '3000';\nexport const prod = process.env.NODE_ENV === 'production';\n")).toEqual([]);
  });
});

describe('contract diff: what the extraction cannot see is unproven', () => {
  const ep = (over: Partial<ContractEndpoint> = {}): ContractEndpoint => ({
    method: 'GET', path: '/v1/x', request: {}, responses: { '200': { type: 'object' } }, sources: {}, statuses: [200], handlerHash: 'h1', ...over,
  });
  const contract = (e: ContractEndpoint, extra: Partial<Contract> = {}): Contract => ({ endpoints: [e], extractedWith: 'runtime', warnings: [], ...extra });

  it('unresolved / dynamic registrations on either side are unproven', () => {
    const unanalysed = [{ location: 'src/app.ts:3:1', message: 'route registered with a computed method' }];
    expect(diffContracts(contract(ep(), { unanalysed }), contract(ep())).unproven).toHaveLength(1);
    expect(diffContracts(contract(ep()), contract(ep(), { unanalysed })).unproven).toHaveLength(1);
  });

  it('a changed handler with opaque query/params, a non-literal status or unmodelled chain parts is unproven', () => {
    const changed = { handlerHash: 'h2' };
    expect(diffContracts(contract(ep()), contract(ep({ ...changed, opaque: ['query'] }))).unproven.map((c) => c.location)).toEqual(['GET /v1/x query']);
    expect(diffContracts(contract(ep({ method: 'DELETE', opaque: ['params'] })), contract(ep({ method: 'DELETE', ...changed, opaque: ['params'] }))).unproven).toHaveLength(1);
    expect(diffContracts(contract(ep()), contract(ep({ ...changed, dynamicStatus: true }))).unproven[0]?.message).toContain('non-literal status');
    expect(diffContracts(contract(ep()), contract(ep({ ...changed, unknowns: ['the middleware x is library code'] }))).unproven[0]?.message).toContain('does not model');
  });

  it('legitimate: the same reads in an unchanged handler, and a clean changed handler, prove nothing new is unproven', () => {
    const same = ep({ opaque: ['query', 'params'], dynamicStatus: true });
    expect(diffContracts(contract(same), contract(same)).unproven).toEqual([]);
    expect(diffContracts(contract(ep()), contract(ep({ handlerHash: 'h2' }))).unproven).toEqual([]);
  });

  it('static fallback: an unchanged schema text is no proof when its walk met code it cannot follow', () => {
    const slot = { request: { query: null }, sources: { query: 's1' } };
    expect(diffContracts(contract(ep(slot)), contract(ep({ ...slot, unfollowed: { query: 'FunctionDeclaration refineX' } }))).unproven[0]?.message)
      .toContain('depends on code the harness cannot follow (FunctionDeclaration refineX)');
    expect(diffContracts(contract(ep(slot)), contract(ep(slot))).unproven).toEqual([]);
  });
});

describe('schemaSource: what the hash walk cannot follow', () => {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `schema-walk-${randomBytes(4).toString('hex')}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  function walk(src: string): string[] {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `s${randomBytes(3).toString('hex')}.ts`);
    writeFileSync(file, src);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
    const sf = program.getSourceFile(file);
    const decl = sf?.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => ts.isIdentifier(d.name) && d.name.text === 'schema');
    if (decl?.initializer === undefined) throw new Error('no schema const');
    return schemaSource(program.getTypeChecker(), decl.initializer).unfollowed;
  }

  it('destructured bindings, variables without initializer, unresolved imports and the depth limit are reported', () => {
    expect(walk('const all = { a: 1 };\nconst { a } = all;\nexport const schema = { a };\n')).toEqual(['BindingElement a']);
    expect(walk('let late: number;\nlate = 1;\nexport const schema = { late };\n')).toEqual(['VariableDeclaration late']);
    expect(walk("import { nope } from './does-not-exist.ts';\nexport const schema = { x: nope };\n")).toEqual(['unresolved import nope']);
    const chain = Array.from({ length: 10 }, (_, i) => `const c${i} = ${i === 0 ? '1' : `c${i - 1}`};`).join('\n');
    expect(walk(`${chain}\nexport const schema = { c: c9 };\n`)).toEqual(['depth limit at c1']);
  });

  it('legitimate: consts, functions, classes, enums, inline arrows and types are followed completely', () => {
    expect(walk('type T = { a: number };\nconst base = { a: 1 };\nconst more = { ...base, b: 2 };\nexport const schema = { more, check: (v: T) => v.a > 0, n: more.b };\n')).toEqual([]);
    expect(walk('function check(v: number) { return v > 0; }\nenum Status { A = "a" }\nclass S { static shape = { a: 1 }; }\nexport const schema = { refine: check, s: Status.A, shape: S.shape };\n')).toEqual([]);
  });

  it('a function body is part of the hashed text: changing it changes the hash', () => {
    mkdirSync(dir, { recursive: true });
    const text = (body: string): string => {
      const file = join(dir, `t${randomBytes(3).toString('hex')}.ts`);
      writeFileSync(file, `function check(v: number) { ${body} }\nexport const schema = { refine: check };\n`);
      const program = ts.createProgram([file], { strict: true, noEmit: true });
      const decl = program.getSourceFile(file)?.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations])[0];
      if (decl?.initializer === undefined) throw new Error('no schema');
      return schemaSource(program.getTypeChecker(), decl.initializer).text;
    };
    expect(text('return v > 0;')).not.toBe(text('return v >= 0;'));
  });
});

describe('spec-coverage opt-out in the task schema', () => {
  it('specCoverage: human is accepted on a brief-only greenfield task', () => {
    const t = normalizeTask({ kind: 'greenfield', id: 'notes', title: 'Notes', output: 'out', brief: 'A notes API.', specCoverage: 'human' }, { strict: true }).task;
    expect(t).toMatchObject({ kind: 'greenfield', specCoverage: 'human' });
    const lenient = normalizeTask({ kind: 'greenfield', id: 'notes', title: 'Notes', brief: 'A notes API.', spec_coverage: 'Human' }).task;
    expect(lenient).toMatchObject({ specCoverage: 'human' });
  });

  it('is rejected on a task with resources, and anything but human is rejected', () => {
    const resources = [{ name: 'note', fields: [{ name: 'text', type: 'string' }] }];
    expect(() => normalizeTask({ kind: 'greenfield', id: 'n', title: 'N', output: 'o', resources, specCoverage: 'human' }, { strict: true })).toThrow(/specCoverage/);
    expect(() => normalizeTask({ kind: 'greenfield', id: 'n', title: 'N', output: 'o', brief: 'b', specCoverage: 'none' }, { strict: true })).toThrow(/specCoverage/);
  });
});
