/**
 * Skip attempt 3 (assignment 02): close an item without reading the metric. Every bypass is refused
 * with its reason and leaves the item open (no `closed` ledger entry, the contract's after slot
 * untouched); the legitimate twin (PR merged by a person, metric read by the harness at the merge
 * commit) closes it with before and after side by side.
 *
 * A real git repository with a bare origin stands in for the target; only `gh pr view` is faked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeItem, outcomeVerdict } from '../../src/core/close.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { cmdItem, ledgerTypes } from '../../src/core/item-cli.ts';
import { appendLedger, itemPaths, itemStatus, parseContract, proposeItem, recordReply } from '../../src/core/items.ts';
import { readMetric } from '../../src/core/measure.ts';
import type { Exec } from '../../src/core/types.ts';
import { contractFor, writeContract } from '../support/items.ts';

const SLUG = 'fix-count';
const PR_URL = 'https://github.com/fixture/repo/pull/7';
let base: string;
let repo: string;
let harness: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

const COUNT_SCRIPT = "import { readFileSync } from 'node:fs';\nconsole.log('counting');\nconsole.log(readFileSync('count.txt', 'utf8').trim());\n";

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'close-'));
  const origin = join(base, 'origin.git');
  repo = join(base, 'repo');
  harness = join(base, 'harness');
  root = join(base, 'items-root');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'count.txt'), '3\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  mkdirSync(join(harness, 'metrics'), { recursive: true });
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(join(root, 'metrics', 'fixture-count.mjs'), COUNT_SCRIPT);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const CONTRACT = contractFor(SLUG, { Repo: 'fixture/repo', Base: 'main', Measure: 'node metrics/fixture-count.mjs', Metric: 'count, main HEAD before: ____ after: ____' });

/** Contract, before reading (3), proposal and a typed yes: what `harness item propose` + `reply` record. */
async function approved(): Promise<void> {
  writeContract(root, SLUG, CONTRACT);
  const m = parseContract(CONTRACT).measure;
  if (m === null) throw new Error('no measure');
  const before = await readMetric({ harnessRoot: harness, itemsRoot: root, repoDir: repo, ref: 'origin/main', measure: m, label: SLUG });
  if (!before.ok) throw new Error(before.reason);
  proposeItem(root, SLUG, { session: 's', before: before.reading });
  recordReply(root, SLUG, 'yes, approved', 'tty', 's');
}

/** What ship records, and the feature branch it pushed (count 3 -> 0). */
function shipped(): string {
  git(repo, 'checkout', '-q', '-b', 'harness/run-1');
  writeFileSync(join(repo, 'count.txt'), '0\n');
  git(repo, 'commit', '-q', '-am', 'fix: count');
  git(repo, 'push', '-q', 'origin', 'harness/run-1');
  const head = git(repo, 'rev-parse', 'HEAD');
  appendLedger(itemPaths(root, SLUG).ledger, { type: 'shipped', runId: 'run-1', branch: 'harness/run-1', headSha: head, base: 'main', prUrl: PR_URL });
  git(repo, 'checkout', '-q', 'main');
  return head;
}

/** A person merges the PR on GitHub (here: a merge commit pushed to origin/main). */
function merged(): string {
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'harness/run-1');
  git(repo, 'push', '-q', 'origin', 'main');
  const m = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  return m;
}

function ghReturning(pr: Record<string, unknown>): Exec {
  return async (cmd, args, opts) => {
    if (cmd === 'gh') return { code: 0, stdout: JSON.stringify({ url: PR_URL, number: 7, baseRefName: 'main', ...pr }), stderr: '', durationMs: 1, timedOut: false };
    return coreExec(cmd, args, opts);
  };
}

function stillOpen(): void {
  expect(ledgerTypes(root, SLUG)).not.toContain('closed');
  expect(readFileSync(itemPaths(root, SLUG).contract, 'utf8')).toMatch(/before: 3 after: ____/);
}

describe('skip 3: close an item without reading the metric', () => {
  it('refuses before the harness shipped anything', async () => {
    await approved();
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({}) });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/never shipped this item/);
    stillOpen();
  });

  it('refuses while the PR is open (the metric is read after the merge)', async () => {
    await approved();
    const head = shipped();
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({ state: 'OPEN', mergedAt: null, mergedBy: null, mergeCommit: null, headRefOid: head }) });
    expect(r.reasons.join(' ')).toMatch(/PR #7 is OPEN, not merged/);
    stillOpen();
  });

  it('ignores an after value typed into the contract by hand', async () => {
    await approved();
    const head = shipped();
    const c = itemPaths(root, SLUG).contract;
    writeFileSync(c, readFileSync(c, 'utf8').replace('after: ____', 'after: 0'));
    expect(itemStatus(root, SLUG).stage).toBe('shipped');
    const out: string[] = [];
    await cmdItem({ positionals: ['status'], flags: new Map() }, (l) => out.push(l), { root, harnessRoot: harness });
    expect(out.join('\n')).toMatch(/contract says after 0: written by hand, no harness reading; ignored/);
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({ state: 'OPEN', mergedAt: null, mergedBy: null, mergeCommit: null, headRefOid: head }) });
    expect(r.ok).toBe(false);
    expect(ledgerTypes(root, SLUG)).not.toContain('closed');
  });

  it('item status shows only the latest before reading (ref, short sha) and the after value or "not read"', async () => {
    await approved();
    const status = async (): Promise<string> => {
      const out: string[] = [];
      await cmdItem({ positionals: ['status'], flags: new Map() }, (l) => out.push(l), { root, harnessRoot: harness });
      return out.join('\n');
    };
    const sha = git(repo, 'rev-parse', 'origin/main').slice(0, 12);
    expect(await status()).toMatch(new RegExp(`count: before 3 \\(origin/main ${sha}\\), after not read$`, 'm'));
    // proposed again with a newer before reading: only that one is shown
    writeFileSync(join(repo, 'count.txt'), '5\n');
    git(repo, 'commit', '-q', '-am', 'five');
    git(repo, 'push', '-q', 'origin', 'main');
    const m = parseContract(CONTRACT).measure;
    if (m === null) throw new Error('no measure');
    const again = await readMetric({ harnessRoot: harness, itemsRoot: root, repoDir: repo, ref: 'origin/main', measure: m, label: SLUG });
    if (!again.ok) throw new Error(again.reason);
    proposeItem(root, SLUG, { session: 's2', before: again.reading });
    const text = await status();
    expect(text).toMatch(new RegExp(`count: before 5 \\(origin/main ${git(repo, 'rev-parse', 'HEAD').slice(0, 12)}\\), after not read$`, 'm'));
    expect(text).not.toMatch(/before 3/);
  });

  it('refuses when commits were added to the PR after the harness shipped it', async () => {
    await approved();
    shipped();
    const m = merged();
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({ state: 'MERGED', mergedAt: 'x', mergedBy: { login: 'AbdulBasit' }, mergeCommit: { oid: m }, headRefOid: 'f'.repeat(40) }) });
    expect(r.reasons.join(' ')).toMatch(/commits were added after ship, so what merged is not what the gates cleared/);
    stillOpen();
  });

  it('refuses when the metric cannot be read after the merge', async () => {
    await approved();
    const head = shipped();
    const m = merged();
    writeFileSync(join(root, 'metrics', 'fixture-count.mjs'), "process.exit(3);\n");
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({ state: 'MERGED', mergedAt: 'x', mergedBy: { login: 'AbdulBasit' }, mergeCommit: { oid: m }, headRefOid: head }) });
    expect(r.reasons.join(' ')).toMatch(/could not be read after the merge: Measure exited 3/);
    stillOpen();
  });

  it("never borrows the harness's Measure script for an items root of its own; the file-mode CLI may (opt-in)", async () => {
    await approved();
    const head = shipped();
    const m = merged();
    // The script moves out of the item's own root into the harness's metrics/.
    rmSync(join(root, 'metrics', 'fixture-count.mjs'));
    writeFileSync(join(harness, 'metrics', 'fixture-count.mjs'), COUNT_SCRIPT);
    const gh = ghReturning({ state: 'MERGED', mergedAt: 'x', mergedBy: { login: 'AbdulBasit' }, mergeCommit: { oid: m }, headRefOid: head });
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: gh });
    expect(r.reasons.join(' ')).toMatch(new RegExp(`Measure script metrics/fixture-count\\.mjs does not exist in metrics/ under the items root \\(${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    stillOpen();
    // the twin: the file-mode CLI's opt-in finds it in the harness
    const ok = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: gh, harnessMetrics: true });
    expect(ok.reasons).toEqual([]);
  });

  it('refuses when the Measure script changed between the before and the after reading', async () => {
    await approved();
    const head = shipped();
    const m = merged();
    writeFileSync(join(root, 'metrics', 'fixture-count.mjs'), `${COUNT_SCRIPT}// edited\n`);
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({ state: 'MERGED', mergedAt: 'x', mergedBy: { login: 'AbdulBasit' }, mergeCommit: { oid: m }, headRefOid: head }) });
    expect(r.reasons.join(' ')).toMatch(/Measure script changed since the before reading/);
    stillOpen();
  });

  it('refuses a hand-forged closed entry (ledger broken), and takes no close flag', async () => {
    await approved();
    const file = itemPaths(root, SLUG).ledger;
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ seq: 99, at: 'x', prev: 'x', hash: 'x', event: { type: 'closed' } })}\n`);
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({}) });
    expect(r.reasons.join(' ')).toMatch(/ledger is broken/);
    const out: string[] = [];
    expect(await cmdItem({ positionals: ['close', SLUG], flags: new Map([['repo', [repo]], ['after', ['0']]]) }, (l) => out.push(l), { root, harnessRoot: harness })).toBe(2);
    expect(out.join(' ')).toMatch(/unknown option --after/);
  });

  it('closes once the PR merged and the harness read the metric at the merge commit (the legitimate twin)', async () => {
    await approved();
    const head = shipped();
    const m = merged();
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({ state: 'MERGED', mergedAt: '2026-11-07T10:00:00Z', mergedBy: { login: 'AbdulBasit' }, mergeCommit: { oid: m }, headRefOid: head }) });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/metric\s+count: before 3 \(at [0-9a-f]{12}\) -> after 0 \(at [0-9a-f]{12}\)/);
    expect(ledgerTypes(root, SLUG).slice(-2)).toEqual(['metric', 'closed']);
    expect(readFileSync(itemPaths(root, SLUG).contract, 'utf8')).toMatch(/^Metric: count, main HEAD before: 3 after: 0$/m);
    expect(itemStatus(root, SLUG).stage).toBe('closed');
    // a second close is refused
    const again = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({}) });
    expect(again.reasons.join(' ')).toMatch(/already closed/);
  });

  it('outcomeVerdict refuses an after reading taken somewhere other than the merge commit', () => {
    const status = itemStatus(join(base, 'none'), SLUG);
    const reading = { value: 0, sha: 'a'.repeat(40), ref: 'x', command: 'node metrics/x.mjs', scriptSha256: 's', stdoutSha256: 'o', excerpt: '', confinement: 'none' };
    const v = outcomeVerdict({ status, shipped: null, before: reading, pr: null, onBase: null, after: { ok: true, reading } });
    expect(v.ok).toBe(false);
  });
});
