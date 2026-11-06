/**
 * What a typed reply records and what it can approve:
 *   - the contract text it was typed against (its hash, taken by recordReply itself): a reply counts
 *     only for that text, so a yes typed while the contract read differently never approves the
 *     proposed text, even when the file is put back afterwards;
 *   - the operator's provenance: which agent-shell environment markers were present (names only). It
 *     is recorded and shown ("typed at a terminal inside an AI agent's shell"), never a refusal: a TTY
 *     proves a terminal, not a person (README, gates).
 * And "Measure: none": a complete contract without a metric script, for an interactive session (in place)
 * only: a file-mode run, its problem-gate, `harness gate problem-statement` and the problem-statement line of
 * `harness item status` refuse it, naming Measure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import problemGate from '../../plugins/hooks/problem-gate.ts';
import { cmdGate, cmdItem } from '../../src/core/item-cli.ts';
import { appendLedger, approvalVerdict, itemPaths, itemStatus, parseContract, proposeItem, readLedger, recordReply } from '../../src/core/items.ts';
import { agentEnvPresent, provenanceText } from '../../src/core/provenance.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { repoStateLocation } from '../../src/core/state-home.ts';
import { bindItem } from '../../src/core/run.ts';
import type { RunContext } from '../../src/core/types.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
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

  it('item status says why such a yes stopped counting and what to type; typed again, it approves and the note is gone (the twin)', async () => {
    const root = proposed();
    // a yes as harness versions before the reply hash recorded it: no contractHash
    appendLedger(itemPaths(root, SLUG).ledger, { type: 'human_turn', text: 'yes, approved', channel: 'tty', session: 's', inReplyTo: 1 });
    const status = async (): Promise<string> => {
      const out: string[] = [];
      await cmdItem({ positionals: ['status', SLUG], flags: new Map() }, (l) => out.push(l), { root });
      return out.join('\n');
    };
    const note = `a reply recorded without the contract text it answered does not count; type it again: harness item reply ${SLUG}`;
    const refused = await status();
    expect(refused).toMatch(/human-yes\s+REFUSE\s+no typed yes from Test Stakeholder after the proposal \(seq 1\); not counted: "yes, approved" \(seq 2\) does not record the contract text/);
    expect(refused).toContain(note);
    expect(itemStatus(root, SLUG).approval?.retype).toEqual([2]);
    const reader = { isTTY: true, ask: async () => 'yes, approved' };
    expect(await cmdItem({ positionals: ['reply', SLUG], flags: new Map() }, () => undefined, { root, reader })).toBe(0);
    const approved = await status();
    expect(approved).toMatch(/human-yes\s+pass/);
    expect(approved).not.toContain(note);
  });

  it('item status names no retype for a reply that is not a yes, or a yes answered by a later decision', () => {
    const root = proposed();
    const ledger = itemPaths(root, SLUG).ledger;
    appendLedger(ledger, { type: 'human_turn', text: 'what is the metric?', channel: 'tty', session: 's', inReplyTo: 1 });
    expect(itemStatus(root, SLUG).lines.join('\n')).not.toMatch(/type it again/);
    appendLedger(ledger, { type: 'human_turn', text: 'yes', channel: 'tty', session: 's', inReplyTo: 1 });
    expect(itemStatus(root, SLUG).lines.join('\n')).toMatch(/type it again: harness item reply reply-item/);
    // the stakeholder then declined: the decision stands, and nothing asks for the old yes again
    recordReply(root, SLUG, 'no', 'tty', 's');
    expect(itemStatus(root, SLUG).lines.join('\n')).not.toMatch(/type it again/);
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

  it("a yes typed inside an AI agent's shell approves and says so; at a plain terminal it says what no markers cannot prove (the twin)", () => {
    const inAgent = proposed();
    const r = recordReply(inAgent, SLUG, 'yes', 'tty', 's', () => new Date(), { agentEnv: ['CLAUDECODE'] });
    expect(r.verdict.ok).toBe(true);
    expect(r.verdict.reason).toMatch(/approved proposal seq 1 in a typed turn \(seq 2\): typed at a terminal inside an AI agent's shell \(CLAUDECODE\)$/);
    expect(lastTurn(inAgent)).toMatchObject({ channel: 'tty', agentEnv: ['CLAUDECODE'] });
    const plain = proposed();
    expect(recordReply(plain, SLUG, 'yes', 'tty', 's', () => new Date(), { agentEnv: [] }).verdict.reason).toMatch(/\(seq 2\): typed at a terminal \(no agent-shell markers were set, which proves nothing: .*\)$/);
  });

  it('provenanceText words each case; with no markers it states both limits of what markers prove', () => {
    const none = provenanceText('tty', []);
    expect(none).toBe("typed at a terminal (no agent-shell markers were set, which proves nothing: an agent can unset them; and a person's own yes typed in a terminal that inherits agent markers is recorded as typed inside an agent's shell)");
    // the two limits, each named: no markers proves nothing; a person's yes in an inheriting terminal reads as an agent's
    expect(none).toMatch(/proves nothing: an agent can unset them/);
    expect(none).toMatch(/a person's own yes typed in a terminal that inherits agent markers is recorded as typed inside an agent's shell/);
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

  /** An item whose approved contract says Measure: none (as a session proposes it), in a fresh items root. */
  function approvedNone(): string {
    const root = tmp();
    writeContract(root, SLUG, contractFor(SLUG, { Measure: 'none' }));
    proposeItem(root, SLUG, { session: 's', before: null });
    recordReply(root, SLUG, 'yes', 'tty', 's');
    return root;
  }
  const NAMED = /docs\/contracts\/reply-item\.md says "Measure: none", but a run outside an interactive session needs a Measure \(node metrics\/<script>\.mjs\)/;

  it('a file-mode run is refused before the first model turn, naming Measure; in place (a session) it binds (the twin)', async () => {
    const root = approvedNone();
    const registry = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    expect(() => bindItem(SLUG, registry, root)).toThrow(new RegExp(`refused before the first model turn \\(no tokens spent\\): item "${SLUG}": ${NAMED.source}`));
    expect(() => bindItem(SLUG, registry, root, { workspace: createWorkspace(root, '.') })).toThrow(NAMED);
    expect(bindItem(SLUG, registry, root, { inPlace: { repoTop: root, branch: 'feat/x' } })).toMatchObject({ slug: SLUG });
    // a contract with a Measure binds in file mode
    const withMeasure = tmp();
    writeContract(withMeasure, SLUG, CONTRACT);
    proposeItem(withMeasure, SLUG, { session: 's', before: null });
    recordReply(withMeasure, SLUG, 'yes', 'tty', 's');
    expect(bindItem(SLUG, registry, withMeasure)).toMatchObject({ slug: SLUG });
  });

  it('problem-gate blocks an edit under it in a file-mode run and passes it in place; harness gate problem-statement refuses it', async () => {
    const root = approvedNone();
    const item = { slug: SLUG, root, contractHash: parseContract(contractFor(SLUG, { Measure: 'none' })).hash };
    const call = { id: 'w', tool: 'write_file', effect: 'write' as const, input: {}, paths: ['src/a.ts'] };
    const decide = async (extra: Partial<RunContext>) => (await problemGate.run({ event: 'pre_tool', call }, { item, ...extra } as RunContext)) as { decision: string; reason?: string };
    const fileMode = await decide({ workspace: createWorkspace(root, '.') });
    expect(fileMode.decision).toBe('block');
    expect(fileMode.reason).toMatch(NAMED);
    expect((await decide({ inPlace: { repoTop: root, branch: 'feat/x' }, workspace: createWorkspace(root, '.', { visibility: 'git' }) })).decision).toBe('pass');
    const out: string[] = [];
    expect(await cmdGate({ positionals: ['problem-statement', SLUG], flags: new Map() }, (l) => out.push(l), { root, harnessRoot: root })).toBe(2);
    expect(out.join('\n')).toMatch(new RegExp(`^REFUSE {2}problem-statement {2}${SLUG}: ${NAMED.source}`));
  });

  it('harness item status agrees with harness gate: a file-mode item refuses, naming Measure; a session item in its repository passes, and so does a file-mode item with a Measure (the twins)', async () => {
    const statusLine = async (opts: Parameters<typeof cmdItem>[2]): Promise<{ lines: string[]; problem: string }> => {
      const lines: string[] = [];
      expect(await cmdItem({ positionals: ['status', SLUG], flags: new Map() }, (l) => lines.push(l), opts)).toBe(0);
      return { lines, problem: lines.find((l) => l.startsWith('  problem-statement')) ?? '' };
    };
    // file mode: the status line is the verdict the gate, problem-gate and bindItem reach, word for word
    const root = approvedNone();
    const file = await statusLine({ root });
    const gate: string[] = [];
    expect(await cmdGate({ positionals: ['problem-statement', SLUG], flags: new Map() }, (l) => gate.push(l), { root, harnessRoot: root })).toBe(2);
    expect(file.problem).toMatch(new RegExp(`^ {2}problem-statement {2}REFUSE {2}${NAMED.source}`));
    expect(file.problem.replace(/^ {2}problem-statement {2}REFUSE {2}/, '')).toBe(gate.join('\n').replace(`REFUSE  problem-statement  ${SLUG}: `, ''));
    // the stage still says what the ledger records (the stakeholder approved it)
    expect(file.lines[0]).toMatch(/^reply-item\s+approved/);
    // the twin: a file-mode item with a Measure passes both
    const measured = tmp();
    writeContract(measured, SLUG, CONTRACT);
    expect((await statusLine({ root: measured })).problem).toBe(`  problem-statement  pass  docs/contracts/${SLUG}.md names every required field`);
    // the twin: the same Measure: none contract as a session item, read inside its repository (in place, allowed)
    const repo = tmp();
    execFileSync('git', ['init', '-q', repo]);
    const env: NodeJS.ProcessEnv = { ...process.env, SF_HARNESS_HOME: tmp() };
    delete env['HARNESS_ITEMS_ROOT'];
    const loc = await repoStateLocation(repo, env);
    writeContract(loc.itemsRoot, SLUG, contractFor(SLUG, { Measure: 'none' }));
    proposeItem(loc.itemsRoot, SLUG, { session: 's', before: null });
    recordReply(loc.itemsRoot, SLUG, 'yes', 'tty', 's');
    const session = await statusLine({ cwd: repo, env });
    expect(session.lines[0]).toMatch(/^item reply-item: from this repository's session records/);
    expect(session.problem).toBe(`  problem-statement  pass  docs/contracts/${SLUG}.md names every required field`);
  });
});
