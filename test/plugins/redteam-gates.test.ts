/**
 * Red team: ways a run could look green without being proven. Each gate must
 * answer fail or unproven, never pass.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckReport, GatePlugin, RunContext, TestObservation, TestRunReport } from '../../src/core/plugin-api.ts';
import { exec } from '../../src/core/exec.ts';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import scopeGate from '../../plugins/gates/scope.ts';
import standardsGate from '../../plugins/gates/standards.ts';
import testsGreen from '../../plugins/gates/tests-green.ts';
import { recordUnlocked } from '../../plugins/lib/red.ts';
import { brownfieldTask, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(opts: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = await makeHarness({ label: 'redteam-gates', ...opts });
  dirs.push(h.dir);
  return h;
}

const run = (g: GatePlugin, ctx: RunContext) => g.run(ctx, 'finish');

function report(over: Partial<TestRunReport> & { totals: TestRunReport['totals'] }, observations: TestObservation[] = []): TestRunReport {
  return { ok: true, observations, summary: 'tests: …', logPath: 'runs/x/logs/vitest.txt', ...over };
}
const o = (file: string, status: TestObservation['status'], collected: number): TestObservation =>
  ({ file, hash: 'h', status, collected, failed: 0, validRed: false, reason: status, turn: 1, at: '' });

describe('tests-green cannot be faked', () => {
  it('a suite that is entirely .skip/.todo is not green (the runner calls it ok)', async () => {
    const h = await harness({ services: { runTests: async () => report({ totals: { files: 1, tests: 3, passed: 0, failed: 0 } }, [o('test/a.test.ts', 'pass', 3)]) } });
    const r = await run(testsGreen, h.ctx);
    expect(r.status).toBe('unproven');
    expect(r.summary).toContain('0 of 3 tests passed');
  });

  it('some skipped tests make the suite unproven, not green', async () => {
    const h = await harness({ services: { runTests: async () => report({ totals: { files: 1, tests: 5, passed: 4, failed: 0 } }, [o('test/a.test.ts', 'pass', 5)]) } });
    expect(await run(testsGreen, h.ctx)).toMatchObject({ status: 'unproven', summary: expect.stringContaining('1 of 5 tests skipped') });
  });

  it('a file that fails to load fails the gate even when every collected test passed', async () => {
    const h = await harness({
      services: {
        runTests: async () => report({ ok: false, totals: { files: 2, tests: 4, passed: 4, failed: 0 } }, [o('test/a.test.ts', 'pass', 4), o('test/b.test.ts', 'error', 0)]),
      },
    });
    expect(await run(testsGreen, h.ctx)).toMatchObject({ status: 'fail', summary: '1 of 2 test files failed to load (4/4 tests passed)' });
  });

  it('a runner that reports failure for an unknown reason is never green', async () => {
    const h = await harness({ services: { runTests: async () => report({ ok: false, totals: { files: 1, tests: 1, passed: 1, failed: 0 } }, [o('test/a.test.ts', 'pass', 1)]) } });
    expect((await run(testsGreen, h.ctx)).status).toBe('fail');
  });
});

describe('standards cannot be green without evidence', () => {
  const base: CheckReport = { root: '/x', findings: [], rules: [], verdict: { status: 'pass', percent: 100 }, text: '', compact: 'verdict 100%' };

  it('a 100% verdict over zero rules (every check disabled) is unproven', async () => {
    const h = await harness({ services: { runChecks: async () => base } });
    expect(await run(standardsGate, h.ctx)).toMatchObject({ status: 'unproven', summary: expect.stringContaining('zero rules') });
  });

  it('a 100% verdict contradicted by a skipped finding or a non-green rule is unproven', async () => {
    const skipped: CheckReport = {
      ...base,
      rules: [{ rule: 'problem-json', category: 'standards', unit: 'error paths', status: 'pass', passed: 3, total: 3, files: 1 }],
      findings: [{ rule: 'problem-json', file: '(runtime)', status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'app did not start' }],
    };
    const h = await harness({ services: { runChecks: async () => skipped } });
    expect(await run(standardsGate, h.ctx)).toMatchObject({ status: 'unproven', details: ['problem-json skipped: app did not start'] });
    const unprovenRule: CheckReport = { ...base, rules: [{ rule: 'tsc-strict', category: 'standards', unit: 'errors', status: 'unproven', passed: 0, total: 0, files: 0 }] };
    const h2 = await harness({ services: { runChecks: async () => unprovenRule } });
    expect((await run(standardsGate, h2.ctx)).status).toBe('unproven');
  });
});

describe('standards: the diff-aware policy cannot be used to hide violations', () => {
  const base: CheckReport = { root: '/x', findings: [], rules: [], verdict: { status: 'pass', percent: 100 }, text: '', compact: 'verdict 100%' };
  const lint = (status: 'pass' | 'fail' | 'n/a') => ({ rule: 'no-console', category: 'lint', unit: 'files', status, passed: 0, total: status === 'n/a' ? 0 : 1, files: 1 });

  it('a report whose every rule is n/a proves nothing (n/a is never green)', async () => {
    const h = await harness({ services: { runChecks: async () => ({ ...base, rules: [lint('n/a')] }) } });
    expect((await run(standardsGate, h.ctx)).status).toBe('unproven');
  });

  it('a 100% verdict contradicted by a failing non-standards rule is unproven', async () => {
    const h = await harness({ services: { runChecks: async () => ({ ...base, rules: [lint('fail')] }) } });
    expect((await run(standardsGate, h.ctx)).status).toBe('unproven');
  });

  it('a violation in a file that did not exist at run start, outside the API root, or with no finding blocks', async () => {
    const failing = (file: string): CheckReport => ({
      ...base,
      verdict: { status: 'fail', percent: 0 },
      rules: [lint('fail')],
      findings: file === '' ? [] : [{ rule: 'no-console', file, status: 'fail', units: { passed: 0, total: 1 }, violations: [{ location: `${file}:1:1`, message: 'console call' }] }],
    });
    for (const file of ['src/new.ts', '/etc/passwd', '../outside.ts', '']) {
      const h = await harness({ files: { 'src/new.ts': 'console.log(1);\n' }, services: { runChecks: async () => failing(file) } });
      expect((await run(standardsGate, h.ctx)).status, file).toBe('fail');
    }
  });

  it('brownfield: a violation in a task-denied file left unchanged is pre-existing, not blocking', async () => {
    const legacy = 'console.log("legacy");\n';
    const h = await harness({
      task: brownfieldTask({ allow: ['src/routes/**/*.ts'], deny: ['src/legacy/**'] }),
      files: { 'src/legacy/old.ts': legacy },
      services: {
        runChecks: async () => ({
          ...base,
          verdict: { status: 'fail', percent: 50 },
          rules: [{ rule: 'zod-boundary', category: 'standards', unit: 'handlers', status: 'pass', passed: 1, total: 1, files: 1 }, lint('fail')],
          findings: [{ rule: 'no-console', file: 'src/legacy/old.ts', status: 'fail', units: { passed: 0, total: 1 }, violations: [{ location: 'src/legacy/old.ts:1:1', message: 'console call' }] }],
        }),
      },
    });
    h.ctx.state.initialHashes.set('src/legacy/old.ts', sha(legacy));
    expect(await run(standardsGate, h.ctx)).toMatchObject({ status: 'pass', details: ['pre-existing (not blocking): no-console src/legacy/old.ts:1:1  console call'] });
  });
});

/** The fake runner's observations, with one case per file whose body hash is the file's hash (edit = new body). */
function withCases(h: Awaited<ReturnType<typeof harness>>, revertStatus: 'fail' | 'pass' = 'fail'): void {
  const inner = h.services.runTests;
  h.ctx.services.runTests = async (files) => {
    const report = await inner(files);
    for (const o of report.observations) {
      o.cases = [{ name: 'case', status: o.status, bodyHash: o.hash, exercisesSource: true, constantOnly: false }];
    }
    return report;
  };
  // The revert check's run (run-start source back in place): by default the case is red again.
  h.ctx.services.runTestsReverted = async (files) => {
    const observations = await Promise.all(files.map(async (file) => {
      const hash = sha((await h.ws.read(file)) ?? '');
      return {
        file, hash, status: revertStatus, collected: 1, failed: revertStatus === 'fail' ? 1 : 0, validRed: false, reason: '', turn: 1, at: '',
        cases: [{ name: 'case', status: revertStatus, bodyHash: hash, exercisesSource: true, constantOnly: false }],
      };
    }));
    return { ok: revertStatus === 'pass', totals: { files: files.length, tests: files.length, passed: 0, failed: 0 }, observations, summary: '', logPath: '' };
  };
}

describe('observed-red gate: nothing changes source behind the hook', () => {
  it('fails when a source file changed without the hook letting it through (e.g. test code wrote it)', async () => {
    const files = { 'test/a.test.ts': "import { a } from '../src/a.ts';\n", 'src/a.ts': 'export const a = 2;\n' };
    const h = await harness({ files, task: brownfieldTask() });
    withCases(h);
    h.ctx.state.initialHashes.set('src/a.ts', sha('export const a = 1;\n'));
    h.outcomes.set('test/a.test.ts', 'fail');
    await h.ctx.services.runTests();
    h.outcomes.set('test/a.test.ts', 'pass');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toContain('src/a.ts: changed without passing the observed-red hook');
    recordUnlocked(h.ctx.state, 'src/a.ts');
    expect((await run(observedRedGate, h.ctx)).status).toBe('pass');
  });

  it('a missing-module red does not cover a file that existed at run start', async () => {
    const t = "import { a } from '../src/a.ts';\n";
    const h = await harness({ files: { 'test/a.test.ts': t, 'src/a.ts': 'export const a = 2;\n' }, task: brownfieldTask() });
    withCases(h);
    h.ctx.state.initialHashes.set('src/a.ts', sha('export const a = 1;\n'));
    h.ctx.state.tests.push({
      file: 'test/a.test.ts', hash: sha(t), status: 'error', collected: 0, failed: 0, validRed: true, reason: 'missing', turn: 1, at: '',
      cases: [{ name: 'case', status: 'error', bodyHash: sha(t), exercisesSource: true, constantOnly: false }],
    });
    recordUnlocked(h.ctx.state, 'src/a.ts');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toBe('src/a.ts: test/a.test.ts: only a missing-module red (the file existed at run start)');
  });

  it('governs non-src TypeScript a broad scope allowed (scripts/x.ts)', async () => {
    const h = await harness({ files: { 'test/a.test.ts': "import { a } from '../src/a.ts';\n", 'src/a.ts': 'x\n', 'scripts/x.ts': 'y\n', 'test/helpers.ts': 'z\n' } });
    withCases(h);
    h.outcomes.set('test/a.test.ts', 'fail');
    await h.ctx.services.runTests();
    h.outcomes.set('test/a.test.ts', 'pass');
    recordUnlocked(h.ctx.state, 'src/a.ts');
    const r = await run(observedRedGate, h.ctx);
    // test support code (test/helpers.ts) is not governed; scripts/x.ts is
    expect(r.details?.[0]).toBe('scripts/x.ts: changed without passing the observed-red hook (not written by a write tool, e.g. modified by test code)');
    expect(r.details).toHaveLength(2);
  });
});

describe('scope gate (real git repo)', () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const r = await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  async function repo(gitignore = '') {
    const h = await harness({ task: brownfieldTask(), exec, files: { 'src/a.ts': 'export const a = 1;\n' } });
    if (gitignore !== '') writeFileSync(path.join(h.dir, '.gitignore'), gitignore);
    await git(h.dir, 'init', '-q');
    await git(h.dir, 'add', '-A');
    await git(h.dir, 'commit', '-q', '-m', 'init');
    return h;
  }

  it("ignores a test runner's node_modules/.vite cache and the harness's node_modules symlink", async () => {
    const h = await repo();
    mkdirSync(path.join(h.ws.root, 'node_modules', '.vite', 'vitest', 'abc'), { recursive: true });
    writeFileSync(path.join(h.ws.root, 'node_modules', '.vite', 'vitest', 'abc', 'results.json'), '{}');
    await h.ws.write('src/a.ts', 'export const a = 2;\n');
    expect(await run(scopeGate, h.ctx)).toMatchObject({ status: 'pass', summary: '1 changed files, all in scope' });
  });

  it('fails when the agent wrote a file git ignores (it would be tested but never shipped)', async () => {
    const h = await repo('logs\n');
    await h.ws.write('src/logs/impl.ts', 'export const x = 1;\n');
    h.ctx.state.written.add('src/logs/impl.ts');
    const r = await run(scopeGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(['api/src/logs/impl.ts: written by the agent but git-ignored, so it would not be shipped; use another path']);
  });

  it('fails on dot-files and build output even when the scope allows every path', async () => {
    const h = await repo();
    h.ctx.task = brownfieldTask({ allow: ['**'], deny: [] });
    await h.ws.write('.husky/pre-commit.ts', 'x');
    await h.ws.write('src/dist/x.ts', 'x');
    const r = await run(scopeGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details).toHaveLength(2);
  });
});
