/**
 * What ship writes in the item ledger, and when it refuses to. The outcome check closes an item only on a
 * `shipped` entry that comes after a DONE `run` of the approved contract text, so:
 *   - `shipped` is written only through appendShipped, immediately after such a run entry;
 *   - a run whose own entry is DONE (executeRun writes it before calling ship) gets no second one;
 *   - a run whose entry is NOT DONE (it stopped part-way) gets a DONE entry from the ship, once every ship gate
 *     re-ran fresh and green with agent code confined and a supported target profile;
 *   - a ledger that cannot record that run, a contract text no longer approved, an UNPROVEN target profile, or
 *     agent code that would run unconfined ships nothing: refused before anything is staged.
 * Every refusal has its twin that ships. gh is faked; git and the remote are real (a local bare repository).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ledgerFacts, preconditions, shippedRunProblem } from '../../src/core/close.ts';
import { appendLedger, appendShipped, itemPaths, itemStatus, parseContract, readLedger, recordDoneRun, recordReply, SHIP_DONE_VERDICT, type LedgerEntry, type LedgerEvent, type MetricReading } from '../../src/core/items.ts';
import { setSandboxMode } from '../../src/core/sandbox.ts';
import { ship, type ShipResult } from '../../src/core/ship.ts';
import type { Exec, GatePlugin, ItemBinding, PluginRecord } from '../../src/core/types.ts';
import { approveForTest, contractFor } from '../support/items.ts';
import { brownfieldTask, git, isolatedExec, makeCtx, repoTmp, writeFiles } from './helpers.ts';

const tmp = repoTmp('ship-ledger');
afterAll(() => tmp.cleanup());
afterEach(() => setSandboxMode('auto'));

const SLUG = 'ship-ledger-item';
const RUN_ID = 'projects-change-scripted-20261002-120000';
const BRANCH = 'harness/projects-change';
const PR = 'https://example.test/org/repo/pull/9';
const HASH = parseContract(contractFor(SLUG)).hash;
const AWS_KEY = 'AKIA0123456789ABCDEF';

interface Setup { repo: string; remote: string; baseSha: string; item: ItemBinding; ledger: string }

let counter = 0;
/** A repo with an `api/` root, a local bare origin with main pushed, the run branch checked out with one change; and an approved item. */
async function setup(change = 'export const v = 2;\n'): Promise<Setup> {
  const dir = join(tmp.dir, `case-${++counter}`);
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  writeFiles(repo, { 'api/src/app.ts': 'export const v = 1;\n' });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  await git(dir, 'init', '-q', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-q', 'origin', 'refs/heads/main:refs/heads/main');
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', '-b', BRANCH);
  writeFiles(repo, { 'api/src/app.ts': change });
  const root = join(dir, 'items');
  approveForTest(root, SLUG);
  return { repo, remote, baseSha, item: { slug: SLUG, root, contractHash: HASH }, ledger: itemPaths(root, SLUG).ledger };
}

/** gh installed and authenticated; `pr create` prints the PR URL (and first runs `onCreate`, if given). */
function fakeGh(onCreate?: () => void): Exec {
  return (cmd, args, opts) => {
    if (cmd !== 'gh') return isolatedExec(cmd, args, opts);
    if (args[0] === 'pr' && onCreate !== undefined) onCreate();
    return Promise.resolve({ code: 0, stdout: args[0] === 'pr' ? `${PR}\n` : 'ok\n', stderr: '', durationMs: 0, timedOut: false });
  };
}

/**
 * A fake forge behind `gh`: `pr create` opens a PR for the branch (its head is whatever the bare origin's branch
 * points at when it is viewed), `pr view <branch> --json ...` prints it as gh does, or fails when there is none.
 * `installed: false` is a machine without gh. `prs` can be seeded (a PR someone else opened).
 */
interface Forge {
  exec: Exec;
  creates: () => number;
  prs: Map<string, { base: string; state: string; head?: string }>;
  installed: boolean;
  onCreate?: () => void;
}
function forge(s: Setup): Forge {
  let creates = 0;
  const f: Forge = {
    prs: new Map(),
    installed: true,
    creates: () => creates,
    exec: (cmd, args, opts) => {
      if (cmd !== 'gh') return isolatedExec(cmd, args, opts);
      const done = (code: number, stdout: string, stderr = ''): ReturnType<Exec> => Promise.resolve({ code, stdout, stderr, durationMs: 0, timedOut: false });
      if (!f.installed) return done(127, '', 'gh: command not found');
      if (args[0] === 'pr' && args[1] === 'create') {
        creates += 1;
        f.onCreate?.();
        f.prs.set(args[args.indexOf('--head') + 1] ?? '', { base: args[args.indexOf('--base') + 1] ?? '', state: 'OPEN' });
        return done(0, `${PR}\n`);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const branch = args[2] ?? '';
        const pr = f.prs.get(branch);
        if (pr === undefined) return done(1, '', `no pull requests found for branch "${branch}"`);
        const head = pr.head ?? execFileSync('git', ['--git-dir', s.remote, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
        return done(0, JSON.stringify({ url: PR, number: 9, state: pr.state, mergedAt: null, mergedBy: null, mergeCommit: null, baseRefName: pr.base, headRefOid: head }));
      }
      return done(0, 'ok\n');
    },
  };
  return f;
}

function shipCtx(s: { repo: string; baseSha: string; item: ItemBinding }, exec: Exec = fakeGh(), more: { branch?: string; runId?: string; gates?: PluginRecord<GatePlugin>[] } = {}) {
  const ctx = makeCtx({ repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: more.branch ?? BRANCH, baseBranch: 'main', baseSha: s.baseSha, exec, item: s.item, ...(more.gates !== undefined ? { gates: more.gates } : {}) });
  if (more.runId !== undefined) ctx.run.id = more.runId;
  return ctx;
}

async function shipOnce(ctx: ReturnType<typeof shipCtx>, more: { dryRun?: boolean; targetNotes?: string[]; remote?: string } = {}): Promise<ShipResult> {
  return ship({ ctx, registry: ctx.registry, targetNotes: more.targetNotes ?? [], dryRun: more.dryRun ?? false, ...(more.remote !== undefined ? { remote: more.remote } : {}) });
}

/** The run's own entry, as executeRun writes it before calling ship. */
function runEntry(ledger: string, verdict: string, runId = RUN_ID): void {
  appendLedger(ledger, { type: 'run', runId, status: verdict === 'DONE' ? 'done' : 'aborted', verdict, contractHash: HASH });
}

const events = (ledger: string): LedgerEvent[] => readLedger(ledger).entries.map((e) => e.event);
const doneEntries = (ledger: string): LedgerEvent[] => events(ledger).filter((e) => e.type === 'run' && e.verdict === SHIP_DONE_VERDICT);
const commitsOnBranch = (s: Setup): Promise<string> => git(s.repo, 'rev-list', '--count', `${s.baseSha}..HEAD`);
const remoteBranch = (s: Setup, branch = BRANCH): Promise<string> => git(s.repo, 'ls-remote', s.remote, `refs/heads/${branch}`);

async function nothingShipped(s: Setup): Promise<void> {
  expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
  expect(await git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
  expect(await remoteBranch(s)).toBe('');
}

describe('ship: the ledger it writes', () => {
  it('after a DONE run entry (the executeRun order) it appends only shipped, right after it', async () => {
    const s = await setup();
    runEntry(s.ledger, 'DONE');
    const r = await shipOnce(shipCtx(s));
    expect(r.status, r.reasons.join('\n')).toBe('shipped');
    const tail = events(s.ledger).slice(-2);
    expect(tail).toMatchObject([{ type: 'run', runId: RUN_ID, verdict: 'DONE' }, { type: 'shipped', runId: RUN_ID, prUrl: PR, headSha: r.commit }]);
    expect(events(s.ledger).filter((e) => e.type === 'run')).toHaveLength(1);
  });

  it('after a NOT DONE run entry (a run that stopped part-way) the green ship records a DONE run, then shipped', async () => {
    const s = await setup();
    runEntry(s.ledger, 'NOT DONE (stopped by signal)');
    expect((await shipOnce(shipCtx(s))).status).toBe('shipped');
    expect(events(s.ledger).slice(-3)).toMatchObject([
      { type: 'run', verdict: 'NOT DONE (stopped by signal)' },
      { type: 'run', runId: RUN_ID, status: 'ship', verdict: SHIP_DONE_VERDICT, contractHash: HASH },
      { type: 'shipped', runId: RUN_ID },
    ]);
  });

  it('when an entry lands between the DONE run and shipped (a reply typed during the push), the DONE run is recorded again right before shipped', async () => {
    const s = await setup();
    runEntry(s.ledger, 'DONE');
    expect((await shipOnce(shipCtx(s, fakeGh(() => void recordReply(s.item.root, SLUG, 'thanks for the update', 'tty', 'other-terminal'))))).status).toBe('shipped');
    expect(events(s.ledger).slice(-4).map((e) => e.type)).toEqual(['run', 'human_turn', 'run', 'shipped']);
    expect(events(s.ledger).at(-2)).toMatchObject({ type: 'run', runId: RUN_ID, verdict: SHIP_DONE_VERDICT });
  });

  it('a dry run records nothing', async () => {
    const s = await setup();
    const before = events(s.ledger);
    expect((await shipOnce(shipCtx(s), { dryRun: true })).status).toBe('dry-run');
    expect(events(s.ledger)).toEqual(before);
  });
});

describe('ship refuses, before anything is staged, what close could never accept', () => {
  it('a ledger that cannot record the DONE run: refused, nothing committed or pushed; the writable twin ships', async () => {
    const s = await setup();
    const before = events(s.ledger);
    chmodSync(s.ledger, 0o444);
    let r: ShipResult;
    try {
      r = await shipOnce(shipCtx(s));
    } finally {
      chmodSync(s.ledger, 0o644);
    }
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toMatch(/the item ledger could not record the DONE run this ship stands on, so nothing was staged: .*EACCES/);
    expect(events(s.ledger)).toEqual(before);
    await nothingShipped(s);
    expect((await shipOnce(shipCtx(s))).status).toBe('shipped');
  });

  it('a contract text no longer approved (the stakeholder said no after the yes): refused; approved again, it ships', async () => {
    const s = await setup();
    recordReply(s.item.root, SLUG, 'no, wait', 'tty', 's');
    const ctx = shipCtx(s);
    const r = await shipOnce(ctx);
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toMatch(/the contract text this run worked under \([0-9a-f]{12}\) is not approved now: Test Stakeholder did not approve/);
    expect(events(s.ledger).some((e) => e.type === 'run' || e.type === 'shipped')).toBe(false);
    await nothingShipped(s);
    recordReply(s.item.root, SLUG, 'yes, go ahead', 'tty', 's');
    expect((await shipOnce(ctx)).status).toBe('shipped');
  });

  it('agent code without a working sandbox (isolation off): UNPROVEN is never DONE, refused even as a dry run; with the sandbox it ships', async () => {
    const s = await setup();
    setSandboxMode('off');
    const ctx = shipCtx(s);
    for (const dryRun of [true, false]) {
      const r = await shipOnce(ctx, { dryRun });
      expect(r.status, String(dryRun)).toBe('refused');
      expect(r.reasons.join('\n')).toMatch(/without a working sandbox \(isolation: off \(agent code ran unconfined\)\): UNPROVEN is never DONE/);
    }
    expect(events(s.ledger).some((e) => e.type === 'run' || e.type === 'shipped')).toBe(false);
    await nothingShipped(s);
    setSandboxMode('auto');
    expect((await shipOnce(ctx)).status).toBe('shipped');
  });

  it('a target profile with unsupported parts (a run on it is never DONE): refused even as a dry run; a supported profile ships', async () => {
    const s = await setup();
    runEntry(s.ledger, 'NOT DONE (UNPROVEN: target: unsupported test runner bun test)');
    const before = events(s.ledger);
    const notes = ["unsupported test runner bun test (bun's own runner and module loader): tests-green and observed red are UNPROVEN"];
    for (const dryRun of [true, false]) {
      const r = await shipOnce(shipCtx(s), { dryRun, targetNotes: notes });
      expect(r.status, String(dryRun)).toBe('refused');
      expect(r.reasons).toEqual([`the target profile is UNPROVEN (${notes[0] ?? ''}): a run is never DONE on it, so no DONE run can be recorded and nothing ships`]);
    }
    expect(events(s.ledger)).toEqual(before);
    await nothingShipped(s);
    expect((await shipOnce(shipCtx(s), { targetNotes: [] })).status).toBe('shipped');
  });
});

// ───────────────────────────── the writer itself ─────────────────────────────

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function approvedLedger(): { root: string; ledger: string } {
  const root = mkdtempSync(join(tmpdir(), 'ship-writer-'));
  dirs.push(root);
  approveForTest(root, SLUG);
  return { root, ledger: itemPaths(root, SLUG).ledger };
}
const done = { runId: 'r1', status: 'done', verdict: 'DONE', contractHash: HASH };
const shippedRecord = { runId: 'r1', branch: 'harness/r1', headSha: 'b'.repeat(40), base: 'main', prUrl: 'https://example.test/pull/1' };
const reading: MetricReading = { value: 1, sha: 'e'.repeat(40), ref: 'origin/main', command: 'node metrics/fixture-zero.mjs', scriptSha256: 'c'.repeat(64), stdoutSha256: 'd'.repeat(64), excerpt: '1', confinement: 'sandbox-exec' };

describe('appendShipped: the only writer of shipped writes only what close accepts', () => {
  it('writes the DONE run then shipped, and close finds that run (with a before reading, nothing else is missing)', () => {
    const { root, ledger } = approvedLedger();
    appendLedger(ledger, { type: 'metric', phase: 'before', reading });
    appendShipped(ledger, done, shippedRecord);
    expect(events(ledger).slice(-2)).toMatchObject([{ type: 'run', ...done }, { type: 'shipped', ...shippedRecord }]);
    const status = itemStatus(root, SLUG);
    expect(preconditions({ status, ...ledgerFacts(status) })).toEqual([]);
  });

  for (const [name, run, shipped, why] of [
    ['a run that did not end DONE', { ...done, verdict: 'NOT DONE (final gates not green)' }, shippedRecord, /run r1 did not end DONE \(NOT DONE \(final gates not green\)\): no ship stands on it/],
    ['a run under another contract text', { ...done, contractHash: '0'.repeat(64) }, shippedRecord, /run r1 worked under contract text 000000000000, which is not approved: the contract changed after it was proposed/],
    ['a ship of another run', done, { ...shippedRecord, runId: 'r0' }, /a ship of run r0 cannot stand on the record of run r1/],
  ] as const) {
    it(`refuses, writing nothing: ${name}`, () => {
      const { ledger } = approvedLedger();
      const before = events(ledger);
      expect(() => appendShipped(ledger, run, shipped)).toThrow(why);
      expect(events(ledger)).toEqual(before);
    });
  }

  it('refuses a broken ledger (it approves nothing), writing nothing', () => {
    const { ledger } = approvedLedger();
    const forged: LedgerEntry = { seq: 99, at: 'x', prev: 'x', hash: 'x', event: { type: 'closed' } as unknown as LedgerEvent };
    appendFileSync(ledger, `${JSON.stringify(forged)}\n`); // a hand-written line: what no harness code path produces
    expect(() => recordDoneRun(ledger, done)).toThrow(/is not approved: the item ledger is broken/);
  });

  it('a DONE run already latest is not written twice; one followed by anything else is', () => {
    const { root, ledger } = approvedLedger();
    const first = recordDoneRun(ledger, done);
    expect(recordDoneRun(ledger, done).seq).toBe(first.seq);
    recordReply(root, SLUG, 'thanks', 'tty', 's');
    expect(recordDoneRun(ledger, done).seq).toBe(first.seq + 2);
  });
});
