/**
 * `harness gate problem-statement|human-yes <slug>` and `harness gate outcome <slug> [--repo <dir>]`: one gate's verdict on an
 * item now, PASS (exit 0) or REFUSE (exit 2) with the reason, recording nothing; a usage error exits 64. And a gate's source
 * file run on its own points at it (exit 2) instead of exiting 0 in silence; imported, it says nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { main } from '../../src/core/cli.ts';
import { cmdGate, cmdItem } from '../../src/core/item-cli.ts';
import { appendLedger, appendShipped, itemPaths, parseContract, proposeItem, recordReply } from '../../src/core/items.ts';
import { isMainModule } from '../../src/core/main-module.ts';
import { contractFor, writeContract } from '../support/items.ts';

const SLUG = 'gate-item';
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gate-cli-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function gate(root: string, ...positionals: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await cmdGate({ positionals, flags: new Map() }, (l) => lines.push(l), { root, harnessRoot: root });
  return { code, text: lines.join('\n') };
}

const reading = { value: 3, sha: 'a'.repeat(40), ref: 'origin/main', command: 'node metrics/fixture-zero.mjs', scriptSha256: 'b'.repeat(64), stdoutSha256: 'c'.repeat(64), excerpt: '3', confinement: 'sandbox-exec' };

describe('harness gate', () => {
  it('problem-statement: REFUSE (exit 2) without a complete contract, naming what is missing; PASS (exit 0) with one', async () => {
    const root = tmp();
    expect(await gate(root, 'problem-statement', SLUG)).toEqual({ code: 2, text: `REFUSE  problem-statement  ${SLUG}: no contract for item "${SLUG}": write docs/contracts/${SLUG}.md (Problem, Owner, Stakeholder, Repo, Base, Commit, Metric, Measure, Scenario, Not included) before any source edit` });
    writeContract(root, SLUG, contractFor(SLUG, { Owner: 'TBD' }));
    expect((await gate(root, 'problem-statement', SLUG)).text).toMatch(/^REFUSE {2}problem-statement {2}gate-item: .* is incomplete: missing Owner$/);
    writeContract(root, SLUG);
    expect(await gate(root, 'problem-statement', SLUG)).toEqual({ code: 0, text: `PASS  problem-statement  ${SLUG}: docs/contracts/${SLUG}.md names every required field` });
  });

  it('human-yes: REFUSE until the typed yes, then PASS saying how it arrived; nothing is recorded by the check', async () => {
    const root = tmp();
    writeContract(root, SLUG);
    proposeItem(root, SLUG, { session: 's', before: null });
    const ledger = readFileSync(itemPaths(root, SLUG).ledger, 'utf8');
    const refused = await gate(root, 'human-yes', SLUG);
    expect(refused).toEqual({ code: 2, text: `REFUSE  human-yes  ${SLUG}: no typed yes from Test Stakeholder after the proposal (seq 1)` });
    expect(readFileSync(itemPaths(root, SLUG).ledger, 'utf8')).toBe(ledger);
    recordReply(root, SLUG, 'yes', 'tty', 's', () => new Date(), { agentEnv: ['AI_AGENT'] });
    expect(await gate(root, 'human-yes', SLUG)).toEqual({ code: 0, text: `PASS  human-yes  ${SLUG}: Test Stakeholder approved proposal seq 1 in a typed turn (seq 2): typed at a terminal inside an AI agent's shell (AI_AGENT)` });
  });

  it('outcome: REFUSE with what the records lack; PASS only on a closed item, with before and after', async () => {
    const root = tmp();
    writeContract(root, SLUG);
    proposeItem(root, SLUG, { session: 's', before: reading });
    recordReply(root, SLUG, 'yes', 'tty', 's');
    expect(await gate(root, 'outcome', SLUG)).toMatchObject({ code: 2, text: expect.stringMatching(/^REFUSE {2}outcome {2}gate-item: the harness never shipped this item/) });
    const ledger = itemPaths(root, SLUG).ledger;
    // What the harness writes: the run's own entry (executeRun, before it ships), then the ship (appendShipped).
    const run = { runId: 'r1', status: 'done', verdict: 'DONE', contractHash: parseContract(contractFor(SLUG)).hash };
    appendLedger(ledger, { type: 'run', ...run });
    appendShipped(ledger, run, { runId: 'r1', branch: 'harness/r1', headSha: 'd'.repeat(40), base: 'main', prUrl: 'https://example.test/pull/1' });
    expect((await gate(root, 'outcome', SLUG)).text).toMatch(/REFUSE {2}outcome {2}gate-item: not closed: harness item close gate-item --repo <dir> reads the metric after the PR merged and records it \(pass --repo <dir> to check GitHub and the metric now\)/);
    appendLedger(ledger, { type: 'closed', before: reading, after: { ...reading, value: 0, sha: 'e'.repeat(40) }, prUrl: 'https://example.test/pull/1', mergeSha: 'e'.repeat(40), mergedBy: 'a-person', closeRunId: 'x' });
    expect(await gate(root, 'outcome', SLUG)).toEqual({ code: 0, text: `PASS  outcome  ${SLUG}: closed at ledger seq 7: before 3 (at aaaaaaaaaaaa) -> after 0 (at the merge eeeeeeeeeeee, merged by a-person)` });
  });

  it('usage errors exit 64 (never 2, which is REFUSE) with the usage line: an unknown gate, a missing slug, an unknown option', async () => {
    const root = tmp();
    const usage = 'usage: harness gate problem-statement|human-yes <slug>, or harness gate outcome <slug> [--repo <dir>]';
    for (const args of [['stakeholder', SLUG], ['outcome'], [], ['human-yes', SLUG, 'extra']]) {
      const r = await gate(root, ...args);
      expect(r.code, args.join(' ')).toBe(64);
      expect(r.text).toBe(usage);
    }
    const lines: string[] = [];
    expect(await cmdGate({ positionals: ['human-yes', SLUG], flags: new Map([['yes', ['1']]]) }, (l) => lines.push(l), { root })).toBe(64);
    expect(lines.join('\n')).toMatch(/^unknown option --yes/);
    // through the real CLI too: an option without its value is a usage error of harness gate, not a REFUSE
    const cli: string[] = [];
    expect(await main(['gate', 'outcome', SLUG, '--repo'], (l) => cli.push(l))).toBe(64);
    expect(cli.join('\n')).toBe(`--repo needs a value\n${usage}`);
  });

  it('an option given without a value (--ship, --dry-run, --json, --baseline, --strict-task) and an invalid slug are usage errors (64); without them the gate decides (the twin)', async () => {
    const root = tmp();
    writeContract(root, SLUG);
    proposeItem(root, SLUG, { session: 's', before: null });
    recordReply(root, SLUG, 'yes', 'tty', 's');
    const usage = 'usage: harness gate problem-statement|human-yes <slug>, or harness gate outcome <slug> [--repo <dir>]';
    for (const flag of ['ship', 'dry-run', 'json', 'baseline', 'strict-task']) {
      const lines: string[] = [];
      expect(await cmdGate({ positionals: ['human-yes', SLUG], flags: new Map(), bools: new Set([flag]) }, (l) => lines.push(l), { root, harnessRoot: root }), flag).toBe(64);
      expect(lines.join('\n')).toBe(`unknown option --${flag}\n${usage}`);
    }
    expect((await gate(root, 'human-yes', SLUG)).code).toBe(0);
    // a mistyped slug is not a verdict on an item: 64 before anything is read; a well-formed one gets its verdict
    for (const bad of ['Users_API', 'a', '../x', '-x']) {
      const r = await gate(root, 'human-yes', bad);
      expect(r.code, bad).toBe(64);
      expect(r.text).toBe(`invalid item slug "${bad}": use lower-case letters, digits and dashes (2-63 characters)\n${usage}`);
    }
    expect(await gate(root, 'human-yes', 'users-api')).toMatchObject({ code: 2, text: expect.stringMatching(/^REFUSE {2}human-yes {2}users-api: /) });
    // through the real CLI: the parsed --json reaches harness gate as an option it refuses
    const cli: string[] = [];
    expect(await main(['gate', 'problem-statement', 'no-such-item', '--json'], (l) => cli.push(l))).toBe(64);
    expect(cli.join('\n')).toBe(`unknown option --json\n${usage}`);
    expect(await main(['gate', 'problem-statement', 'no-such-item'], () => undefined)).toBe(2);
  });

  it('harness item takes no option but --repo either, and refuses an invalid slug as a usage error (2); without them it answers (the twin)', async () => {
    const root = tmp();
    writeContract(root, SLUG);
    const run = async (positionals: string[], bools?: Set<string>): Promise<{ code: number; text: string }> => {
      const lines: string[] = [];
      const code = await cmdItem({ positionals, flags: new Map(), ...(bools !== undefined ? { bools } : {}) }, (l) => lines.push(l), { root, harnessRoot: root });
      return { code, text: lines.join('\n') };
    };
    for (const flag of ['ship', 'json', 'dry-run']) {
      const r = await run(['status', SLUG], new Set([flag]));
      expect(r.code, flag).toBe(2);
      expect(r.text).toMatch(new RegExp(`^unknown option --${flag}: no item command takes a value from the command line`));
    }
    const bad = await run(['status', 'Gate_Item']);
    expect(bad.code).toBe(2);
    expect(bad.text).toMatch(/^invalid item slug "Gate_Item": use lower-case letters, digits and dashes \(2-63 characters\)\nusage: harness item /);
    expect(await run(['status', SLUG])).toMatchObject({ code: 0, text: expect.stringMatching(/^gate-item\s+unproposed/) });
  });

  it('--repo is refused (64) for problem-statement and human-yes, where it does nothing; outcome takes it (the twin)', async () => {
    const root = tmp();
    writeContract(root, SLUG);
    proposeItem(root, SLUG, { session: 's', before: null });
    recordReply(root, SLUG, 'yes', 'tty', 's');
    const withRepo = async (name: string): Promise<{ code: number; text: string }> => {
      const lines: string[] = [];
      const code = await cmdGate({ positionals: [name, SLUG], flags: new Map([['repo', [root]]]) }, (l) => lines.push(l), { root, harnessRoot: root, exec: async () => ({ code: 1, stdout: '', stderr: 'offline', durationMs: 0, timedOut: false }) });
      return { code, text: lines.join('\n') };
    };
    for (const name of ['problem-statement', 'human-yes']) {
      const r = await withRepo(name);
      expect(r.code, name).toBe(64);
      expect(r.text).toMatch(new RegExp(`^--repo does nothing for the ${name} gate: it reads only the item's contract and ledger \\(only the outcome gate reads a clone\\)\\nusage: `));
      // without it, the same gate decides (PASS here)
      expect((await gate(root, name, SLUG)).code, name).toBe(0);
    }
    const outcome = await withRepo('outcome');
    expect(outcome.code).toBe(2);
    expect(outcome.text).toMatch(/^REFUSE {2}outcome {2}gate-item: /);
  });
});

describe("a gate's source file run on its own", () => {
  for (const [file, gateName] of [
    ['plugins/hooks/problem-gate.ts', 'problem-statement'],
    ['plugins/hooks/contract-gate.ts', 'human-yes'],
    ['plugins/gates/stakeholder-yes.ts', 'human-yes'],
    ['src/core/close.ts', 'outcome'],
  ] as const) {
    it(`${file}: prints a pointer to harness gate ${gateName} and exits 2 (never a silent 0)`, () => {
      const r = spawnSync(process.execPath, [join(HARNESS_ROOT, file)], { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stdout).toContain(`harness gate ${gateName} <slug>`);
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
    });
  }

  it('imported (by the registry, a test, the CLI) it says nothing: only the program being run is the main module', () => {
    const url = new URL('../../plugins/hooks/problem-gate.ts', import.meta.url).href;
    expect(isMainModule(url, ['node', join(HARNESS_ROOT, 'bin', 'harness.mjs')])).toBe(false);
    expect(isMainModule(url, ['node', join(HARNESS_ROOT, 'plugins', 'hooks', 'problem-gate.ts')])).toBe(true);
    expect(isMainModule(url, ['node'])).toBe(false);
  });
});
