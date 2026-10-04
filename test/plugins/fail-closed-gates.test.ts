/**
 * Fail-closed gates: every bypass below used to end green (pass / n/a); each now yields unproven or fail,
 * and its legitimate twin still passes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GatePlugin, RunContext, TestCaseObservation, TestRunReport } from '../../src/core/plugin-api.ts';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import secretsGate, { binaryDiffFiles } from '../../plugins/gates/secrets.ts';
import specCoverageGate from '../../plugins/gates/spec-coverage.ts';
import testsGreen from '../../plugins/gates/tests-green.ts';
import { recordUnlocked } from '../../plugins/lib/red.ts';
import { brownfieldTask, greenfieldTask, makeHarness, realExec, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(opts: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = await makeHarness({ label: 'fail-closed', ...opts });
  dirs.push(h.dir);
  return h;
}
type H = Awaited<ReturnType<typeof harness>>;

const run = (g: GatePlugin, ctx: RunContext, phase: 'finish' | 'ship' = 'finish') => g.run(ctx, phase);

/** One case per observation, body hash = file hash; `extra` adds fields (inverted, presenceOnly) to every case. */
function withCases(h: H, extra: Partial<TestCaseObservation> = {}): void {
  const inner = h.services.runTests;
  h.ctx.services.runTests = async (files) => {
    const report = await inner(files);
    for (const o of report.observations) o.cases = [{ name: 'case', status: o.status, bodyHash: o.hash, exercisesSource: true, constantOnly: false, ...extra }];
    return report;
  };
}

/**
 * The differential runner: the current copy passes; the reverted copy fails only when one of `flipsOn` is among
 * the reverted paths. Records every call's revert list.
 */
function revertRunner(h: H, flipsOn: string[]): string[][] {
  const calls: string[][] = [];
  const copy = async (files: string[], status: 'fail' | 'pass'): Promise<TestRunReport> => ({
    ok: status === 'pass',
    totals: { files: files.length, tests: files.length, passed: 0, failed: 0 },
    observations: await Promise.all(files.map(async (file) => {
      const hash = sha((await h.ws.read(file)) ?? '');
      return {
        file, hash, status, collected: 1, failed: status === 'fail' ? 1 : 0, validRed: false, reason: '', turn: 1, at: '',
        cases: [{ name: 'case', status, bodyHash: hash, exercisesSource: true, constantOnly: false }],
      };
    })),
    summary: '',
    logPath: '',
  });
  h.ctx.services.runTestsReverted = async (files, revert) => {
    calls.push([...revert]);
    return { current: await copy(files, 'pass'), reverted: await copy(files, revert.some((f) => flipsOn.includes(f)) ? 'fail' : 'pass') };
  };
  return calls;
}

/** Observe test/items.test.ts red, then make it pass (the gate's fresh run sees it green). */
async function redThenGreen(h: H, test = 'test/items.test.ts'): Promise<void> {
  h.outcomes.set(test, 'fail');
  await h.ctx.services.runTests();
  h.outcomes.set(test, 'pass');
}

describe('observed-red: proof per changed file (one red case no longer clears every file)', () => {
  const files = {
    'test/items.test.ts': "import { x } from '../src/items.ts';\nimport { y } from '../src/other.ts';\n",
    'src/items.ts': 'export const x = 1;\n',
    'src/other.ts': 'export const y = 1;\n',
  };

  it('a changed file whose own revert flips nothing is unproven, named; each file is reverted alone', async () => {
    const h = await harness({ files });
    withCases(h);
    const calls = revertRunner(h, ['src/items.ts']);
    await redThenGreen(h);
    recordUnlocked(h.ctx.state, 'src/items.ts');
    recordUnlocked(h.ctx.state, 'src/other.ts');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('unproven');
    expect(r.summary).toContain('src/other.ts');
    expect(r.summary).not.toContain('src/items.ts');
    expect(r.details?.[0]).toContain('src/other.ts: test/items.test.ts: "case" also passes with src/other.ts alone at its run-start content');
    expect(calls).toEqual([['src/items.ts'], ['src/other.ts']]);
  });

  it('legitimate: every changed file flips its case on its own revert → pass', async () => {
    const h = await harness({ files });
    withCases(h);
    revertRunner(h, ['src/items.ts', 'src/other.ts']);
    await redThenGreen(h);
    recordUnlocked(h.ctx.state, 'src/items.ts');
    recordUnlocked(h.ctx.state, 'src/other.ts');
    expect(await run(observedRedGate, h.ctx)).toMatchObject({ status: 'pass' });
  });
});

describe('observed-red: no source change, deleted sources', () => {
  const files = { 'test/items.test.ts': "import { x } from '../src/items.ts';\n", 'src/items.ts': 'export const x = 1;\n' };

  it('zero changed source files is unproven, not pass (brownfield: everything equals its run-start hash)', async () => {
    const h = await harness({ files, task: brownfieldTask() });
    withCases(h);
    revertRunner(h, ['src/items.ts']);
    h.ctx.state.initialHashes.set('src/items.ts', sha(files['src/items.ts']));
    h.ctx.state.initialHashes.set('test/items.test.ts', sha('old test'));
    await redThenGreen(h);
    expect(await run(observedRedGate, h.ctx)).toMatchObject({ status: 'unproven', summary: 'no source change to prove: no governed source file changed in this run' });
  });

  it('zero changed source files is unproven on a greenfield run with no source at all', async () => {
    const h = await harness({ files: { 'test/a.test.ts': 'x' } });
    withCases(h);
    await redThenGreen(h, 'test/a.test.ts');
    expect((await run(observedRedGate, h.ctx)).status).toBe('unproven');
  });

  it('a governed file that existed at run start and is gone counts as changed (deleted behind the hook)', async () => {
    const h = await harness({ files, task: brownfieldTask() });
    withCases(h);
    revertRunner(h, ['src/items.ts']);
    h.ctx.state.initialHashes.set('src/items.ts', sha('export const x = 0;\n'));
    h.ctx.state.initialHashes.set('src/gone.ts', sha('export const g = 1;\n'));
    await redThenGreen(h);
    recordUnlocked(h.ctx.state, 'src/items.ts');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details).toContain('src/gone.ts: deleted without passing the observed-red hook (it existed at run start; no write tool removed it)');
  });

  it('legitimate: the same run without the deletion passes', async () => {
    const h = await harness({ files, task: brownfieldTask() });
    withCases(h);
    revertRunner(h, ['src/items.ts']);
    h.ctx.state.initialHashes.set('src/items.ts', sha('export const x = 0;\n'));
    await redThenGreen(h);
    recordUnlocked(h.ctx.state, 'src/items.ts');
    expect((await run(observedRedGate, h.ctx)).status).toBe('pass');
  });
});

describe('observed-red: inverted cases and presence-only missing-module reds are no proof', () => {
  const files = { 'test/items.test.ts': "import { x } from '../src/items.ts';\n", 'src/items.ts': 'export const x = 1;\n' };

  it('an it.fails / test.failing case is never red or green', async () => {
    const h = await harness({ files });
    withCases(h, { inverted: true });
    revertRunner(h, ['src/items.ts']);
    await redThenGreen(h);
    recordUnlocked(h.ctx.state, 'src/items.ts');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toBe('src/items.ts: test/items.test.ts: never red');
  });

  it('a missing-module red whose case only asserts presence (toBeDefined) does not prove a new file', async () => {
    const h = await harness({ files });
    withCases(h, { presenceOnly: true });
    revertRunner(h, ['src/items.ts']);
    h.outcomes.set('test/items.test.ts', 'error');
    await h.ctx.services.runTests();
    for (const o of h.ctx.state.tests) o.validRed = true;
    h.outcomes.set('test/items.test.ts', 'pass');
    recordUnlocked(h.ctx.state, 'src/items.ts');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toContain('only a missing-module red on presence-only assertions');
  });

  it('legitimate: the same missing-module red with a value assertion proves the new file', async () => {
    const h = await harness({ files });
    withCases(h);
    revertRunner(h, ['src/items.ts']);
    h.outcomes.set('test/items.test.ts', 'error');
    await h.ctx.services.runTests();
    for (const o of h.ctx.state.tests) o.validRed = true;
    h.outcomes.set('test/items.test.ts', 'pass');
    recordUnlocked(h.ctx.state, 'src/items.ts');
    expect((await run(observedRedGate, h.ctx)).status).toBe('pass');
  });
});

describe('tests-green: exit code, inverted cases, test files the runner did not report', () => {
  const files = { 'test/a.test.ts': 'x', 'test/b.test.ts': 'y' };

  function withExit(h: H, exit: TestRunReport['exit'], extra: Partial<TestCaseObservation> = {}): void {
    const inner = h.services.runTests;
    h.ctx.services.runTests = async (f) => {
      const report = await inner(f);
      for (const o of report.observations) o.cases = [{ name: 'case', status: o.status, bodyHash: o.hash, exercisesSource: true, constantOnly: false, ...extra }];
      return exit === undefined ? report : { ...report, exit };
    };
  }

  it('every case passed but the runner exited 1 (an unhandled rejection): unproven', async () => {
    const h = await harness({ files });
    withExit(h, { code: 1, timedOut: false });
    const r = await run(testsGreen, h.ctx);
    expect(r.status).toBe('unproven');
    expect(r.summary).toContain('the runner exited 1 although no test case failed');
  });

  it('a timed-out runner or a report saying success: false is unproven too', async () => {
    const h = await harness({ files });
    withExit(h, { code: null, timedOut: true });
    expect((await run(testsGreen, h.ctx)).summary).toContain('the runner timed out');
    withExit(h, { code: 0, timedOut: false, success: false });
    expect((await run(testsGreen, h.ctx)).summary).toContain('success: false');
  });

  it('legitimate: exit 0 with success: true passes', async () => {
    const h = await harness({ files });
    withExit(h, { code: 0, timedOut: false, success: true });
    expect(await run(testsGreen, h.ctx)).toMatchObject({ status: 'pass', summary: '2/2 tests passed in 2 files' });
  });

  it('an inverted case (it.fails) makes the suite unproven', async () => {
    const h = await harness({ files });
    withExit(h, { code: 0, timedOut: false }, { inverted: true });
    const r = await run(testsGreen, h.ctx);
    expect(r.status).toBe('unproven');
    expect(r.details).toContain('inverted: test/a.test.ts > case');
  });

  it('a test file the runner globs collect but the run did not report is unproven', async () => {
    const h = await harness({ files: { ...files, 'src/hidden.test.ts': 'z' } });
    const r = await run(testsGreen, h.ctx);
    expect(r.status).toBe('unproven');
    expect(r.details).toContain('not run: src/hidden.test.ts');
  });

  it('brownfield: a file that existed at run start and was not reported then either is pre-existing (not blocking, listed)', async () => {
    const h = await harness({ files: { ...files, 'src/hidden.test.ts': 'z' }, task: brownfieldTask() });
    h.ctx.state.initialHashes.set('src/hidden.test.ts', sha('z'));
    h.ctx.state.testBaseline = {
      at: '', totals: { files: 2, tests: 2, passed: 2, failed: 0 }, skipped: [], failed: [], loadErrors: [], files: ['test/a.test.ts', 'test/b.test.ts'],
    };
    const r = await run(testsGreen, h.ctx);
    expect(r.status).toBe('pass');
    expect(r.humanMustVerify).toEqual(['pre-existing test file not run by the runner (also not at run start): src/hidden.test.ts']);
  });
});

describe('spec-coverage: a free-text greenfield task is unproven unless it opts out', () => {
  it('no resources, no opt-out → unproven (never n/a)', async () => {
    const h = await harness({ task: { ...greenfieldTask(), brief: 'An API for notes.' } });
    expect((await run(specCoverageGate, h.ctx)).status).toBe('unproven');
  });

  it('specCoverage: human → n/a, listed for a human', async () => {
    const h = await harness({ task: { ...greenfieldTask(), brief: 'An API for notes.', specCoverage: 'human' } });
    const r = await run(specCoverageGate, h.ctx);
    expect(r.status).toBe('n/a');
    expect(r.humanMustVerify?.[0]).toContain('behaviour coverage of the free-text brief');
  });
});

describe('secrets: content git would call binary is scanned, never skipped', () => {
  const KEY = `AKIA${'Q'.repeat(16)}`;
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const r = await realExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }

  it('a key next to a NUL byte (untracked and staged) fails the gate', async () => {
    const h = await harness({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    await git(h.dir, 'init', '-q');
    await git(h.dir, 'add', '-A');
    await git(h.dir, 'commit', '-q', '-m', 'init');
    await h.ws.write('src/blob.bin', `\u0000\u0001${KEY}\u0000\n`);
    const untracked = await run(secretsGate, h.ctx, 'ship');
    expect(untracked.status).toBe('fail');
    await git(h.dir, 'add', '-A');
    const staged = await run(secretsGate, h.ctx, 'ship');
    expect(staged.status).toBe('fail');
    expect(staged.details?.join('\n')).toContain('src/blob.bin');
  });

  it('legitimate: binary-looking content without a key passes', async () => {
    const h = await harness({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    await git(h.dir, 'init', '-q');
    await git(h.dir, 'add', '-A');
    await git(h.dir, 'commit', '-q', '-m', 'init');
    await h.ws.write('src/blob.bin', '\u0000\u0001plain bytes\u0000\n');
    await git(h.dir, 'add', '-A');
    expect((await run(secretsGate, h.ctx, 'ship')).status).toBe('pass');
  });

  it('a diff git still reports only as binary is named as unscanned', () => {
    expect(binaryDiffFiles('diff --git a/x b/x\nBinary files a/api/x.png and b/api/x.png differ\n')).toEqual(['api/x.png']);
    expect(binaryDiffFiles('Binary files /dev/null and b/api/new.bin differ')).toEqual(['api/new.bin']);
    expect(binaryDiffFiles('+const a = 1;')).toEqual([]);
  });
});
