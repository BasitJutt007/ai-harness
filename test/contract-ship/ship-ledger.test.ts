/**
 * What ship writes in the item ledger, and when it refuses to. The outcome check closes an item only on a
 * `shipped` entry that comes after a DONE `run` of the approved contract text, so:
 *   - `shipped` is written only through appendShipped, immediately after such a run entry;
 *   - a run whose own entry is DONE (executeRun writes it before calling ship) gets no second one;
 *   - a run whose entry is NOT DONE (it stopped part-way) gets a DONE entry from the ship, once every ship gate
 *     re-ran fresh and green with agent code confined;
 *   - a ledger that cannot record that run, a contract text no longer approved, or agent code that would run
 *     unconfined ships nothing: refused before anything is staged.
 * Every refusal has its twin that ships. gh is faked; git and the remote are real (a local bare repository).
 */
import { appendFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ledgerFacts, preconditions } from '../../src/core/close.ts';
import { appendLedger, appendShipped, itemPaths, itemStatus, parseContract, readLedger, recordDoneRun, recordReply, SHIP_DONE_VERDICT, type LedgerEntry, type LedgerEvent, type MetricReading } from '../../src/core/items.ts';
import { setSandboxMode } from '../../src/core/sandbox.ts';
import { ship } from '../../src/core/ship.ts';
import type { Exec, ItemBinding } from '../../src/core/types.ts';
import { approveForTest, contractFor } from '../support/items.ts';
import { brownfieldTask, git, isolatedExec, makeCtx, repoTmp, writeFiles } from './helpers.ts';

const tmp = repoTmp('ship-ledger');
afterAll(() => tmp.cleanup());
afterEach(() => setSandboxMode('auto'));

const SLUG = 'ship-ledger-item';
const RUN_ID = 'projects-change-scripted-20261002-120000';
const PR = 'https://example.test/org/repo/pull/9';
const HASH = parseContract(contractFor(SLUG)).hash;

let counter = 0;
/** A repo with an `api/` root, a local bare origin with main pushed, the run branch checked out with one change; and an approved item. */
async function setup(): Promise<{ repo: string; remote: string; baseSha: string; item: ItemBinding; ledger: string }> {
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
  await git(repo, 'checkout', '-q', '-b', 'harness/projects-change');
  writeFiles(repo, { 'api/src/app.ts': 'export const v = 2;\n' });
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

function shipCtx(s: { repo: string; baseSha: string; item: ItemBinding }, exec: Exec = fakeGh()) {
  return makeCtx({ repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: 'harness/projects-change', baseBranch: 'main', baseSha: s.baseSha, exec, item: s.item });
}

/** The run's own entry, as executeRun writes it before calling ship. */
function runEntry(ledger: string, verdict: string): void {
  appendLedger(ledger, { type: 'run', runId: RUN_ID, status: verdict === 'DONE' ? 'done' : 'aborted', verdict, contractHash: HASH });
}

const events = (ledger: string): LedgerEvent[] => readLedger(ledger).entries.map((e) => e.event);

async function nothingShipped(s: { repo: string; remote: string; baseSha: string }): Promise<void> {
  expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
  expect(await git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
  expect(await git(s.repo, 'ls-remote', s.remote, 'refs/heads/harness/projects-change')).toBe('');
}

describe('ship: the ledger it writes', () => {
  it('after a DONE run entry (the executeRun order) it appends only shipped, right after it', async () => {
    const s = await setup();
    runEntry(s.ledger, 'DONE');
    const ctx = shipCtx(s);
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status, r.reasons.join('\n')).toBe('shipped');
    const tail = events(s.ledger).slice(-2);
    expect(tail).toMatchObject([{ type: 'run', runId: RUN_ID, verdict: 'DONE' }, { type: 'shipped', runId: RUN_ID, prUrl: PR, headSha: r.commit }]);
    expect(events(s.ledger).filter((e) => e.type === 'run')).toHaveLength(1);
  });

  it('after a NOT DONE run entry (a run that stopped part-way) the green ship records a DONE run, then shipped', async () => {
    const s = await setup();
    runEntry(s.ledger, 'NOT DONE (stopped by signal)');
    const ctx = shipCtx(s);
    expect((await ship({ ctx, registry: ctx.registry, dryRun: false })).status).toBe('shipped');
    expect(events(s.ledger).slice(-3)).toMatchObject([
      { type: 'run', verdict: 'NOT DONE (stopped by signal)' },
      { type: 'run', runId: RUN_ID, status: 'ship', verdict: SHIP_DONE_VERDICT, contractHash: HASH },
      { type: 'shipped', runId: RUN_ID },
    ]);
  });

  it('when an entry lands between the DONE run and shipped (a reply typed during the push), the DONE run is recorded again right before shipped', async () => {
    const s = await setup();
    runEntry(s.ledger, 'DONE');
    const ctx = shipCtx(s, fakeGh(() => void recordReply(s.item.root, SLUG, 'thanks for the update', 'tty', 'other-terminal')));
    expect((await ship({ ctx, registry: ctx.registry, dryRun: false })).status).toBe('shipped');
    expect(events(s.ledger).slice(-4).map((e) => e.type)).toEqual(['run', 'human_turn', 'run', 'shipped']);
    expect(events(s.ledger).at(-2)).toMatchObject({ type: 'run', runId: RUN_ID, verdict: SHIP_DONE_VERDICT });
  });

  it('a dry run records nothing', async () => {
    const s = await setup();
    const before = events(s.ledger);
    const ctx = shipCtx(s);
    expect((await ship({ ctx, registry: ctx.registry, dryRun: true })).status).toBe('dry-run');
    expect(events(s.ledger)).toEqual(before);
  });
});

describe('ship refuses, before anything is staged, what close could never accept', () => {
  it('a ledger that cannot record the DONE run: refused, nothing committed or pushed; the writable twin ships', async () => {
    const s = await setup();
    const before = events(s.ledger);
    chmodSync(s.ledger, 0o444);
    let r: Awaited<ReturnType<typeof ship>>;
    try {
      const ctx = shipCtx(s);
      r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    } finally {
      chmodSync(s.ledger, 0o644);
    }
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toMatch(/the item ledger could not record the DONE run this ship stands on, so nothing was staged: .*EACCES/);
    expect(events(s.ledger)).toEqual(before);
    await nothingShipped(s);
    const ctx = shipCtx(s);
    expect((await ship({ ctx, registry: ctx.registry, dryRun: false })).status).toBe('shipped');
  });

  it('a contract text no longer approved (the stakeholder said no after the yes): refused; approved again, it ships', async () => {
    const s = await setup();
    recordReply(s.item.root, SLUG, 'no, wait', 'tty', 's');
    const ctx = shipCtx(s);
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toMatch(/the contract text this run worked under \([0-9a-f]{12}\) is not approved now: Test Stakeholder did not approve/);
    expect(events(s.ledger).some((e) => e.type === 'run' || e.type === 'shipped')).toBe(false);
    await nothingShipped(s);
    recordReply(s.item.root, SLUG, 'yes, go ahead', 'tty', 's');
    expect((await ship({ ctx, registry: ctx.registry, dryRun: false })).status).toBe('shipped');
  });

  it('agent code without a working sandbox (isolation off): UNPROVEN is never DONE, refused even as a dry run; with the sandbox it ships', async () => {
    const s = await setup();
    setSandboxMode('off');
    const ctx = shipCtx(s);
    for (const dryRun of [true, false]) {
      const r = await ship({ ctx, registry: ctx.registry, dryRun });
      expect(r.status, String(dryRun)).toBe('refused');
      expect(r.reasons.join('\n')).toMatch(/without a working sandbox \(isolation: off \(agent code ran unconfined\)\): UNPROVEN is never DONE/);
    }
    expect(events(s.ledger).some((e) => e.type === 'run' || e.type === 'shipped')).toBe(false);
    await nothingShipped(s);
    setSandboxMode('auto');
    expect((await ship({ ctx, registry: ctx.registry, dryRun: false })).status).toBe('shipped');
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

describe('appendShipped: the only writer of shipped writes only what close accepts', () => {
  it('writes the DONE run then shipped, and close finds that run (with a before reading, nothing else is missing)', () => {
    const { root, ledger } = approvedLedger();
    const before: MetricReading = { value: 1, sha: 'e'.repeat(40), ref: 'origin/main', command: 'node metrics/fixture-zero.mjs', scriptSha256: 'c'.repeat(64), stdoutSha256: 'd'.repeat(64), excerpt: '1', confinement: 'sandbox-exec' };
    appendLedger(ledger, { type: 'metric', phase: 'before', reading: before });
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
