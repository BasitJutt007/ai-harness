/**
 * harness.config.json `checkOptions` reach every place a check runs, not only runChecks itself: a run's
 * context (buildContext -> services.runChecks), the standards gate's base-commit measurement (a second
 * runChecks over a snapshot of the base commit), and `harness check`. A recording check proves each
 * one; the twin without options proves the recording is not a constant.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import standardsGate from '../../plugins/gates/standards.ts';
import { cmdCheck, parseArgs } from '../../src/core/cli.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { buildContext } from '../../src/core/run.ts';
import { newRunState, RunStore } from '../../src/core/run-store.ts';
import type { CheckFinding, CheckPlugin, HarnessConfig, RegistryView } from '../../src/core/types.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { brownfieldTask, testConfig } from '../plugins/helpers.ts';

let base: string;
let repo: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'check-options-')));
  repo = join(base, 'api');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base'], { cwd: repo });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const OPTIONS = { names: ['RequireAdmin'] };

/** A lint check that records the root and options of every run, and fails each file (so the gate measures the base commit). */
function recorder(seen: Array<{ root: string; options: unknown }>): CheckPlugin {
  return {
    kind: 'check',
    id: 'recorder',
    category: 'lint',
    unit: 'files',
    async run(c) {
      seen.push({ root: c.root, options: structuredClone(c.options) });
      return c.sourceFiles.map((f): CheckFinding => ({ rule: 'recorder', file: f, status: 'fail', units: { passed: 0, total: 1 }, violations: [{ location: `${f}:1:1`, message: 'recorded' }] }));
    },
  };
}

function registryWith(check: CheckPlugin): RegistryView {
  return { drivers: [], tools: [], hooks: [], gates: [], checks: [{ plugin: check, file: 'test/recorder.ts', sha256: '0' }], errors: [] };
}

function configWith(checkOptions: HarnessConfig['checkOptions']): HarnessConfig {
  return { ...testConfig, checkOptions };
}

async function gateRun(checkOptions: HarnessConfig['checkOptions']): Promise<Array<{ root: string; options: unknown }>> {
  const seen: Array<{ root: string; options: unknown }> = [];
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const runDir = join(base, 'run');
  const ctx = buildContext({
    run: { id: 'r1', driver: 'fake', model: 'm', startedAt: new Date().toISOString(), harnessRoot: HARNESS_ROOT, runDir, branch: 'harness/r1', baseBranch: 'main', baseSha },
    task: { ...brownfieldTask(), standards: 'baseline' },
    ws: createWorkspace(repo, '.'),
    state: newRunState(),
    store: new RunStore(runDir, base),
    mode: { jit: true, compactReturns: true, compactHistory: true },
    config: configWith(checkOptions),
    registry: registryWith(recorder(seen)),
    exec,
  });
  const r = await standardsGate.run(ctx, 'finish');
  // the violation was there at the base commit too: pre-existing, so the gate passes in baseline mode
  expect(r.status, JSON.stringify(r)).toBe('pass');
  return seen;
}

describe('checkOptions reach the checks of a run (buildContext) and of the standards gate\'s base-commit run', () => {
  it('both the run\'s own report and the base-commit snapshot report hand the check its options', async () => {
    const seen = await gateRun({ recorder: OPTIONS, other: { x: 1 } });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.root).toBe(repo);
    expect(seen[1]?.root).not.toBe(repo); // the snapshot of the base commit
    expect(seen.map((s) => s.options)).toEqual([OPTIONS, OPTIONS]);
  });

  it('the twin: without an entry for the check, neither run hands it options', async () => {
    const seen = await gateRun({});
    expect(seen.map((s) => s.options)).toEqual([undefined, undefined]);
  });
});

describe('harness check hands config.checkOptions to the checks', () => {
  async function check(checkOptions: HarnessConfig['checkOptions']): Promise<unknown[]> {
    const seen: Array<{ root: string; options: unknown }> = [];
    const parsed = parseArgs(['--api', repo, '--rule', 'recorder']);
    if ('error' in parsed) throw new Error(parsed.error);
    const lines: string[] = [];
    const code = await cmdCheck(parsed, (l) => lines.push(l), async () => ({ config: configWith(checkOptions), registry: registryWith(recorder(seen)) }));
    expect(code, lines.join('\n')).toBe(1); // the recorder fails every file
    expect(lines.join('\n')).toMatch(/recorder\s+FAIL/);
    return seen.map((s) => s.options);
  }

  it('the configured entry reaches the check', async () => {
    expect(await check({ recorder: OPTIONS })).toEqual([OPTIONS]);
  });

  it('the twin: no entry, no options', async () => {
    expect(await check({})).toEqual([undefined]);
  });
});
