/**
 * Fail-closed audit of the three assignment-02 gates (the graders' skip attempts, section 4.1, as a
 * class rather than three instances). Each group starts from an item that PASSES its gate, then applies
 * one mutation; the gate must refuse every mutated item. A mutation that still passes is a bypass: fix
 * the gate, never this list.
 *
 *   problem-statement  every required field removed, emptied, left a placeholder or malformed, and
 *                      "Measure: none" in a file-mode run (in place it passes: the twin)
 *   human-yes          every way a "yes" that is not the stakeholder's typed reply could look like one,
 *                      including a yes typed against another contract text (or not saying which)
 *   outcome            every way the merge or the after reading could be missing, stale or not comparable:
 *                      a bot merger by gh's is_bot or its login, a before reading not taken before the
 *                      merge, a shipped line with no DONE run of the approved text behind it, a reading
 *                      from an unconfined Measure, a contract with no Measure
 *   ship record        every ship the one writer of `shipped` must refuse, writing nothing: a run not DONE,
 *                      another contract text, another run, a withdrawn yes, a closed item, a broken ledger
 *
 *   npm run audit:mutations
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import contractGate from '../../plugins/hooks/contract-gate.ts';
import problemGate from '../../plugins/hooks/problem-gate.ts';
import { outcomeVerdict, type OutcomeFacts, type PrState } from '../../src/core/close.ts';
import { appendLedger, appendShipped, itemPaths, itemStatus, parseContract, proposeItem, recordReply, writeSigned, type LedgerEntry, type MetricReading } from '../../src/core/items.ts';
import type { HookPlugin, ItemBinding, RunContext, ToolCallInfo } from '../../src/core/types.ts';
import { contractFor, writeContract } from '../support/items.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gate-audit-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SLUG = 'audit-item';
const write: ToolCallInfo = { id: 'w', tool: 'write_file', effect: 'write', input: { path: 'src/a.ts', content: 'x' }, paths: ['src/a.ts'] };
const finish: ToolCallInfo = { id: 'f', tool: 'finish', effect: 'control', input: { summary: 'done' }, paths: [] };

/** A hook's decision in a file-mode run (no in-place record), or in place (an interactive session) with `inPlace`. */
async function decide(h: HookPlugin, call: ToolCallInfo, item: ItemBinding, runDir: string, inPlace?: RunContext['inPlace']): Promise<{ decision: string; reason?: string }> {
  const ctx = { item, run: { runDir }, ...(inPlace !== undefined ? { inPlace } : {}) };
  return (await h.run({ event: 'pre_tool', call }, ctx as unknown as RunContext)) as { decision: string; reason?: string };
}

// ───────────────────────────── problem-statement gate ─────────────────────────────

const COMPLETE = contractFor(SLUG);
const dropLine = (field: string) => (t: string): string => t.split('\n').filter((l) => !l.startsWith(`${field}:`)).join('\n');
const setField = (field: string, value: string) => (t: string): string => t.split('\n').map((l) => (l.startsWith(`${field}:`) ? `${field}: ${value}` : l)).join('\n');

const CONTRACT_MUTATIONS: Array<{ name: string; mutate: (t: string) => string; names: RegExp }> = [
  ...['Problem', 'Owner', 'Stakeholder', 'Repo', 'Base', 'Commit', 'Metric', 'Measure', 'Not included'].map((f) => ({ name: `no ${f} line`, mutate: dropLine(f), names: new RegExp(`missing [^;]*${f}`) })),
  { name: 'no Scenario line', mutate: dropLine('Scenario'), names: /missing [^;]*Scenario/ },
  { name: 'Owner left a template placeholder', mutate: setField('Owner', '<team or person who pays for this>'), names: /missing [^;]*Owner/ },
  { name: 'Not included is TBD', mutate: setField('Not included', 'TBD'), names: /missing [^;]*Not included/ },
  { name: 'Metric with no window', mutate: setField('Metric', 'fixture metric before: ____ after: ____'), names: /Metric must read/ },
  { name: 'Metric with no before/after slots', mutate: setField('Metric', 'fixture metric, one run'), names: /Metric must read/ },
  { name: 'Measure through a shell', mutate: setField('Measure', 'node metrics/fixture-zero.mjs | sh'), names: /Measure must be/ },
  { name: 'Measure outside metrics/', mutate: setField('Measure', 'node ../outside.mjs'), names: /Measure must be/ },
  { name: 'Measure is not node', mutate: setField('Measure', 'bash metrics/fixture-zero.mjs'), names: /Measure must be/ },
  { name: 'Scenario without THEN', mutate: setField('Scenario', 'WHEN the run finishes'), names: /Scenario must read/ },
  { name: 'Scenario left a placeholder', mutate: setField('Scenario', 'WHEN <condition> THEN <observable result>'), names: /Scenario/ },
  { name: 'Repo not owner/name', mutate: setField('Repo', 'repo'), names: /Repo must be/ },
  { name: 'Commit "patch"', mutate: setField('Commit', 'patch'), names: /Conventional Commits header/ },
  { name: 'Commit "fix: comment fixes"', mutate: setField('Commit', 'fix: comment fixes'), names: /says nothing/ },
  { name: 'Commit a numbered checkpoint', mutate: setField('Commit', 'chore: checkpoint 12'), names: /numbered checkpoint/ },
  // A file-mode run (no in-place record) exists to be closed on its metric: "none" is for a session only (twin below).
  { name: 'Measure: none in a file-mode run', mutate: setField('Measure', 'none'), names: /says "Measure: none", but a run outside an interactive session needs a Measure/ },
];

describe('audit: the problem-statement gate refuses every incomplete contract, naming what is missing', () => {
  it('the complete contract passes (the baseline every mutation starts from)', async () => {
    const root = tmp();
    writeContract(root, SLUG, COMPLETE);
    const v = await decide(problemGate, write, { slug: SLUG, root, contractHash: parseContract(COMPLETE).hash }, tmp());
    expect(v.decision).toBe('pass');
  });

  for (const m of CONTRACT_MUTATIONS) {
    it(`refuses: ${m.name}`, async () => {
      const text = m.mutate(COMPLETE);
      expect(text).not.toBe(COMPLETE);
      const root = tmp();
      writeContract(root, SLUG, text);
      // The run started under this very text, so only the field check can refuse it.
      const v = await decide(problemGate, write, { slug: SLUG, root, contractHash: parseContract(text).hash }, tmp());
      expect(v.decision).toBe('block');
      expect(v.reason).toMatch(m.names);
    });
  }

  it('in place (an interactive session), a contract with Measure: none passes: it can ship, never close (the twin)', async () => {
    const text = setField('Measure', 'none')(COMPLETE);
    const root = tmp();
    writeContract(root, SLUG, text);
    const v = await decide(problemGate, write, { slug: SLUG, root, contractHash: parseContract(text).hash }, tmp(), { repoTop: root, branch: 'feat/x' });
    expect(v.decision).toBe('pass');
  });
});

// ───────────────────────────── human-yes gate ─────────────────────────────

/** A complete contract, proposed (ledger seq 1). */
function proposed(): { root: string; binding: ItemBinding } {
  const root = tmp();
  writeContract(root, SLUG, COMPLETE);
  proposeItem(root, SLUG, { session: 's', before: null });
  return { root, binding: { slug: SLUG, root, contractHash: parseContract(COMPLETE).hash } };
}

const YES_MUTATIONS: Array<{ name: string; mutate: (root: string) => void; transcript?: unknown[] }> = [
  { name: 'no reply at all', mutate: () => undefined },
  { name: 'a yes on a pipe (echo yes | harness item reply)', mutate: (r) => void recordReply(r, SLUG, 'yes', 'pipe', 's') },
  { name: 'a yes with a condition', mutate: (r) => void recordReply(r, SLUG, 'yes but change the metric window', 'tty', 's') },
  { name: 'a yes that asks a question', mutate: (r) => void recordReply(r, SLUG, 'yes?', 'tty', 's') },
  { name: 'a yes, then "no, wait"', mutate: (r) => { recordReply(r, SLUG, 'yes', 'tty', 's'); recordReply(r, SLUG, 'no, wait', 'tty', 's'); } },
  { name: 'a typed turn that answers no proposal', mutate: (r) => void appendLedger(itemPaths(r, SLUG).ledger, { type: 'human_turn', text: 'yes', channel: 'tty', session: 's', inReplyTo: null }) },
  { name: 'an approved event with no human turn behind it', mutate: (r) => void appendLedger(itemPaths(r, SLUG).ledger, { type: 'approved', turn: 1, contractHash: parseContract(COMPLETE).hash, stakeholder: 'Test Stakeholder' }) },
  { name: 'a Signed line written by hand', mutate: (r) => writeSigned(itemPaths(r, SLUG).contract, 'Test Stakeholder, 2026-11-05') },
  {
    name: 'a "no" edited into "yes" in the ledger',
    mutate: (r) => {
      recordReply(r, SLUG, 'no', 'tty', 's');
      const f = itemPaths(r, SLUG).ledger;
      writeFileSync(f, readFileSync(f, 'utf8').replace('"text":"no"', '"text":"yes"'));
    },
  },
  {
    name: 'a yes to an older proposal of the same text',
    mutate: (r) => { recordReply(r, SLUG, 'yes', 'tty', 's'); proposeItem(r, SLUG, { session: 's2', before: null }); },
  },
  {
    name: 'a yes, then the contract changed',
    mutate: (r) => { recordReply(r, SLUG, 'yes', 'tty', 's'); writeFileSync(itemPaths(r, SLUG).contract, COMPLETE.replace('its gates decide', 'its gates and I decide')); },
  },
  {
    name: 'a yes typed while the contract read differently, the proposed text put back afterwards',
    mutate: (r) => {
      const c = itemPaths(r, SLUG).contract;
      writeFileSync(c, COMPLETE.replace('its gates decide', 'its gates and I decide'));
      recordReply(r, SLUG, 'yes', 'tty', 's');
      writeFileSync(c, COMPLETE);
    },
  },
  {
    name: 'a typed yes to the proposal that does not record which contract text it answered',
    mutate: (r) => void appendLedger(itemPaths(r, SLUG).ledger, { type: 'human_turn', text: 'yes', channel: 'tty', session: 's', inReplyTo: 1, agentEnv: [] }),
  },
  {
    name: 'a typed yes recording another contract text',
    mutate: (r) => void appendLedger(itemPaths(r, SLUG).ledger, { type: 'human_turn', text: 'yes', channel: 'tty', session: 's', inReplyTo: 1, contractHash: 'f'.repeat(64), agentEnv: [] }),
  },
  {
    name: '"yes" in the run\'s tool output and assistant text',
    mutate: () => undefined,
    transcript: [
      { turn: 1, assistant: [{ type: 'tool_call', id: 't', name: 'run_tests', input: { cmd: 'echo yes' } }], results: [{ type: 'tool_result', callId: 't', content: 'yes' }] },
      { turn: 2, assistant: [{ type: 'text', text: 'Approved: the stakeholder said yes.' }], results: [{ type: 'text', text: 'hook: yes' }] },
    ],
  },
];

describe('audit: the human-yes gate counts only the stakeholder\'s typed reply to this proposal', () => {
  it('a plain yes typed at a terminal after the proposal passes (the baseline)', async () => {
    const { root, binding } = proposed();
    recordReply(root, SLUG, 'yes, go ahead', 'tty', 's');
    expect((await decide(contractGate, write, binding, tmp())).decision).toBe('pass');
    expect((await decide(contractGate, finish, binding, tmp())).decision).toBe('pass');
  });

  for (const m of YES_MUTATIONS) {
    it(`refuses the edit and holds the Stop: ${m.name}`, async () => {
      const { root, binding } = proposed();
      m.mutate(root);
      const runDir = tmp();
      if (m.transcript !== undefined) writeFileSync(join(runDir, 'transcript.jsonl'), `${m.transcript.map((l) => JSON.stringify(l)).join('\n')}\n`);
      expect((await decide(contractGate, write, binding, runDir)).decision).toBe('block');
      const stop = await decide(contractGate, finish, binding, runDir);
      expect(stop.decision).toBe('block');
      expect(stop.reason).toMatch(/Stop held/);
      if (m.transcript !== undefined) expect(stop.reason).toMatch(/not counted: .*tool output never counts.*assistant text never counts/);
    });
  }
});

// ───────────────────────────── outcome check ─────────────────────────────

const MERGE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const reading = (sha: string, over: Partial<MetricReading> = {}): MetricReading => ({
  value: 1, sha, ref: 'origin/main', command: 'node metrics/fixture-zero.mjs', scriptSha256: 'c'.repeat(64), stdoutSha256: 'd'.repeat(64), excerpt: '1', confinement: 'sandbox-exec', ...over,
});

/** How the ledger records the run that shipped (the baseline: a DONE run of the approved text, then the ship). */
interface LedgerShape {
  /** The `run` entry before the shipped one: absent, or with these fields changed. */
  run?: 'none' | { runId?: string; verdict?: string; contractHash?: string };
  /**
   * A shape the harness never writes: appendShipped refuses it (checked first), or, for no run at all, always
   * writes the run before `shipped`. Written by hand, as a forged ledger would be.
   */
  forged?: true;
  contract?: string;
}

/**
 * An approved, shipped item with a before reading, a PR merged by a person, and an after reading at the merge.
 * The baseline ledger is what the harness writes: the run's own entry (executeRun appends it before it ships),
 * then the ship through appendShipped (ship.ts, the only writer of `shipped`); test/e2e/ship-closes.test.ts
 * checks the real CLI writes exactly that. A mutated shape is a forgery appendShipped refuses to write, so it is
 * written by hand, and the audit first checks that the writer does refuse it.
 */
function closable(shape: LedgerShape = {}): OutcomeFacts {
  const root = tmp();
  const contract = shape.contract ?? COMPLETE;
  writeContract(root, SLUG, contract);
  proposeItem(root, SLUG, { session: 's', before: reading('e'.repeat(40), { value: 3 }) });
  recordReply(root, SLUG, 'yes', 'tty', 's');
  const ledger = itemPaths(root, SLUG).ledger;
  const ship = { runId: 'r1', branch: 'harness/r1', headSha: HEAD, base: 'main', prUrl: 'https://example.test/pull/1' };
  const run = { runId: 'r1', status: 'done', verdict: 'DONE', contractHash: parseContract(contract).hash, ...(shape.run === 'none' ? {} : shape.run) };
  // The run's own entry, whatever its verdict, as executeRun writes it before it ships.
  if (shape.run !== 'none') appendLedger(ledger, { type: 'run', ...run });
  let entry: LedgerEntry;
  if (shape.forged === true) {
    if (shape.run !== 'none') expect(() => appendShipped(ledger, run, ship), 'the harness writer refuses this shape').toThrow();
    entry = appendLedger(ledger, { type: 'shipped', ...ship });
  } else {
    entry = appendShipped(ledger, run, ship);
  }
  if (entry.event.type !== 'shipped') throw new Error('fixture');
  const pr: PrState = { url: 'https://example.test/pull/1', number: 1, state: 'MERGED', mergedAt: '2026-11-07T10:00:00Z', mergedBy: 'a-person', mergedByBot: false, mergeSha: MERGE, baseRef: 'main', headSha: HEAD };
  return { status: itemStatus(root, SLUG), shipped: { entry, event: entry.event }, before: reading('e'.repeat(40), { value: 3 }), pr, onBase: true, beforeMerge: true, after: { ok: true, reading: reading(MERGE, { value: 0 }) } };
}

const pr = (f: OutcomeFacts): PrState => f.pr as PrState;
const OUTCOME_MUTATIONS: Array<{ name: string; mutate: (f: OutcomeFacts) => OutcomeFacts; why: RegExp }> = [
  { name: 'the metric was not read after the merge', mutate: (f) => ({ ...f, after: null }), why: /not read after the merge/ },
  { name: 'the after reading failed', mutate: (f) => ({ ...f, after: { ok: false, reason: 'Measure exited 1' } }), why: /could not be read after the merge/ },
  { name: 'the after reading is at another commit', mutate: (f) => ({ ...f, after: { ok: true, reading: reading('f'.repeat(40), { value: 0 }) } }), why: /not the merge commit/ },
  { name: 'the Measure command changed', mutate: (f) => ({ ...f, after: { ok: true, reading: reading(MERGE, { value: 0, command: 'node metrics/other.mjs' }) } }), why: /Measure command changed/ },
  { name: 'the Measure script changed', mutate: (f) => ({ ...f, after: { ok: true, reading: reading(MERGE, { value: 0, scriptSha256: '9'.repeat(64) }) } }), why: /Measure script changed/ },
  { name: 'no before reading', mutate: (f) => ({ ...f, before: null }), why: /no before value/ },
  { name: 'the harness never shipped it', mutate: (f) => ({ ...f, shipped: null }), why: /never shipped/ },
  { name: 'the PR is still open', mutate: (f) => ({ ...f, pr: { ...pr(f), state: 'OPEN', mergeSha: null, mergedBy: null } }), why: /OPEN, not merged/ },
  { name: 'the PR was closed without merging', mutate: (f) => ({ ...f, pr: { ...pr(f), state: 'CLOSED', mergeSha: null } }), why: /CLOSED, not merged/ },
  { name: 'nobody is recorded as the merger', mutate: (f) => ({ ...f, pr: { ...pr(f), mergedBy: null } }), why: /no merger on record/ },
  { name: 'a bot merged it', mutate: (f) => ({ ...f, pr: { ...pr(f), mergedBy: 'github-actions[bot]' } }), why: /a bot: a person must merge/ },
  { name: 'it merged into another base', mutate: (f) => ({ ...f, pr: { ...pr(f), baseRef: 'staging' } }), why: /merged into staging, but the contract's Base is main/ },
  { name: 'commits were added after ship', mutate: (f) => ({ ...f, pr: { ...pr(f), headSha: '7'.repeat(40) } }), why: /commits were added after ship/ },
  { name: 'GitHub could not be read', mutate: (f) => ({ ...f, pr: { error: 'gh: not authenticated' } }), why: /cannot read the PR/ },
  { name: 'the merge commit is not on the base branch', mutate: (f) => ({ ...f, onBase: { error: `merge commit ${MERGE.slice(0, 12)} is not on origin/main` } }), why: /not on origin\/main/ },
  // A bot is read from gh's JSON (is_bot) and from the login's shape, whichever says so.
  { name: 'a GitHub App merged it (login app/renovate, is_bot)', mutate: (f) => ({ ...f, pr: { ...pr(f), mergedBy: 'app/renovate', mergedByBot: true } }), why: /merged by app\/renovate, a bot/ },
  { name: 'gh says is_bot for a person-looking login', mutate: (f) => ({ ...f, pr: { ...pr(f), mergedBy: 'release-train', mergedByBot: true } }), why: /merged by release-train, a bot/ },
  { name: 'an app/ login without is_bot', mutate: (f) => ({ ...f, pr: { ...pr(f), mergedBy: 'app/automerge', mergedByBot: false } }), why: /a bot: a person must merge/ },
  // The before reading must come from before the merge.
  { name: 'the before reading was not checked against the merge', mutate: (f) => ({ ...f, beforeMerge: null }), why: /not checked against the merge/ },
  { name: 'the before reading was taken after the merge', mutate: (f) => ({ ...f, beforeMerge: { error: 'the before reading (at eeeeeeeeeeee) was not taken before the merge' } }), why: /not taken before the merge/ },
  // A reading from a Measure that ran unconfined proves nothing.
  { name: 'the before reading ran unconfined', mutate: (f) => ({ ...f, before: reading('e'.repeat(40), { value: 3, confinement: 'none' }) }), why: /before reading is UNPROVEN: the Measure ran unconfined/ },
  { name: 'the after reading ran unconfined', mutate: (f) => ({ ...f, after: { ok: true, reading: reading(MERGE, { value: 0, confinement: 'none' }) } }), why: /after reading is UNPROVEN: the Measure ran unconfined/ },
  { name: 'the after reading does not say how it was confined', mutate: (f) => ({ ...f, after: { ok: true, reading: reading(MERGE, { value: 0, confinement: '' }) } }), why: /after reading is UNPROVEN/ },
];

/** Ledger shapes: the shipped entry must follow a DONE run of the approved contract text (and the contract must name a Measure). */
const LEDGER_MUTATIONS: Array<{ name: string; shape: LedgerShape; why: RegExp }> = [
  { name: 'a shipped line with no run record before it', shape: { run: 'none', forged: true }, why: /names run r1, but the ledger holds no record of that run before it/ },
  { name: 'the run that shipped did not end DONE', shape: { run: { verdict: 'NOT DONE (final gates not green)' }, forged: true }, why: /did not end DONE/ },
  { name: 'the run record is of another run', shape: { run: { runId: 'r0' }, forged: true }, why: /no record of that run/ },
  { name: 'the run ran under another contract text', shape: { run: { contractHash: '0'.repeat(64) }, forged: true }, why: /ran under another contract text/ },
  { name: 'the contract says "Measure: none"', shape: { contract: contractFor(SLUG, { Measure: 'none' }) }, why: /no Measure: the outcome cannot be read/ },
];

describe('audit: the outcome check closes only on a reading taken after a person merged the harness PR', () => {
  it('the complete facts close the item (the baseline)', () => {
    expect(outcomeVerdict(closable())).toEqual({ ok: true, reasons: [] });
  });

  for (const m of OUTCOME_MUTATIONS) {
    it(`refuses: ${m.name}`, () => {
      const v = outcomeVerdict(m.mutate(closable()));
      expect(v.ok).toBe(false);
      expect(v.reasons.join('; ')).toMatch(m.why);
    });
  }

  for (const m of LEDGER_MUTATIONS) {
    it(`refuses: ${m.name}`, () => {
      const v = outcomeVerdict(closable(m.shape));
      expect(v.ok).toBe(false);
      expect(v.reasons.join('; ')).toMatch(m.why);
    });
  }

  it('a run that ended DONE because the gates decided (no finish call) still counts as DONE', () => {
    expect(outcomeVerdict(closable({ run: { verdict: 'DONE (the loop ended max_turns without finish; the fresh final gate run is green)' } }))).toEqual({ ok: true, reasons: [] });
  });

  it('refuses: the contract changed after the yes (the approval no longer covers it)', () => {
    const f = closable();
    const paths = f.status.paths;
    writeFileSync(paths.contract, COMPLETE.replace('its gates decide', 'its gates and I decide'));
    const v = outcomeVerdict({ ...f, status: itemStatus(paths.contract.replace(/\/docs\/contracts\/.*$/, ''), SLUG) });
    expect(v.ok).toBe(false);
    expect(v.reasons.join('; ')).toMatch(/no stakeholder yes/);
  });
});

// ───────────────────────────── the ship record ─────────────────────────────

/**
 * The one writer of `shipped` (items.ts appendShipped, called by ship) writes it only where the outcome check could
 * accept it: right after a DONE run of the run that shipped, under the approved contract text, on an item that is
 * not closed. Each mutation is a ship the writer must refuse, writing nothing (the ledger stays byte for byte).
 */
const SHIP_RUN = { runId: 'r1', status: 'ship', verdict: 'DONE (harness ship: every ship gate re-ran fresh and green)', contractHash: parseContract(COMPLETE).hash };
const SHIP_RECORD = { runId: 'r1', branch: 'harness/r1', headSha: HEAD, base: 'main', prUrl: 'https://example.test/pull/1' };
const SHIP_MUTATIONS: Array<{ name: string; run?: Partial<typeof SHIP_RUN>; shipped?: Partial<typeof SHIP_RECORD>; before?: (root: string) => void; why: RegExp }> = [
  { name: 'the run did not end DONE', run: { verdict: 'NOT DONE (final gates not green)' }, why: /did not end DONE/ },
  { name: 'the run worked under another contract text', run: { contractHash: '0'.repeat(64) }, why: /not approved: the contract changed after it was proposed/ },
  { name: 'the ship names another run', shipped: { runId: 'r0' }, why: /a ship of run r0 cannot stand on the record of run r1/ },
  { name: 'the stakeholder said no after the yes', before: (root) => void recordReply(root, SLUG, 'no, wait', 'tty', 's'), why: /not approved: Test Stakeholder did not approve/ },
  {
    name: 'the item is closed (its approval covered the work that closed it)',
    before: (root) => void appendLedger(itemPaths(root, SLUG).ledger, { type: 'closed', before: reading('e'.repeat(40), { value: 3 }), after: reading(MERGE, { value: 0 }), prUrl: SHIP_RECORD.prUrl, mergeSha: MERGE, mergedBy: 'a-person', closeRunId: 'x' }),
    why: /item "audit-item" is closed \(ledger seq \d+\): its approval covered the work that closed it; new work needs a new item/,
  },
  { name: 'the ledger is broken', before: (root) => appendFileSync(itemPaths(root, SLUG).ledger, `${JSON.stringify({ seq: 99, at: 'x', prev: 'x', hash: 'x', event: { type: 'approved' } })}\n`), why: /the item ledger is broken/ },
];

describe('audit: the ship record is written only where the outcome check could accept it, and nothing otherwise', () => {
  function approved(): string {
    const root = tmp();
    writeContract(root, SLUG, COMPLETE);
    proposeItem(root, SLUG, { session: 's', before: reading('e'.repeat(40), { value: 3 }) });
    recordReply(root, SLUG, 'yes', 'tty', 's');
    return root;
  }
  const ledgerText = (root: string): string => readFileSync(itemPaths(root, SLUG).ledger, 'utf8');

  it('a DONE run of the approved text on an open item: the run, then shipped, which the outcome check accepts (the baseline)', () => {
    const root = approved();
    const entry = appendShipped(itemPaths(root, SLUG).ledger, SHIP_RUN, SHIP_RECORD);
    if (entry.event.type !== 'shipped') throw new Error('fixture');
    const status = itemStatus(root, SLUG);
    expect(outcomeVerdict({ ...closable(), status, shipped: { entry, event: entry.event } })).toEqual({ ok: true, reasons: [] });
  });

  for (const m of SHIP_MUTATIONS) {
    it(`refuses, writing nothing: ${m.name}`, () => {
      const root = approved();
      m.before?.(root);
      const before = ledgerText(root);
      expect(() => appendShipped(itemPaths(root, SLUG).ledger, { ...SHIP_RUN, ...m.run }, { ...SHIP_RECORD, ...m.shipped })).toThrow(m.why);
      expect(ledgerText(root)).toBe(before);
    });
  }
});
