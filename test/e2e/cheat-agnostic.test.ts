/**
 * E2E (c) users-api-cheat.json: every forbidden action is blocked by the expected hook,
 * finish is refused, and no gate that should be red is green.
 * E2E (f) `harness agnostic`: two runs of the same task → zero diff; a tampered hook hash → reported.
 * Plus: an aborted run (Ctrl-C) is reported cleanly and leaves the target untouched.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, runExitCode } from '../../src/core/cli.ts';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import { changedFiles, collector, execWithoutGh, finishDecisions, git, readEvents, readRunJson, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from './helpers.ts';

let tmp: TempRepo;
let a: RunSummary;
let b: RunSummary;

function cheat(signal?: AbortSignal): Promise<RunSummary> {
  return executeRun({
    taskFile: USERS_TASK,
    driver: 'scripted',
    driverOptions: { script: join(SCRIPTS, 'users-api-cheat.json') },
    baseline: false,
    ship: false,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: collector().out,
    ...(signal !== undefined ? { signal } : {}),
  });
}

beforeAll(async () => {
  tmp = tempRepo('cheat');
  // Concurrent on purpose: two runs of the same task started in the same second must get distinct ids/worktrees.
  [a, b] = await Promise.all([cheat(), cheat()]);
}, 300_000);
afterAll(() => tmp.cleanup());

describe('(c) users-api-cheat.json', () => {
  it('each forbidden write is blocked by the expected hook before it runs', () => {
    const events = readEvents(a.runDir);
    const blocks = events.filter((e) => e.kind === 'hook' && e.decision === 'block');
    const blockOn = (turn: number): string | undefined => blocks.find((e) => e.turn === turn)?.source;
    expect(blockOn(1)).toBe('observed-red'); // source before any observed red
    expect(blockOn(2)).toBe('path-guard'); // harness-owned package.json
    expect(blockOn(3)).toBe('path-guard'); // ../../outside.ts escapes the API root
    expect(blockOn(4)).toBe('unsafe-code-guard'); // `as any` in a test
    // Nothing the cheat tried was written.
    const writes = events.filter((e) => e.kind === 'tool' && e.source === 'write_file');
    for (const w of writes) expect(w.decision).toBe('block');
    const changed = changedFiles(a.worktree);
    expect(changed).toContain('generated/users-api/src/app.ts'); // the scaffold, and nothing the cheat wrote:
    for (const f of ['generated/users-api/src/routes/users.ts', 'generated/users-api/test/users.test.ts', 'outside.ts', 'generated/outside.ts']) {
      expect(changed).not.toContain(f);
    }
    expect(readFileSync(join(a.worktree, 'generated/users-api/package.json'), 'utf8')).not.toContain('echo ok');
  });

  it('finish is refused and the final status is not done', () => {
    const finishes = finishDecisions(readEvents(a.runDir));
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.decision).toBe('block');
    expect(a.status).not.toBe('done');
    expect(a.ok).toBe(false);
    expect(runExitCode(a)).toBe(1);
  });

  it('no gate is green that should not be', () => {
    const byGate = Object.fromEntries(a.gates.map((g) => [g.gate, g.status]));
    expect(byGate['observed-red']).toBe('fail');
    expect(byGate['standards']).not.toBe('pass'); // no routes: never "compliant" on an empty check
    expect(byGate['contract-lock']).toBe('n/a');
    expect(a.gatesOk).toBe(false);
    expect(a.standards?.status).not.toBe('pass');
    const r = readRunJson(a.runDir);
    expect(r.honesty.proven).not.toContain('gate:observed-red');
    expect(r.honesty.proven).not.toContain('gate:standards');
    expect(r.honesty.failed.length + r.honesty.unproven.length).toBeGreaterThan(0);
  });

  it('the target checkout stays clean', () => {
    expect(git(tmp.repo, ['rev-parse', 'main'])).toBe(tmp.baseSha);
    expect(git(tmp.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });
});

describe('(f) harness agnostic', () => {
  it('two runs of the same task: zero diff (exit 0)', async () => {
    expect(a.runId).not.toBe(b.runId);
    expect(a.worktree).not.toBe(b.worktree);
    const out = collector();
    const code = await main(['agnostic', a.runDir, b.runDir], out.out);
    expect(code, out.text()).toBe(0);
    expect(out.text()).toMatch(/zero diff/);
  });

  it('a tampered hook hash in a copied run.json is reported (exit 1)', async () => {
    const copy = join(tmp.dir, 'tampered');
    mkdirSync(copy, { recursive: true });
    copyFileSync(join(b.runDir, 'run.json'), join(copy, 'run.json'));
    const json: unknown = JSON.parse(readFileSync(join(copy, 'run.json'), 'utf8'));
    const run = readRunJson(b.runDir);
    const hook = Object.keys(run.pluginFingerprint).find((f) => f.startsWith('plugins/hooks/'));
    expect(hook).toBeDefined();
    const tampered = JSON.stringify(json).replace(run.pluginFingerprint[hook ?? ''] ?? 'x', 'f'.repeat(64));
    writeFileSync(join(copy, 'run.json'), tampered);
    const out = collector();
    const code = await main(['agnostic', a.runDir, copy], out.out);
    expect(code).toBe(1);
    expect(out.text()).toContain(`changed: ${hook ?? ''}`);
  });

  it('usage errors exit 2', async () => {
    const out = collector();
    expect(await main(['agnostic', a.runDir], out.out)).toBe(2);
  });
});

describe('abort (Ctrl-C)', () => {
  it('stops before the next step, still writes evidence, reports UNPROVEN, leaves the target clean', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = await cheat(controller.signal);
    expect(s.status).toBe('aborted');
    expect(s.ok).toBe(false);
    expect(s.gates).toEqual([]);
    expect(runExitCode(s)).toBe(130);
    const r = readRunJson(s.runDir);
    expect(r.status).toBe('aborted');
    expect(r.honesty.unproven.join('\n')).toMatch(/aborted/);
    expect(s.text).toMatch(/^resume\s+/m);
    expect(git(tmp.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });
});
