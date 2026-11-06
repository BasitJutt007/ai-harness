/**
 * Skip attempt 3 (assignment 02): close an item without reading the metric. Every bypass is refused
 * with its reason and leaves the item open (no `closed` ledger entry, the contract's after slot
 * untouched); the legitimate twin (PR merged by a person, metric read by the harness at the merge
 * commit) closes it with before and after side by side.
 *
 * A real git repository with a bare origin stands in for the target; only `gh pr view` is faked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeItem, outcomeVerdict } from '../../src/core/close.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { cmdItem, ledgerTypes } from '../../src/core/item-cli.ts';
import { appendLedger, appendShipped, itemPaths, itemStatus, parseContract, proposeItem, readLedger, recordReply } from '../../src/core/items.ts';
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

type RunRecord = 'done' | 'none' | 'not-done' | 'other-contract' | 'other-run';

/**
 * The branch a governed run pushed (count 3 -> 0) and its ledger records. 'done' is what the harness writes:
 * the run's own entry (executeRun appends it before it ships), then the ship through appendShipped (ship.ts,
 * the only writer of `shipped`); test/e2e/ship-closes.test.ts checks the real CLI writes exactly this. Every
 * other shape is a forgery, written by hand, that appendShipped refuses to write.
 */
function shipped(record: RunRecord = 'done'): string {
  git(repo, 'checkout', '-q', '-b', 'harness/run-1');
  writeFileSync(join(repo, 'count.txt'), '0\n');
  git(repo, 'commit', '-q', '-am', 'fix: count');
  git(repo, 'push', '-q', 'origin', 'harness/run-1');
  const head = git(repo, 'rev-parse', 'HEAD');
  const ledger = itemPaths(root, SLUG).ledger;
  const hash = parseContract(CONTRACT).hash;
  const ship = { runId: 'run-1', branch: 'harness/run-1', headSha: head, base: 'main', prUrl: PR_URL };
  if (record === 'done') {
    const run = { runId: 'run-1', status: 'done', verdict: 'DONE', contractHash: hash };
    appendLedger(ledger, { type: 'run', ...run });
    appendShipped(ledger, run, ship);
  } else {
    if (record !== 'none') {
      const run = {
        runId: record === 'other-run' ? 'run-0' : 'run-1',
        status: record === 'not-done' ? 'max_turns' : 'done',
        verdict: record === 'not-done' ? 'NOT DONE (final gates not green)' : 'DONE',
        contractHash: record === 'other-contract' ? parseContract(CONTRACT.replace('main HEAD', 'any HEAD')).hash : hash,
      };
      expect(() => appendShipped(ledger, run, ship)).toThrow(); // the harness's own writer refuses this shape
      appendLedger(ledger, { type: 'run', ...run });
    }
    appendLedger(ledger, { type: 'shipped', ...ship });
  }
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
    const v = outcomeVerdict({ status, shipped: null, before: reading, pr: null, onBase: null, beforeMerge: null, after: { ok: true, reading } });
    expect(v.ok).toBe(false);
  });
});

describe('the outcome check, hardened', () => {
  const mergedBy = (login: unknown, m: string, head: string): Exec => ghReturning({ state: 'MERGED', mergedAt: 'x', mergedBy: login, mergeCommit: { oid: m }, headRefOid: head });

  it("a bot's merge is refused, read from gh's real JSON: is_bot, an app/ login, a [bot] login; a person's merge closes (the twin)", async () => {
    await approved();
    const head = shipped();
    const m = merged();
    for (const login of [{ login: 'app/renovate', is_bot: true }, { login: 'release-train', is_bot: true }, { login: 'app/automerge' }, { login: 'dependabot[bot]' }]) {
      const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: mergedBy(login, m, head) });
      expect(r.reasons.join(' '), JSON.stringify(login)).toMatch(new RegExp(`merged by ${login.login.replace(/[[\]]/g, '\\$&')}, a bot: a person must merge`));
      stillOpen();
    }
    expect((await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: mergedBy({ login: 'AbdulBasit', is_bot: false }, m, head) })).ok).toBe(true);
  });

  for (const [record, why] of [
    ['none', /names run run-1, but the ledger holds no record of that run before it/],
    ['not-done', /run run-1 \(ledger seq \d+\) did not end DONE \(NOT DONE/],
    ['other-contract', /run run-1 \(ledger seq \d+\) ran under another contract text/],
    ['other-run', /names run run-1, but the ledger holds no record of that run/],
  ] as const) {
    it(`a shipped entry closes only after a DONE run of the approved contract: refused with ${record}`, async () => {
      await approved();
      const head = shipped(record);
      const m = merged();
      const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: mergedBy({ login: 'AbdulBasit' }, m, head) });
      expect(r.reasons.join(' ')).toMatch(why);
      stillOpen();
    });
  }

  it('a before reading taken at or after the merge is refused; one taken on the base before it closes (the twin)', async () => {
    await approved();
    const head = shipped();
    const m = merged();
    const gh = mergedBy({ login: 'AbdulBasit' }, m, head);
    const measure = parseContract(CONTRACT).measure;
    if (measure === null) throw new Error('no measure');
    /** The item proposed again (and approved again) with a before reading taken at `ref`. */
    const reproposed = async (ref: string): Promise<void> => {
      const before = await readMetric({ harnessRoot: harness, itemsRoot: root, repoDir: repo, ref, measure, label: SLUG });
      if (!before.ok) throw new Error(before.reason);
      proposeItem(root, SLUG, { session: 's2', before: before.reading });
      recordReply(root, SLUG, 'yes', 'tty', 's2');
    };
    await reproposed(m);
    expect((await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: gh })).reasons.join(' ')).toMatch(/the before reading was taken at the merge commit [0-9a-f]{12} itself, not before the merge/);
    await reproposed(head); // the PR's own head: in the merge, but not on the base before it
    expect((await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: gh })).reasons.join(' ')).toMatch(/was not taken before the merge: it is not an ancestor of the merge's first parent/);
    expect(ledgerTypes(root, SLUG)).not.toContain('closed');
    await reproposed(`${m}^1`);
    expect((await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: gh })).ok).toBe(true);
  });

  it('a Measure that ran unconfined gives an UNPROVEN reading, and close refuses it', async () => {
    await approved();
    const head = shipped();
    const m = merged();
    const gh = mergedBy({ login: 'AbdulBasit' }, m, head);
    // the same exec, with the sandbox request dropped (as with sandbox "off")
    const unconfined: Exec = (cmd, args, opts) => gh(cmd, args, { ...opts, sandbox: undefined });
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: unconfined });
    expect(r.reasons.join(' ')).toMatch(/the after reading is UNPROVEN: the Measure ran unconfined at [0-9a-f]{12} \(sandbox: none\)/);
    stillOpen();
    const measure = parseContract(CONTRACT).measure;
    if (measure === null) throw new Error('no measure');
    const reading = await readMetric({ harnessRoot: harness, itemsRoot: root, repoDir: repo, ref: m, measure, label: SLUG, exec: unconfined });
    expect(reading).toMatchObject({ ok: true, unproven: expect.stringMatching(/ran unconfined/) });
    // the twin: confined, it closes
    expect((await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: gh })).ok).toBe(true);
  });

  it('an item whose contract says "Measure: none" can never close; the reason says the outcome cannot be read', async () => {
    const contract = contractFor(SLUG, { Repo: 'fixture/repo', Base: 'main', Measure: 'none', Metric: 'count, main HEAD before: ____ after: ____' });
    writeContract(root, SLUG, contract);
    proposeItem(root, SLUG, { session: 's', before: null });
    recordReply(root, SLUG, 'yes', 'tty', 's');
    expect(itemStatus(root, SLUG).stage).toBe('approved');
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: ghReturning({}) });
    expect(r.reasons).toEqual(['no Measure: the outcome cannot be read (the contract says "Measure: none"), so the item cannot close']);
  });

  it('item propose refuses a "Measure: none" contract in file mode: such an item could never close', async () => {
    // the clone's origin must be the contract's Repo (fixture/repo)
    mkdirSync(join(base, 'fixture'));
    git(base, 'clone', '-q', '--bare', join(base, 'origin.git'), join(base, 'fixture', 'repo.git'));
    git(repo, 'remote', 'set-url', 'origin', join(base, 'fixture', 'repo.git'));
    writeContract(root, SLUG, contractFor(SLUG, { Repo: 'fixture/repo', Base: 'main', Measure: 'none', Metric: 'count, main HEAD before: ____ after: ____' }));
    const out: string[] = [];
    const reader = { isTTY: false, ask: async () => null };
    expect(await cmdItem({ positionals: ['propose', SLUG], flags: new Map([['repo', [repo]]]) }, (l) => out.push(l), { root, harnessRoot: harness, reader }), out.join('\n')).toBe(1);
    expect(out.join('\n')).toMatch(/refused: the contract names no Measure \(Measure: none\), so there is no before value to read; an item without one can never close/);
    const ledgerPath = itemPaths(root, SLUG).ledger;
    expect(existsSync(ledgerPath) ? readLedger(ledgerPath).entries : []).toEqual([]);
  });

  it('a dry run gathers every fact and records nothing', async () => {
    await approved();
    const head = shipped();
    const m = merged();
    const r = await closeItem({ root, harnessRoot: harness, slug: SLUG, repoDir: repo, exec: mergedBy({ login: 'AbdulBasit' }, m, head), dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/every check holds; nothing recorded \(dry run\)/);
    stillOpen();
  });
});
