/**
 * Real-model finding F5: a run killed with SIGTERM (a CI timeout, `kill`) wrote no final
 * evidence. SIGTERM is now handled like Ctrl-C: the loop stops after the current step, the
 * evidence (run.json with its final status, events, token report) is written, and the CLI
 * exits 143 (128 + SIGTERM).
 *
 * The real CLI is spawned on a throwaway repo with a slow scripted run (one test run per turn).
 *
 * A second scenario sends SIGTERM after the model's `finish` call, while the finish gates run:
 * the stop must still win (no fresh final gates or checks, no --ship, run.json `aborted`, exit 143),
 * not be swallowed by the accepted finish.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git, readEvents, readRunJson, ROOT, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from './helpers.ts';

let tmp: TempRepo;
let child: ChildProcess | undefined;
let exit: { code: number | null; signal: NodeJS.Signals | null };
let stdout = '';
let runDir = '';

/** Resolves when `check` returns true (polled), rejects after `ms`. */
async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the run to start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startedRunDir(): string | null {
  if (!existsSync(tmp.runsDir)) return null;
  for (const d of readdirSync(tmp.runsDir)) {
    const events = join(tmp.runsDir, d, 'events.jsonl');
    if (existsSync(events) && /"kind":"tool"/.test(readFileSync(events, 'utf8'))) return join(tmp.runsDir, d);
  }
  return null;
}

beforeAll(async () => {
  tmp = tempRepo('sigterm');
  const script = join(tmp.dir, 'slow.json');
  const turns = Array.from({ length: 40 }, () => ({ calls: [{ name: 'run_tests', input: {} }] }));
  writeFileSync(script, JSON.stringify({ description: 'slow: one full test run per turn', turns }));
  child = spawn(process.execPath, [join(ROOT, 'bin', 'harness.mjs'), 'run', USERS_TASK, '--driver', 'scripted', '--driver-opt', `script=${script}`, '--repo', tmp.repo], {
    cwd: ROOT,
    env: { ...process.env, HARNESS_RUNS_DIR: tmp.runsDir, HARNESS_TOKENS_DIR: tmp.tokensDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => {
    stdout += b.toString('utf8');
  });
  child.stderr?.on('data', (b: Buffer) => {
    stdout += b.toString('utf8');
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child?.on('exit', (code, signal) => resolve({ code, signal }));
  });
  await until(() => startedRunDir() !== null, 240_000);
  runDir = startedRunDir() ?? '';
  child.kill('SIGTERM');
  exit = await exited;
}, 400_000);

afterAll(() => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
  tmp?.cleanup();
});

describe('SIGTERM during a run', () => {
  it('stops gracefully and exits 143 (not killed by the signal)', () => {
    expect(exit.signal, stdout).toBeNull();
    expect(exit.code, stdout).toBe(143);
    expect(stdout).toMatch(/SIGTERM: stopping after the current step and writing the evidence/);
  });

  it('writes the final evidence: run.json aborted, events, token report', () => {
    const run = readRunJson(runDir);
    expect(run.status).toBe('aborted');
    expect(run.ok).toBe(false);
    expect(run.turns).toBeGreaterThanOrEqual(1);
    expect(run.turns).toBeLessThan(40);
    expect(run.honesty.unproven.join('\n')).toMatch(/aborted/);
    expect(readEvents(runDir).length).toBeGreaterThan(0);
    expect(existsSync(join(tmp.tokensDir, `${run.runId}.json`))).toBe(true);
  });
});

describe('SIGTERM while the finish gates run (after the finish call)', () => {
  let tmp2: TempRepo;
  let child2: ChildProcess | undefined;
  let exit2: { code: number | null; signal: NodeJS.Signals | null };
  let out2 = '';
  let runDir2 = '';

  /** The run directory whose events hold the `finish` tool event (emitted before the finish gates run). */
  function finishCalled(): string | null {
    if (!existsSync(tmp2.runsDir)) return null;
    for (const d of readdirSync(tmp2.runsDir)) {
      const events = join(tmp2.runsDir, d, 'events.jsonl');
      if (existsSync(events) && /"kind":"tool","source":"finish"/.test(readFileSync(events, 'utf8'))) return join(tmp2.runsDir, d);
    }
    return null;
  }

  beforeAll(async () => {
    tmp2 = tempRepo('sigterm-finish');
    const args = [join(ROOT, 'bin', 'harness.mjs'), 'run', USERS_TASK, '--driver', 'scripted', '--driver-opt', `script=${join(SCRIPTS, 'users-api.json')}`, '--repo', tmp2.repo, '--ship'];
    child2 = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, HARNESS_RUNS_DIR: tmp2.runsDir, HARNESS_TOKENS_DIR: tmp2.tokensDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (b: Buffer): void => {
      out2 += b.toString('utf8');
    };
    child2.stdout?.on('data', collect);
    child2.stderr?.on('data', collect);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child2?.on('exit', (code, signal) => resolve({ code, signal }));
    });
    const end = Date.now() + 240_000;
    while (finishCalled() === null) {
      if (Date.now() > end || child2.exitCode !== null) throw new Error(`the run never reached finish:\n${out2}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    runDir2 = finishCalled() ?? '';
    child2.kill('SIGTERM');
    exit2 = await exited;
  }, 400_000);

  afterAll(() => {
    if (child2 !== undefined && child2.exitCode === null) child2.kill('SIGKILL');
    tmp2?.cleanup();
  });

  it('exits 143, not 0', () => {
    expect(exit2.signal, out2).toBeNull();
    expect(exit2.code, out2).toBe(143);
    expect(out2).toMatch(/SIGTERM: stopping after the current step and writing the evidence/);
  });

  it('records the run as aborted (the loop outcome kept as loopStatus), with no fresh final gates or checks', () => {
    const run = readRunJson(runDir2);
    expect(run.status).toBe('aborted');
    expect(run.ok).toBe(false);
    expect(run['loopStatus']).toBe('done');
    expect(String(run['error'])).toMatch(/^stopped by signal after the loop ended done/);
    expect(run.gates).toEqual([]);
    expect(run['gatesOk']).toBe(false);
    expect(readFileSync(join(runDir2, 'standards.txt'), 'utf8')).toMatch(/not run: the run was aborted/);
    expect(existsSync(join(tmp2.tokensDir, `${run.runId}.json`))).toBe(true);
  });

  it('never ships: --ship is refused with "stopped by signal" and the run branch has no commit', () => {
    const run = readRunJson(runDir2);
    expect(run['ship']).toMatchObject({ status: 'refused', reasons: ['stopped by signal'] });
    const branch = `harness/${run.runId}`;
    expect(git(tmp2.repo, ['rev-parse', branch])).toBe(tmp2.baseSha);
  });
});
