/**
 * E2E brownfield on a committed throwaway copy of samples/existing-api:
 *  (b) projects-change.json — additive change: done, contract-lock pass, standards 100%.
 *  (d) projects-breaking.json — tests kept green but a response property removed:
 *      contract-lock fails, finish is refused, the run is not done.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import { changedFiles, collector, execWithoutGh, finishDecisions, git, PROJECTS_TASK, readEvents, readRunJson, SAMPLE, SCRIPTS, tempRepo, type TempRepo } from './helpers.ts';

let tmp: TempRepo;

beforeAll(() => {
  // Same layout as the harness repo, so the unmodified task file (target: samples/existing-api) resolves.
  tmp = tempRepo('brownfield', { 'samples/existing-api': SAMPLE });
});
afterAll(() => tmp.cleanup());

async function run(script: string): Promise<RunSummary> {
  return executeRun({
    taskFile: PROJECTS_TASK,
    driver: 'scripted',
    driverOptions: { script: join(SCRIPTS, script) },
    baseline: false,
    ship: false,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: collector().out,
  });
}

describe('(b) additive change: projects-change.json', () => {
  let s: RunSummary;
  beforeAll(async () => {
    s = await run('projects-change.json');
  }, 300_000);

  it('is done with every gate green, contract-lock included', () => {
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('done');
    expect(s.ok).toBe(true);
    const lock = s.gates.find((g) => g.gate === 'contract-lock');
    expect(lock?.status, lock?.summary).toBe('pass');
    expect(lock?.summary).toMatch(/additive/);
    for (const g of s.gates) expect(g.status, `${g.gate}: ${g.summary}`).toBe('pass');
    expect(s.standards).toEqual({ status: 'pass', percent: 100 });
  });

  it('API root is the copied sample; the target checkout stays clean', () => {
    expect(s.worktree).not.toBe(tmp.repo);
    expect(git(tmp.repo, ['rev-parse', 'main'])).toBe(tmp.baseSha);
    expect(git(tmp.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const changed = changedFiles(s.worktree);
    expect(changed.length).toBeGreaterThan(0);
    for (const f of changed) expect(f.startsWith('samples/existing-api/'), f).toBe(true);
  });

  it('honesty: all proven, nothing unproven or n/a', () => {
    const r = readRunJson(s.runDir);
    expect(r.honesty.proven).toContain('gate:contract-lock');
    expect(r.honesty.unproven).toEqual([]);
    expect(r.honesty.failed).toEqual([]);
  });
});

describe('(d) breaking change with green tests: projects-breaking.json', () => {
  let s: RunSummary;
  beforeAll(async () => {
    s = await run('projects-breaking.json');
  }, 300_000);

  it('observes red then green, but contract-lock fails and finish is refused', () => {
    const events = readEvents(s.runDir);
    const finishes = finishDecisions(events);
    expect(finishes.length).toBeGreaterThan(0);
    for (const f of finishes) expect(f.decision).toBe('block');
    expect(finishes[0]?.message).toMatch(/FINISH REFUSED/);
    const lockEvents = events.filter((e) => e.kind === 'gate' && e.source === 'contract-lock');
    expect(lockEvents.length).toBeGreaterThan(0);
    for (const e of lockEvents) expect(e.decision).toBe('block');
  });

  it('final status is not done; contract-lock fails with the removed property; tests stay green', () => {
    expect(s.status).not.toBe('done');
    expect(s.ok).toBe(false);
    const byGate = Object.fromEntries(s.gates.map((g) => [g.gate, g]));
    expect(byGate['contract-lock']?.status).toBe('fail');
    expect((byGate['contract-lock']?.details ?? []).join('\n')).toMatch(/description/);
    expect(byGate['tests-green']?.status).toBe('pass');
    expect(byGate['observed-red']?.status).toBe('pass');
    const r = readRunJson(s.runDir);
    expect(r.honesty.failed.some((f) => f.startsWith('gate:contract-lock'))).toBe(true);
    expect(r.honesty.proven).not.toContain('gate:contract-lock');
    expect(s.text).toMatch(/^verdict\s+NOT DONE/m);
  });
});
