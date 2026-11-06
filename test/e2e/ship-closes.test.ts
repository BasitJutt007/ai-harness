/**
 * An item shipped by `harness run --ship` closes (the bug: it never could). The run's `run` ledger entry used
 * to be written after ship() had appended `shipped`, and the outcome check accepts a shipped entry only after
 * a DONE run of the approved text, so every item the file-mode CLI shipped was refused at close.
 *
 * The real CLI, offline: `harness item propose` reads the before value and takes the typed yes, `harness run
 * <task> --ship` drives the scripted run, pushes to a local bare origin and opens the PR through a fake `gh`
 * on PATH. Then the outcome check's own preconditions hold, and after a person merges, `close` closes it.
 * The refusal twin: a run whose ledger entry cannot be written ships nothing (no commit, no push, no PR).
 */
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { main } from '../../src/core/cli.ts';
import { closeItem, ledgerFacts, preconditions } from '../../src/core/close.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { itemPaths, itemStatus, readLedger } from '../../src/core/items.ts';
import type { Exec } from '../../src/core/types.ts';
import { approvedItem, bareOrigin, collector, fakeGhOnPath, git, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from './helpers.ts';

const PR_URL = 'https://example.test/fixture/repo/pull/7';
const SLUG = `ship-closes-${process.pid}`;
const SLUG_RO = `ship-refused-${process.pid}`;

/**
 * Whether a read-only file refuses an append here. Root (a CI container, say) ignores file modes, so the
 * read-only ledger below could not force the write failure: that case is then skipped, visibly, never passed.
 * test/contract-ship/ship-ledger.test.ts covers ship's own refusal with a fault that does not depend on modes.
 */
const MODES_ENFORCED = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'modes-'));
  const file = join(dir, 'probe');
  try {
    writeFileSync(file, '');
    chmodSync(file, 0o444);
    appendFileSync(file, 'x');
    return false;
  } catch {
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let tmp: TempRepo;
let gh: ReturnType<typeof fakeGhOnPath>;
let root = '';
const saved = { runs: process.env['HARNESS_RUNS_DIR'], tokens: process.env['HARNESS_TOKENS_DIR'] };

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** `harness run tasks/users-api.task.yaml --driver scripted ... --repo <clone> --ship --item <slug>`, as typed. */
async function cliRunShip(item: string): Promise<{ code: number; text: string }> {
  const out = collector();
  const code = await main(['run', USERS_TASK, '--driver', 'scripted', '--driver-opt', `script=${join(SCRIPTS, 'users-api.json')}`, '--repo', tmp.repo, '--ship', '--item', item], out.out);
  return { code, text: out.text() };
}

let shipRun: { code: number; text: string };

beforeAll(async () => {
  tmp = tempRepo('ship-closes');
  bareOrigin(tmp);
  gh = fakeGhOnPath(tmp.dir, PR_URL);
  process.env['HARNESS_RUNS_DIR'] = tmp.runsDir;
  process.env['HARNESS_TOKENS_DIR'] = tmp.tokensDir;
  root = (await approvedItem(tmp, SLUG)).root;
  shipRun = await cliRunShip(SLUG);
}, 400_000);

afterAll(() => {
  gh.restore();
  restoreEnv('HARNESS_RUNS_DIR', saved.runs);
  restoreEnv('HARNESS_TOKENS_DIR', saved.tokens);
  tmp.cleanup();
});

describe('harness run --ship (real CLI, offline, fake gh)', () => {
  it('ships: exit 0, the branch pushed to origin, the PR opened against the contract Base', () => {
    expect(shipRun.code, shipRun.text).toBe(0);
    expect(shipRun.text).toMatch(new RegExp(`^ship\\s+shipped [0-9a-f]{12} ${PR_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
    expect(gh.calls().some((c) => c.startsWith('pr create --base main --head harness/'))).toBe(true);
  });

  it('the ledger: the DONE run of the approved text, then shipped, both for the same run', () => {
    const entries = readLedger(itemPaths(root, SLUG).ledger).entries;
    const [run, shipped] = entries.slice(-2);
    expect(run?.event).toMatchObject({ type: 'run', verdict: 'DONE', contractHash: itemStatus(root, SLUG).contract.parse?.hash });
    expect(shipped?.event).toMatchObject({ type: 'shipped', prUrl: PR_URL, base: 'main' });
    expect(run?.event.type === 'run' && shipped?.event.type === 'shipped' && run.event.runId === shipped.event.runId).toBe(true);
    if (shipped?.event.type !== 'shipped') throw new Error('no shipped entry');
    // what was pushed is the head the ledger names
    expect(git(tmp.repo, ['ls-remote', 'origin', `refs/heads/${shipped.event.branch}`])).toContain(shipped.event.headSha);
  });

  it("the outcome check's own preconditions hold on that ledger (nothing is missing but the merge)", () => {
    const status = itemStatus(root, SLUG);
    expect(status.stage).toBe('shipped');
    expect(preconditions({ status, ...ledgerFacts(status) })).toEqual([]);
  });

  // Runs before the merge below: a greenfield run refuses an output that already exists on the base branch.
  it.skipIf(!MODES_ENFORCED)('refuses to ship a run whose ledger entry cannot be written: no commit, no push, no PR, no shipped entry (skipped where file modes are not enforced, as for root)', async () => {
    await approvedItem(tmp, SLUG_RO);
    const ledger = itemPaths(root, SLUG_RO).ledger;
    const before = readLedger(ledger).entries.length;
    const prs = gh.calls().filter((c) => c.startsWith('pr create')).length;
    chmodSync(ledger, 0o444); // readable (every gate still reads it), but the run's record cannot be appended
    let r: { code: number; text: string };
    try {
      r = await cliRunShip(SLUG_RO);
    } finally {
      chmodSync(ledger, 0o644);
    }
    expect(r.code, r.text).toBe(1);
    expect(r.text).toMatch(/^verdict\s+DONE/m);
    expect(r.text).toMatch(/^ship\s+refused: the run could not be recorded in the item ledger \(.*EACCES.*\): a ship needs its DONE run on record before it, so nothing was shipped$/m);
    expect(r.text).toMatch(/^item\s+could not record the run in the item ledger: /m);
    expect(readLedger(ledger).entries).toHaveLength(before);
    expect(gh.calls().filter((c) => c.startsWith('pr create'))).toHaveLength(prs);
    const runId = /^run\s+(\S+)$/m.exec(r.text)?.[1] ?? '';
    expect(git(tmp.repo, ['ls-remote', 'origin', `refs/heads/harness/${runId}`])).toBe('');
    expect(git(tmp.repo, ['rev-list', '--count', `main..harness/${runId}`])).toBe('0');
  });

  it('closes once a person merged the PR: the harness reads the metric at the merge commit', async () => {
    const shipped = ledgerFacts(itemStatus(root, SLUG)).shipped;
    if (shipped === null) throw new Error('not shipped');
    // A person merges on GitHub: here, a merge commit pushed to origin/main.
    git(tmp.repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7', shipped.event.branch]);
    git(tmp.repo, ['push', '-q', 'origin', 'refs/heads/main:refs/heads/main']);
    const mergeSha = git(tmp.repo, ['rev-parse', 'HEAD']);
    const prView: Exec = (cmd, args, opts) => {
      if (cmd !== 'gh') return exec(cmd, args, opts);
      const pr = { url: PR_URL, number: 7, state: 'MERGED', mergedAt: '2026-11-07T10:00:00Z', mergedBy: { login: 'a-person', is_bot: false }, mergeCommit: { oid: mergeSha }, baseRefName: 'main', headRefOid: shipped.event.headSha };
      return Promise.resolve({ code: 0, stdout: JSON.stringify(pr), stderr: '', durationMs: 0, timedOut: false });
    };
    const r = await closeItem({ root, harnessRoot: HARNESS_ROOT, slug: SLUG, repoDir: tmp.repo, exec: prView, harnessMetrics: true });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/metric\s+top-level entries: before 1 \(at [0-9a-f]{12}\) -> after 2 \(at [0-9a-f]{12}\)/);
    expect(itemStatus(root, SLUG).stage).toBe('closed');
  });
});
