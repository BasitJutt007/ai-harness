/**
 * item reply shows what is being approved before it asks: the proposed contract text (from the ledger, which is
 * what a yes answers), its before value, every scenario and what is not included, then the prompt. A changed
 * contract file is called out. Showing the summary changes nothing about what counts: a typed yes approves, a
 * piped one does not.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdItem } from '../../src/core/item-cli.ts';
import { itemPaths, itemStatus, proposeItem } from '../../src/core/items.ts';
import { contractFor, fixtureBefore, writeContract } from '../support/items.ts';

const SLUG = 'reply-summary';
let root: string;

function reader(answer: string, isTTY = true) {
  const asked: string[] = [];
  return { asked, reader: { isTTY, ask: async (q: string) => { asked.push(q); return answer; } } };
}

async function reply(answer: string, isTTY = true) {
  const out: string[] = [];
  const r = reader(answer, isTTY);
  const timeline: string[] = [];
  const code = await cmdItem({ positionals: ['reply', SLUG], flags: new Map() }, (l) => { out.push(l); timeline.push(`out:${l}`); }, {
    root, harnessRoot: root, reader: { isTTY, ask: async (q: string) => { timeline.push(`ask:${q}`); return r.reader.ask(q); } },
  });
  return { code, out: out.join('\n'), timeline };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-summary-'));
  writeContract(root, SLUG, contractFor(SLUG, { Scenario: 'WHEN a page refreshes THEN no row repeats' }));
  proposeItem(root, SLUG, { session: 's', before: fixtureBefore(4) });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('item reply shows the proposal before it asks', () => {
  it('prints the proposed problem, before value, scenarios and exclusions, then asks; a typed yes approves', async () => {
    const r = await reply('yes');
    expect(r.out).toMatch(/reply-summary: proposal 1 to Test Stakeholder, proposed .* UTC\. You are approving:/);
    expect(r.out).toMatch(/Problem\s+Test fixture item reply-summary/);
    expect(r.out).toMatch(/Metric\s+.*before 4 \(read at origin\/main f{12}\)/);
    expect(r.out).toMatch(/Scenario\s+WHEN a page refreshes THEN no row repeats/);
    expect(r.out).toMatch(/Not incl\.\s+anything outside the fixture/);
    // The summary comes before the question, not after it.
    const firstAsk = r.timeline.findIndex((t) => t.startsWith('ask:'));
    const summary = r.timeline.findIndex((t) => t.includes('You are approving'));
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(summary).toBeLessThan(firstAsk);
    expect(r.code).toBe(0);
    expect(itemStatus(root, SLUG).editable).toBe(true);
  });

  it('says so when the contract file changed after the proposal, and the yes does not approve the changed file', async () => {
    writeFileSync(itemPaths(root, SLUG).contract, contractFor(SLUG, { Scenario: 'WHEN anything THEN something else' }));
    const r = await reply('yes');
    expect(r.out).toMatch(/Scenario\s+WHEN a page refreshes THEN no row repeats/);
    expect(r.out).toMatch(/changed after this proposal; a yes answers the text above, and the changed file needs a new proposal/);
    expect(itemStatus(root, SLUG).editable).toBe(false);
  });

  it('still shows the summary to a piped reply, which still cannot approve', async () => {
    const r = await reply('yes', false);
    expect(r.out).toMatch(/You are approving:/);
    expect(r.out).toMatch(/stdin is not a terminal/);
    expect(r.code).toBe(1);
    expect(itemStatus(root, SLUG).editable).toBe(false);
  });
});

describe('a reply to a proposal that is already approved', () => {
  it('says it was already approved instead of "not an approval"', async () => {
    await reply('yes');
    const again = await reply('yes', false);
    expect(again.out).toMatch(/recorded; nothing changes: this proposal was already approved \(Test Stakeholder approved proposal seq 1 in a typed turn \(seq \d+\)\)/);
    expect(again.out).not.toMatch(/not an approval/);
    expect(again.code).toBe(0);
  });
});
