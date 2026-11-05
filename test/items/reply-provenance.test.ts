/**
 * What a typed reply records and what it can approve:
 *   - the contract text it was typed against (its hash, taken by recordReply itself): a reply counts
 *     only for that text, so a yes typed while the contract read differently never approves the
 *     proposed text, even when the file is put back afterwards;
 *   - the operator's provenance: which agent-shell environment markers were present (names only). It
 *     is recorded and shown ("typed at a terminal inside an AI agent's shell"), never a refusal: a TTY
 *     proves a terminal, not a person (README, gates).
 * And "Measure: none": a complete contract without a metric script.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { cmdItem } from '../../src/core/item-cli.ts';
import { appendLedger, approvalVerdict, itemPaths, itemStatus, parseContract, proposeItem, readLedger, recordReply } from '../../src/core/items.ts';
import { agentEnvPresent, provenanceText } from '../../src/core/provenance.ts';
import { contractFor, writeContract } from '../support/items.ts';

const SLUG = 'reply-item';
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'reply-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTRACT = contractFor(SLUG);
const OTHER = CONTRACT.replace('its gates decide', 'its gates and I decide');

function proposed(): string {
  const root = tmp();
  writeContract(root, SLUG, CONTRACT);
  proposeItem(root, SLUG, { session: 's', before: null });
  return root;
}

const lastTurn = (root: string) => readLedger(itemPaths(root, SLUG).ledger).entries.filter((e) => e.event.type === 'human_turn').at(-1)?.event;

describe('a reply counts only for the contract text it was typed against', () => {
  it('recordReply stores the hash of the contract on disk at that moment (6-argument call kept)', () => {
    const root = proposed();
    recordReply(root, SLUG, 'yes', 'tty', 's', () => new Date());
    expect(lastTurn(root)).toMatchObject({ type: 'human_turn', contractHash: parseContract(CONTRACT).hash });
  });

  it('a yes typed while the contract read differently does not approve the proposed text, even once the file is put back', () => {
    const root = proposed();
    const c = itemPaths(root, SLUG).contract;
    writeFileSync(c, OTHER);
    recordReply(root, SLUG, 'yes, go ahead', 'tty', 's');
    writeFileSync(c, CONTRACT);
    const v = approvalVerdict(readLedger(itemPaths(root, SLUG).ledger), parseContract(CONTRACT).hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/was typed while the contract read differently \([0-9a-f]{12}\), not the proposed text/);
    // the twin: the same yes typed against the proposed text approves it
    recordReply(root, SLUG, 'yes, go ahead', 'tty', 's');
    expect(itemStatus(root, SLUG).stage).toBe('approved');
  });

  it('a "no" stands whatever text it was typed against: it revokes an earlier yes (fail closed)', () => {
    const root = proposed();
    recordReply(root, SLUG, 'yes', 'tty', 's');
    expect(itemStatus(root, SLUG).stage).toBe('approved');
    const c = itemPaths(root, SLUG).contract;
    writeFileSync(c, OTHER);
    recordReply(root, SLUG, 'no, wait', 'tty', 's');
    writeFileSync(c, CONTRACT);
    const v = approvalVerdict(readLedger(itemPaths(root, SLUG).ledger), parseContract(CONTRACT).hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/did not approve \(seq \d+: "no, wait"\)/);
  });

  it('a reply entry that does not record its contract text (an older entry, a hand-written one) never counts', () => {
    const root = proposed();
    appendLedger(itemPaths(root, SLUG).ledger, { type: 'human_turn', text: 'yes', channel: 'tty', session: 's', inReplyTo: 1 });
    const v = approvalVerdict(readLedger(itemPaths(root, SLUG).ledger), parseContract(CONTRACT).hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not record the contract text it was typed against/);
  });
});

describe("operator provenance: recorded and shown, never a refusal", () => {
  it('agentEnvPresent names the set markers only (prefix markers expand to the names found; values never recorded)', () => {
    const env = { CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt', CODEX_HOME: '/x', AI_AGENT: '', GEMINI_CLI_X: '1', PATH: '/bin' };
    const markers = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_*', 'CURSOR_AGENT', 'GEMINI_CLI'];
    expect(agentEnvPresent(env, markers)).toEqual(['CLAUDECODE', 'CODEX_HOME', 'CODEX_SANDBOX']);
    expect(agentEnvPresent({ PATH: '/bin' }, markers)).toEqual([]);
  });

  it('the harness configuration names the agent markers, and every config keeps the generic one', () => {
    const markers = loadConfig(HARNESS_ROOT).agentEnvMarkers ?? [];
    for (const m of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_*', 'CURSOR_AGENT', 'GEMINI_CLI']) expect(markers).toContain(m);
    const root = tmp();
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ agentEnvMarkers: ['MY_AGENT'] }));
    expect(loadConfig(root).agentEnvMarkers).toEqual(['MY_AGENT', 'AI_AGENT']);
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ agentEnvMarkers: ['not a name'] }));
    expect(() => loadConfig(root)).toThrow(/agentEnvMarkers/);
  });

  it("a yes typed inside an AI agent's shell approves and says so; at a plain terminal it says only that (the twin)", () => {
    const inAgent = proposed();
    const r = recordReply(inAgent, SLUG, 'yes', 'tty', 's', () => new Date(), { agentEnv: ['CLAUDECODE'] });
    expect(r.verdict.ok).toBe(true);
    expect(r.verdict.reason).toMatch(/approved proposal seq 1 in a typed turn \(seq 2\): typed at a terminal inside an AI agent's shell \(CLAUDECODE\)$/);
    expect(lastTurn(inAgent)).toMatchObject({ channel: 'tty', agentEnv: ['CLAUDECODE'] });
    const plain = proposed();
    expect(recordReply(plain, SLUG, 'yes', 'tty', 's', () => new Date(), { agentEnv: [] }).verdict.reason).toMatch(/\(seq 2\): typed at a terminal$/);
  });

  it('provenanceText words each case', () => {
    expect(provenanceText('tty', [])).toBe('typed at a terminal');
    expect(provenanceText('tty', ['AI_AGENT', 'CODEX_HOME'])).toBe("typed at a terminal inside an AI agent's shell (AI_AGENT, CODEX_HOME)");
    expect(provenanceText('pipe', [])).toBe('piped in (not typed at a terminal)');
    expect(provenanceText('tty', undefined)).toBe('typed at a terminal (agent markers not recorded)');
  });

  it('item reply prints it in the approval message, and item status shows it', async () => {
    const root = proposed();
    const out: string[] = [];
    const reader = { isTTY: true, ask: async () => 'yes, approved' };
    expect(await cmdItem({ positionals: ['reply', SLUG], flags: new Map() }, (l) => out.push(l), { root, reader })).toBe(0);
    expect(out.join('\n')).toMatch(/^approved: Test Stakeholder approved proposal seq 1 in a typed turn \(seq 2\): typed at a terminal/m);
    const status: string[] = [];
    await cmdItem({ positionals: ['status', SLUG], flags: new Map() }, (l) => status.push(l), { root });
    expect(status.join('\n')).toMatch(/human-yes\s+pass\s+.*: typed at a terminal/);
    expect(status.join('\n')).toMatch(/operator\s+reply seq 2: typed at a terminal/);
    expect(readFileSync(itemPaths(root, SLUG).contract, 'utf8')).toMatch(/^Signed: Test Stakeholder/m);
  });
});

describe('"Measure: none": a complete contract without a metric script', () => {
  it('is complete, with no Measure and noMeasure set; a placeholder Measure is still missing (the twin)', () => {
    const none = parseContract(contractFor(SLUG, { Measure: 'none' }));
    expect(none).toMatchObject({ complete: true, measure: null, noMeasure: true });
    expect(parseContract(contractFor(SLUG, { Measure: '`None`' })).noMeasure).toBe(true);
    for (const p of ['TBD', 'N/A', '____', '<script>']) {
      const c = parseContract(contractFor(SLUG, { Measure: p }));
      expect(c.missing, p).toContain('Measure');
      expect(c.noMeasure).toBe(false);
    }
    expect(parseContract(CONTRACT)).toMatchObject({ noMeasure: false, measure: { script: 'metrics/fixture-zero.mjs' } });
    // what was approved includes the choice: none and a script are different texts
    expect(none.hash).not.toBe(parseContract(CONTRACT).hash);
  });
});
