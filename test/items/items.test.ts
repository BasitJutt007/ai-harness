import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendLedger,
  approvalVerdict,
  classifyReply,
  contractVerdict,
  itemPaths,
  parseContract,
  parseMeasure,
  readLedger,
  type LedgerEvent,
} from '../../src/core/items.ts';

export const COMPLETE = `# Guard the vendor export route

Problem: Vendors without a plan can download the full leads export; QA reproduced it on 3 Nov.
Owner: web product team
Stakeholder: Abdul Basit
Repo: example-org/api-backend
Base: harness-test
Metric: unguarded export routes, harness-test HEAD before: ____ after: ____
Measure: node metrics/unguarded-routes.mjs src/modules/leads
Scenario: WHEN a vendor without the leads entitlement calls GET /leads/export THEN the API answers 403
Scenario: WHEN a vendor with the entitlement calls it THEN the CSV downloads as before
Not included:
- changing the entitlement model
- the admin export
`;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'items-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('contract parsing (problem-statement gate)', () => {
  it('accepts a contract that names every field', () => {
    const p = parseContract(COMPLETE);
    expect(p.missing).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.complete).toBe(true);
    expect(p.metric).toEqual({ name: 'unguarded export routes', window: 'harness-test HEAD', before: null, after: null });
    expect(p.measure).toEqual({ script: 'metrics/unguarded-routes.mjs', args: ['src/modules/leads'], text: 'node metrics/unguarded-routes.mjs src/modules/leads' });
    expect(p.scenarios).toHaveLength(2);
    expect(p.notIncluded).toEqual(['changing the entitlement model', 'the admin export']);
  });

  it('accepts bold field names and a Scenarios list', () => {
    const md = COMPLETE.replace('Problem:', '**Problem:**').replace(/Scenario: WHEN a vendor without/, 'Scenarios:\n- WHEN a vendor without').replace('Scenario: WHEN a vendor with the', '- WHEN a vendor with the');
    const p = parseContract(md);
    expect(p.complete).toBe(true);
    expect(p.scenarios).toHaveLength(2);
  });

  // Each required field, removed alone, is refused BY NAME; the complete twin above passes.
  for (const [field, strip] of [
    ['Problem', (s: string) => s.replace(/^Problem:.*$/m, '')],
    ['Owner', (s: string) => s.replace(/^Owner:.*$/m, '')],
    ['Stakeholder', (s: string) => s.replace(/^Stakeholder:.*$/m, '')],
    ['Repo', (s: string) => s.replace(/^Repo:.*$/m, '')],
    ['Base', (s: string) => s.replace(/^Base:.*$/m, '')],
    ['Metric', (s: string) => s.replace(/^Metric:.*$/m, '')],
    ['Measure', (s: string) => s.replace(/^Measure:.*$/m, '')],
    ['Scenario (WHEN ... THEN ...)', (s: string) => s.replace(/^Scenario:.*$/gm, '')],
    ['Not included', (s: string) => s.replace(/^Not included:[\s\S]*$/m, '')],
  ] as const) {
    it(`refuses a contract without ${field}, naming it`, () => {
      const p = parseContract(strip(COMPLETE));
      expect(p.complete).toBe(false);
      expect(p.missing).toContain(field);
    });
  }

  it('treats template placeholders as missing', () => {
    const p = parseContract(COMPLETE.replace(/^Owner:.*$/m, 'Owner: <team or person who pays for this>').replace(/^Stakeholder:.*$/m, 'Stakeholder: TBD'));
    expect(p.missing).toEqual(expect.arrayContaining(['Owner', 'Stakeholder']));
  });

  it('names a metric without a window or name', () => {
    expect(parseContract(COMPLETE.replace(/^Metric:.*$/m, 'Metric: unguarded routes, ____ before: ____ after: ____')).missing).toContain('Metric window');
    expect(parseContract(COMPLETE.replace(/^Metric:.*$/m, 'Metric: unguarded routes HEAD')).problems.join(' ')).toMatch(/Metric must read/);
  });

  it('refuses a scenario without THEN, and a placeholder scenario', () => {
    expect(parseContract(COMPLETE.replace('THEN the API answers 403', 'the API answers 403')).problems.join(' ')).toMatch(/WHEN <condition> THEN/);
    expect(parseContract(COMPLETE.replace(/^Scenario:.*$/gm, '').replace('Not included:', 'Scenario: WHEN <condition> THEN <observable result>\nNot included:')).missing).toContain('Scenario (WHEN ... THEN ...)');
  });

  it('accepts only node metrics/<script>.mjs with plain arguments as the Measure', () => {
    expect(parseMeasure('node metrics/a.mjs src')).toMatchObject({ script: 'metrics/a.mjs', args: ['src'] });
    expect(parseMeasure('`node metrics/a.mjs`')).toMatchObject({ script: 'metrics/a.mjs', args: [] });
    for (const bad of ['npm test', 'node scripts/a.mjs', 'node metrics/../x.mjs', 'node metrics/a.mjs; rm -rf /', 'node metrics/a.mjs $(id)', 'node metrics/a.mjs ../../etc', 'bash metrics/a.mjs', 'node /abs/metrics/a.mjs']) {
      expect('error' in parseMeasure(bad), bad).toBe(true);
    }
  });

  it('binds the hash to the approval-relevant text only', () => {
    const base = parseContract(COMPLETE).hash;
    // the harness writes Signed and the before/after values: the approval stays bound
    expect(parseContract(`${COMPLETE}\nSigned: Abdul Basit, 2026-11-05 (recorded by the harness)\n`).hash).toBe(base);
    expect(parseContract(COMPLETE.replace('before: ____ after: ____', 'before: 4 after: 0')).hash).toBe(base);
    // any change a stakeholder approves is part of it
    expect(parseContract(COMPLETE.replace('answers 403', 'answers 401')).hash).not.toBe(base);
    expect(parseContract(COMPLETE.replace('the admin export', 'nothing')).hash).not.toBe(base);
    expect(parseContract(COMPLETE.replace('src/modules/leads', 'src')).hash).not.toBe(base);
  });

  it('contractVerdict names the file and the missing fields', () => {
    const root = tmp();
    const paths = itemPaths(root, 'guard-export');
    expect(contractVerdict(paths).reason).toMatch(/no contract for item "guard-export": write docs\/contracts\/guard-export\.md/);
    writeFileSync(join(root, 'c.md'), '');
    const v = contractVerdict(paths, () => COMPLETE.replace(/^Owner:.*$/m, ''));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/docs\/contracts\/guard-export\.md is incomplete: missing Owner/);
    expect(contractVerdict(paths, () => COMPLETE).ok).toBe(true);
  });

  it('rejects invalid slugs', () => {
    for (const bad of ['', 'A', 'a', '../x', 'a/b', 'a b', '-a']) expect(() => itemPaths('/r', bad), bad).toThrow(/invalid item slug/);
    expect(itemPaths('/r', 'ok-1').contract).toBe('/r/docs/contracts/ok-1.md');
  });
});

describe('item ledger', () => {
  const turn = (text: string): LedgerEvent => ({ type: 'human_turn', text, channel: 'tty', session: 's1', inReplyTo: null });
  function twoLines(): string {
    const file = join(tmp(), 'items', 's', 'ledger.jsonl');
    appendLedger(file, turn('hello'));
    appendLedger(file, turn('again'));
    return file;
  }

  it('appends a verified hash chain (the legitimate twin)', () => {
    const l = readLedger(twoLines());
    expect(l.problems).toEqual([]);
    expect(l.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(l.entries[1]?.prev).toBe(l.entries[0]?.hash);
  });

  it('detects an edit of an earlier entry, and refuses to extend the broken chain', () => {
    const file = twoLines();
    const lines = readFileSync(file, 'utf8').split('\n');
    writeFileSync(file, [lines[0]?.replace('hello', 'yes'), ...lines.slice(1)].join('\n'));
    expect(readLedger(file).problems.join(' ')).toMatch(/line 1 does not match its own hash/);
    expect(() => appendLedger(file, turn('x'))).toThrow(/broken/);
  });

  it('detects an edit of the LAST entry (no later line chains to it)', () => {
    const file = twoLines();
    writeFileSync(file, readFileSync(file, 'utf8').replace('"again"', '"yes"'));
    expect(readLedger(file).problems.join(' ')).toMatch(/line 2 does not match its own hash/);
  });

  it('detects a deleted entry and a hand-appended one', () => {
    const file = twoLines();
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    writeFileSync(file, `${lines[1]}\n`);
    expect(readLedger(file).problems.join(' ')).toMatch(/seq 2 \(expected 1\)|does not chain/);
    const file2 = twoLines();
    writeFileSync(file2, `${readFileSync(file2, 'utf8')}${JSON.stringify({ seq: 3, at: 'x', prev: 'forged', event: turn('yes'), hash: 'forged' })}\n`);
    expect(readLedger(file2).problems.join(' ')).toMatch(/line 3 does not chain/);
  });
});

describe('stakeholder replies', () => {
  it.each([
    ['yes', 'yes'],
    ['Yes, go ahead with it.', 'yes'],
    ['approved', 'yes'],
    ['Looks good, ship it', 'yes'],
    ['lgtm', 'yes'],
    ['no', 'no'],
    ['not yet', 'no'],
    ['change the metric to the admin export', 'no'],
    ['yes but change the metric', 'unclear'],
    ['ok, but without the admin part', 'unclear'],
    ['yes?', 'unclear'],
    ['can you show me the metric first?', 'unclear'],
    ['y', 'unclear'],
    ['', 'unclear'],
    ['hmm', 'unclear'],
  ])('%j reads as %s', (text, kind) => {
    expect(classifyReply(text).kind).toBe(kind);
  });
});

describe('approval verdict (human-yes gate)', () => {
  const hash = parseContract(COMPLETE).hash;
  function ledgerWith(events: LedgerEvent[]): ReturnType<typeof readLedger> {
    const file = join(tmp(), 'ledger.jsonl');
    for (const e of events) appendLedger(file, e);
    return readLedger(file);
  }
  const proposed: LedgerEvent = { type: 'proposed', contractHash: hash, stakeholder: 'Abdul Basit', before: null, session: 's1', text: COMPLETE };
  const typed = (text: string, inReplyTo: number | null = 1, channel: 'tty' | 'pipe' = 'tty'): LedgerEvent => ({ type: 'human_turn', text, channel, session: 's1', inReplyTo });

  it('approves a typed yes after the proposal (the legitimate twin)', () => {
    const v = approvalVerdict(ledgerWith([proposed, typed('Yes, go ahead')]), hash);
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/Abdul Basit approved proposal seq 1 in a typed turn \(seq 2\)/);
  });

  it('refuses when nothing was proposed', () => {
    expect(approvalVerdict(ledgerWith([typed('yes', null)]), hash).reason).toMatch(/never proposed/);
  });

  it('refuses a yes typed before the proposal', () => {
    const v = approvalVerdict(ledgerWith([typed('yes', null), proposed]), hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/came before the proposal/);
  });

  it('refuses a yes that arrived on a pipe', () => {
    const v = approvalVerdict(ledgerWith([proposed, typed('yes', 1, 'pipe')]), hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/arrived on a pipe, not typed at a terminal/);
  });

  it('refuses when the contract changed after the proposal', () => {
    const v = approvalVerdict(ledgerWith([proposed, typed('yes')]), parseContract(COMPLETE.replace('403', '401')).hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/changed after it was proposed/);
  });

  it('refuses a decline and an ambiguous reply; a later plain yes approves', () => {
    expect(approvalVerdict(ledgerWith([proposed, typed('no, change the window')]), hash).reason).toMatch(/did not approve/);
    expect(approvalVerdict(ledgerWith([proposed, typed('yes but change the window')]), hash).reason).toMatch(/not a plain yes/);
    expect(approvalVerdict(ledgerWith([proposed, typed('no'), typed('ok, approved now')]), hash).ok).toBe(true);
    expect(approvalVerdict(ledgerWith([proposed, typed('yes'), typed('no, wait')]), hash).ok).toBe(false);
  });

  it('refuses a reply to an older proposal', () => {
    const v = approvalVerdict(ledgerWith([proposed, typed('yes'), proposed]), hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no typed yes .* after the proposal \(seq 3\)/);
  });

  it('refuses a hand-edited "no" turned into "yes" (ledger broken), though the text now reads yes', () => {
    const file = join(tmp(), 'ledger.jsonl');
    appendLedger(file, proposed);
    appendLedger(file, typed('no'));
    writeFileSync(file, readFileSync(file, 'utf8').replace('"text":"no"', '"text":"yes"'));
    const v = approvalVerdict(readLedger(file), hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/ledger is broken/);
  });
});
