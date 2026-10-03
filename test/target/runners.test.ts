/**
 * Runner adapter: every variant runs with the runner its profile names (vitest live, node:test live,
 * jest from a recorded --json report because jest is not installed in the harness), and each report is
 * normalised into the same observations: a real failing assertion on source counts as red and maps to
 * that source, a green file reports every case, and a red that does not exercise source is rejected.
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { computeTargetProfile } from '../../src/core/target.ts';
import type { TargetProfile, TestRunnerInfo } from '../../src/core/target.ts';
import { REPORT_CHANNEL, runTargetTests } from '../../src/core/testing.ts';
import type { Exec, ExecOptions, LogStore, TestObservation, TestRunReport } from '../../src/core/types.ts';
import { scratch, VARIANTS, writeTree } from './_variants.ts';
import type { Variant } from './_variants.ts';

const tmp = scratch('runners');
afterAll(() => tmp.cleanup());

const logs: LogStore = {
  async write(name, content) {
    const dir = join(tmp.dir, 'logs');
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${name}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await writeFile(p, content);
    return p;
  },
};

function obs(report: TestRunReport, file: string): TestObservation {
  const o = report.observations.find((x) => x.file === file);
  if (o === undefined) throw new Error(`no observation for ${file}:\n${report.summary}`);
  return o;
}

async function setup(v: Variant, extra: Record<string, string> = {}): Promise<{ root: string; p: TargetProfile }> {
  const root = join(tmp.dir, v.name.replace(/[^a-z0-9]+/gi, '-'));
  writeTree(root, { ...v.files, ...extra });
  return { root, p: await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT }) };
}

describe.each(VARIANTS.filter((v) => v.live))('live runner: $name', (v) => {
  it('red counts and maps to its source; green reports every case', async () => {
    const { root, p } = await setup(v);
    expect(p.runner).toMatchObject({ kind: v.runner, supported: true });
    const report = await runTargetTests({ root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(report.totals, report.summary).toEqual({ files: 2, tests: 3, passed: 2, failed: 1 });

    const red = obs(report, v.red.test);
    expect(red.status, red.reason).toBe('fail');
    expect(red.failed).toBe(1);
    const redCase = red.cases?.find((c) => c.name === 'add > adds (red)');
    expect(redCase?.status).toBe('fail');
    // node:assert idioms (assert.equal) are the assertion-idiom rule's business, not the runner adapter's:
    // only the expect()-style variants are asserted to count here.
    if (v.runner !== 'node-test') {
      expect(red.validRed, red.reason).toBe(true);
      expect(redCase?.exercisesSource).toBe(true);
    }

    const green = obs(report, v.green.test);
    expect(green.status, green.reason).toBe('pass');
    expect(green.cases?.map((c) => [c.name, c.status])).toEqual(v.green.cases.map((c) => [c, 'pass']));
    expect(report.ok).toBe(false); // one red file
    const onlyGreen = await runTargetTests({ root, files: [v.green.test], exec, harnessRoot: HARNESS_ROOT, logs, turn: 2, runner: p.runner, layout: p });
    expect(onlyGreen.ok, onlyGreen.summary).toBe(true);
    expect(onlyGreen.observations.map((o) => o.file)).toEqual([v.green.test]);
  });
});

describe('negative: a red that does not exercise source never counts', () => {
  it('asserting on a test helper (tests/ support) or on constants is rejected, in a non-template layout', async () => {
    const v = VARIANTS.find((x) => x.name.startsWith('tests/'));
    if (v === undefined) throw new Error('tests/ variant missing');
    const { root, p } = await setup(v, {
      'tests/helper-red.test.ts': "import { expect, it } from 'vitest';\nimport { make } from './helpers.ts';\nit('helper', () => {\n  expect(make()).toBe(3);\n});\n",
      'tests/const-red.test.ts': "import { expect, it } from 'vitest';\nimport { add } from '../src/math.ts';\nit('const', () => {\n  void add;\n  expect(1).toBe(2);\n});\n",
    });
    const report = await runTargetTests({ root, files: ['tests/helper-red.test.ts', 'tests/const-red.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    const helper = obs(report, 'tests/helper-red.test.ts');
    expect(helper).toMatchObject({ status: 'fail', validRed: false });
    expect(helper.reason).toContain('red rejected: the failing cases do not assert on anything imported from src/');
    expect(obs(report, 'tests/const-red.test.ts')).toMatchObject({ status: 'fail', validRed: false });
  });

  it('a lib/ API: a missing lib/ module imported by a source-asserting case is red; a missing test helper is not', async () => {
    const v = VARIANTS.find((x) => x.name.startsWith('src renamed'));
    if (v === undefined) throw new Error('lib/ variant missing');
    const { root, p } = await setup(v, {
      'test/missing.test.ts': "import { expect, it } from 'vitest';\nimport { sub } from '../lib/sub.ts';\nit('sub', () => {\n  expect(sub(2, 1)).toBe(1);\n});\n",
      'test/helper-missing.test.ts': "import { expect, it } from 'vitest';\nimport { h } from './nope.ts';\nit('h', () => {\n  expect(h()).toBe(1);\n});\n",
    });
    const report = await runTargetTests({ root, files: ['test/missing.test.ts', 'test/helper-missing.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(obs(report, 'test/missing.test.ts')).toMatchObject({ status: 'error', validRed: true, reason: 'imports lib/sub.ts, which does not exist yet' });
    expect(obs(report, 'test/helper-missing.test.ts')).toMatchObject({ status: 'error', validRed: false });
  });
});

describe('jest adapter (recorded --json report; jest itself is not installed)', () => {
  const jest = VARIANTS.find((v) => v.runner === 'jest');
  if (jest === undefined) throw new Error('jest variant missing');

  it('an unsupported runner runs nothing and says why (UNPROVEN), before any exec', async () => {
    const { root, p } = await setup(jest);
    const calls: string[] = [];
    const spy: Exec = (cmd, args, opts) => {
      calls.push(cmd);
      return exec(cmd, args, opts);
    };
    const report = await runTargetTests({ root, exec: spy, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(calls).toEqual([]);
    expect(report).toMatchObject({ ok: false, observations: [], totals: { files: 0, tests: 0, passed: 0, failed: 0 } });
    expect(report.summary).toMatch(/^tests: not run \(UNPROVEN\): unsupported test runner jest: jest is not installed/);
  });

  it('runs `node <jest bin> --json` over the private channel, sandboxed, and normalises the report', async () => {
    const { root, p } = await setup(jest, {
      'src/__tests__/load.test.ts': "import { sub } from '../missing';\ndescribe('sub', () => {\n  it('subtracts', () => {\n    expect(sub(2, 1)).toBe(1);\n  });\n});\n",
    });
    const recorded = readFileSync(join(HARNESS_ROOT, 'test', 'fixtures', 'runners', 'jest-report.json'), 'utf8').replaceAll('<ROOT>', root);
    const calls: Array<{ cmd: string; args: string[]; opts: ExecOptions }> = [];
    const fake: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 1, stdout: '', stderr: 'FAIL src/__tests__/red.test.ts\n', channel: recorded, durationMs: 5, timedOut: false };
    };
    const runner: TestRunnerInfo = { ...p.runner, supported: true, bin: '/opt/jest/bin/jest.js', version: '29.7.0', origin: 'target' };
    const files = ['src/__tests__/red.test.ts', 'src/__tests__/green.test.ts', 'src/__tests__/load.test.ts'];
    const report = await runTargetTests({ root, files, exec: fake, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner, layout: p });

    const call = calls[0];
    expect(call?.cmd).toBe(process.execPath);
    expect(call?.args.slice(0, 1)).toEqual(['/opt/jest/bin/jest.js']);
    expect(call?.args).toEqual(expect.arrayContaining(['--json', `--outputFile=${REPORT_CHANNEL}`, '--testLocationInResults', '--ci']));
    // never in band: tests run in jest workers, which do not hold the report channel
    expect(call?.args).toEqual(expect.arrayContaining(['--maxWorkers=2', '--workerIdleMemoryLimit=4GB']));
    expect(call?.args.slice(call.args.indexOf('--runTestsByPath'))).toEqual(['--runTestsByPath', ...files]);
    expect(call?.opts.channel).toBe(true);
    expect(call?.opts.sandbox?.network).toBe('localhost');
    expect(call?.opts.sandbox?.writable).toHaveLength(1);

    expect(report.totals).toEqual({ files: 3, tests: 3, passed: 2, failed: 1 });
    // red through jest's moduleNameMapper alias (@/math) counts and is tied to src/math.ts
    const red = obs(report, 'src/__tests__/red.test.ts');
    expect(red).toMatchObject({ status: 'fail', validRed: true });
    expect(red.cases).toEqual([expect.objectContaining({ name: 'add > adds (red)', status: 'fail', exercisesSource: true })]);
    const green = obs(report, 'src/__tests__/green.test.ts');
    expect(green.cases?.map((c) => [c.name, c.status])).toEqual([['add > adds two', 'pass'], ['add > adds zero', 'pass']]);
    // jest's "Cannot find module '../missing' from '…'" is a missing-source red
    expect(obs(report, 'src/__tests__/load.test.ts')).toMatchObject({ status: 'error', validRed: true, reason: 'imports src/missing.ts, which does not exist yet' });
    expect(report.summary).toContain('FAIL src/__tests__/red.test.ts > add > adds (red): expect(received).toBe(expected)');
  });
});
