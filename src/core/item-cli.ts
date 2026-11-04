/**
 * `harness item ...`: the backlog item lifecycle at the terminal (assignment 02).
 *
 *   item new <slug>                  write docs/contracts/<slug>.md from the template (every field a placeholder)
 *   item status [<slug>]             each item's stage and gate lines (nothing is changed)
 *   item propose <slug> --repo <dir> read the metric's before value at origin/<Base>, record the proposal,
 *                                    show it, and (at a terminal) take the stakeholder's reply
 *   item reply <slug>                the stakeholder types their reply to the latest proposal
 *   item close <slug> --repo <dir>   the outcome check (close.ts): merged PR + after reading, or refuse
 *
 * A reply counts only when it was typed at an interactive terminal: the reader records the channel
 * ('tty' or 'pipe') from process.stdin itself, and approvalVerdict accepts 'tty' only. No command
 * here takes a metric value, a yes or a close on anyone's word.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { closeItem } from './close.ts';
import { HARNESS_ROOT } from './config.ts';
import { exec as coreExec, passThroughEnv } from './exec.ts';
import { classifyReply, CONTRACTS_DIR, itemPaths, itemsRoot, itemStatus, proposeItem, readLedger, recordReply, type ItemStatus, type MetricReading } from './items.ts';
import { readMetric } from './measure.ts';
import { repoCommitlint } from './ship-text.ts';
import type { Exec } from './types.ts';

type Out = (line: string) => void;

export interface ItemArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

/** Where the stakeholder's reply comes from. The real one reads process.stdin and says whether it is a terminal. */
export interface ReplyReader {
  isTTY: boolean;
  ask(prompt: string): Promise<string | null>;
}

export function terminalReader(): ReplyReader {
  return {
    isTTY: process.stdin.isTTY === true,
    ask: (prompt) =>
      new Promise((done) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
        let answered = false;
        rl.question(prompt, (a) => {
          answered = true;
          rl.close();
          done(a);
        });
        rl.on('close', () => {
          if (!answered) done(null);
        });
      }),
  };
}

export const CONTRACT_TEMPLATE = (slug: string): string => `# ${slug}

Problem: <what breaks, in the stakeholder's words, with evidence>
Owner: <team or person who pays for this>
Stakeholder: <the person whose typed yes approves this contract>
Repo: <owner/name of the repository the change lands in>
Base: <branch the harness PR targets>
Commit: <type>(<scope>): <subject naming what changes: the header the harness commits and titles the PR with>
Metric: <name>, <window> before: ____ after: ____
Measure: node metrics/<script>.mjs [args]
Scenario: WHEN <condition> THEN <observable result>
Not included: <what you are deliberately not building>
`;

function one(a: ItemArgs, name: string): string | undefined {
  const v = a.flags.get(name);
  return v === undefined ? undefined : v[v.length - 1];
}

function stageLine(s: ItemStatus): string {
  const m = s.contract.parse?.metric;
  const readings = s.ledger.entries.filter((e) => e.event.type === 'metric').map((e) => (e.event.type === 'metric' ? `${e.event.phase} ${e.event.reading.value}` : ''));
  const handAfter = m?.after !== null && m?.after !== undefined && !s.ledger.entries.some((e) => e.event.type === 'closed');
  return `${s.slug.padEnd(28)} ${s.stage.padEnd(13)}${m !== undefined && m !== null ? ` ${m.name}: ${readings.length > 0 ? readings.join(', ') : 'not read'}` : ''}${handAfter ? `  (contract says after ${m?.after ?? ''}: written by hand, no harness reading; ignored)` : ''}`;
}

/** The target clone's origin must be the contract's Repo (reading a metric on another repository proves nothing). */
async function checkOrigin(repoDir: string, repo: string, run: Exec): Promise<string | null> {
  const r = await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { cwd: repoDir });
  if (r.code !== 0) return `${repoDir} has no origin remote`;
  const url = r.stdout.trim().replace(/\.git$/, '');
  return new RegExp(`[/:]${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(url) ? null : `${repoDir}'s origin is ${url}, not ${repo}`;
}

async function askReply(root: string, slug: string, reader: ReplyReader, out: Out, session: string): Promise<number> {
  const s = itemStatus(root, slug);
  const proposal = s.approval?.proposal ?? null;
  if (proposal === null) {
    out(`refused: ${slug} has no proposal to reply to (harness item propose ${slug} --repo <dir>)`);
    return 1;
  }
  const stakeholder = s.approval?.stakeholder ?? 'stakeholder';
  if (!reader.isTTY) out(`note: stdin is not a terminal, so this reply is recorded as piped and cannot approve (only a reply typed at a terminal counts)`);
  const text = await reader.ask(`${stakeholder}, reply to proposal ${proposal} in your own words (approve it, or say what to change): `);
  if (text === null || text.trim().length === 0) {
    out('no reply recorded');
    return 1;
  }
  const { entry, verdict } = recordReply(root, slug, text.trim(), reader.isTTY ? 'tty' : 'pipe', session);
  if (verdict.ok && verdict.turn?.seq === entry.seq) {
    out(`approved: ${verdict.reason}; the harness wrote the Signed line in ${CONTRACTS_DIR}/${slug}.md`);
    return 0;
  }
  const kind = classifyReply(text).kind;
  out(kind === 'no' ? `recorded: ${stakeholder} did not approve; change the contract and propose it again` : `recorded, not an approval: ${verdict.reason}`);
  return 1;
}

export async function cmdItem(a: ItemArgs, out: Out, opts: { reader?: ReplyReader; exec?: Exec; root?: string; harnessRoot?: string } = {}): Promise<number> {
  const harnessRoot = opts.harnessRoot ?? HARNESS_ROOT;
  const root = opts.root ?? itemsRoot(harnessRoot);
  const run = opts.exec ?? coreExec;
  const reader = opts.reader ?? terminalReader();
  const session = randomUUID().slice(0, 8);
  const [sub, slug, ...extra] = a.positionals;
  const usage = 'usage: harness item new|status|propose|reply|close <slug> [--repo <dir>]';
  if (sub === undefined || extra.length > 0) {
    out(usage);
    return 2;
  }
  // No option supplies a value, a yes or a close: anything but --repo is refused, never ignored.
  const unknown = [...a.flags.keys()].find((k) => k !== 'repo');
  if (unknown !== undefined) {
    out(`unknown option --${unknown}: no item command takes a value from the command line (the harness reads the metric and the reply itself)\n${usage}`);
    return 2;
  }
  try {
    switch (sub) {
      case 'new': {
        if (slug === undefined) break;
        const paths = itemPaths(root, slug);
        if (existsSync(paths.contract)) {
          out(`refused: ${CONTRACTS_DIR}/${slug}.md already exists`);
          return 1;
        }
        mkdirSync(dirname(paths.contract), { recursive: true });
        writeFileSync(paths.contract, CONTRACT_TEMPLATE(slug));
        out(`wrote ${CONTRACTS_DIR}/${slug}.md: fill in every field, then harness item propose ${slug} --repo <dir>`);
        return 0;
      }
      case 'status': {
        const slugs = slug !== undefined ? [slug] : existsSync(resolve(root, CONTRACTS_DIR)) ? readdirSync(resolve(root, CONTRACTS_DIR)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [];
        if (slugs.length === 0) out('no items (docs/contracts/ is empty)');
        for (const s of slugs) {
          const st = itemStatus(root, s);
          out(stageLine(st));
          if (slug !== undefined) for (const l of st.lines) out(`  ${l}`);
        }
        return 0;
      }
      case 'propose': {
        if (slug === undefined) break;
        const repoArg = one(a, 'repo');
        const s = itemStatus(root, slug);
        if (!s.contract.ok || s.contract.parse === null) {
          out(`refused: ${s.contract.reason}`);
          return 1;
        }
        if (repoArg === undefined) {
          out('refused: --repo <dir> is needed (the before value is read by running the Measure command on that clone)');
          return 2;
        }
        const repoDir = resolve(repoArg);
        const c = s.contract.parse;
        const bad = await checkOrigin(repoDir, (c.fields.Repo ?? '').trim(), run);
        if (bad !== null) {
          out(`refused: ${bad}`);
          return 1;
        }
        const base = (c.fields.Base ?? '').trim();
        const fetch = await run('git', ['-C', repoDir, 'fetch', '--quiet', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: repoDir, timeoutMs: 120_000, env: passThroughEnv(['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN']) });
        if (fetch.code !== 0) {
          out(`refused: git fetch origin ${base} failed: ${(fetch.stderr || fetch.stdout).trim()}`);
          return 1;
        }
        if (c.measure === null) return 1;
        // The Commit header is approved with the contract, so the repository's own rules see it first.
        const header = (c.fields.Commit ?? '').trim();
        const lint = await repoCommitlint(run, repoDir, `${header}\n`);
        if (lint.status === 'fail' || lint.status === 'unproven') {
          out(`refused: Commit "${header}": ${lint.summary}`);
          for (const d of lint.details) out(`  ${d}`);
          return 1;
        }
        const before = await readMetric({ harnessRoot, repoDir, ref: `origin/${base}`, measure: c.measure, exec: run, label: slug });
        if (!before.ok) {
          out(`refused: the before value could not be read: ${before.reason}`);
          return 1;
        }
        const reading: MetricReading = before.reading;
        const p = proposeItem(root, slug, { session, before: reading });
        out(`proposed ${slug} (ledger seq ${p.seq}, contract ${c.hash.slice(0, 12)}) to ${(c.fields.Stakeholder ?? '').trim()}`);
        out(`  Problem   ${(c.fields.Problem ?? '').split('\n')[0] ?? ''}`);
        out(`  Owner     ${(c.fields.Owner ?? '').trim()}`);
        out(`  Commit    ${header}  (${lint.summary})`);
        out(`  Metric    ${c.metric?.name ?? ''}, ${c.metric?.window ?? ''}: before ${reading.value} (read at origin/${base} ${reading.sha.slice(0, 12)})`);
        for (const sc of c.scenarios) out(`  Scenario  WHEN ${sc.when} THEN ${sc.then}`);
        out(`  Not incl. ${c.notIncluded.join('; ')}`);
        if (!reader.isTTY) {
          out(`waiting for ${(c.fields.Stakeholder ?? '').trim()}'s reply, typed at a terminal: harness item reply ${slug}`);
          return 0;
        }
        return await askReply(root, slug, reader, out, session);
      }
      case 'reply':
        if (slug === undefined) break;
        return await askReply(root, slug, reader, out, session);
      case 'close': {
        if (slug === undefined) break;
        const repoArg = one(a, 'repo');
        if (repoArg === undefined) {
          out('refused: --repo <dir> is needed (the after value is read by running the Measure command at the merge commit)');
          return 2;
        }
        const r = await closeItem({ root, harnessRoot, slug, repoDir: resolve(repoArg), exec: run });
        for (const l of r.lines) out(l);
        if (r.ok) out(`closed ${slug}: before and after are in ${CONTRACTS_DIR}/${slug}.md and items/${slug}/ledger.jsonl`);
        else out(`not closed: ${slug} stays open`);
        return r.ok ? 0 : 1;
      }
      default:
        out(`unknown item command "${sub}"\n${usage}`);
        return 2;
    }
  } catch (e) {
    out(`refused: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  out(usage);
  return 2;
}

/** For tests: the item's ledger entries as types, in order. */
export function ledgerTypes(root: string, slug: string): string[] {
  return readLedger(itemPaths(root, slug).ledger).entries.map((e) => e.event.type);
}
