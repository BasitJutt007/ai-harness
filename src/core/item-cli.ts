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
import { closeItem, ledgerFacts, preconditions } from './close.ts';
import { HARNESS_ROOT } from './config.ts';
import { exec as coreExec, passThroughEnv } from './exec.ts';
import { classifyReply, CONTRACTS_DIR, itemPaths, itemsRoot, itemStatus, proposeItem, readLedger, recordReply, type ContractParse, type ItemStatus, type MetricReading } from './items.ts';
import { readMetric } from './measure.ts';
import { provenanceText } from './provenance.ts';
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
  const handAfter = m?.after !== null && m?.after !== undefined && !s.ledger.entries.some((e) => e.event.type === 'closed');
  return `${s.slug.padEnd(28)} ${s.stage.padEnd(13)}${m !== undefined && m !== null ? ` ${m.name}: ${readingsText(s)}` : ''}${handAfter ? `  (contract says after ${m?.after ?? ''}: written by hand, no harness reading; ignored)` : ''}`;
}

/**
 * The metric as status shows it: the LATEST before reading only (an item proposed again has several;
 * only the newest is the one close compares with), with its ref and short sha, then the after value or
 * 'not read'.
 */
export function readingsText(s: ItemStatus): string {
  const metric = s.ledger.entries.flatMap((e) => (e.event.type === 'metric' ? [e.event] : []));
  const before = metric.filter((e) => e.phase === 'before').at(-1)?.reading;
  const after = metric.filter((e) => e.phase === 'after').at(-1)?.reading;
  const b = before === undefined
    ? `before not read${s.contract.parse?.noMeasure === true ? ' (Measure: none)' : ''}`
    : `before ${before.value} (${before.ref} ${before.sha.slice(0, 12)})`;
  return `${b}, ${after === undefined ? 'after not read' : `after ${after.value} (${after.sha.slice(0, 12)})`}`;
}

/** How the latest reply to the item arrived (provenance.ts), for `item status <slug>`; null when there is none. */
function operatorLine(s: ItemStatus): string | null {
  const t = s.ledger.entries.filter((e) => e.event.type === 'human_turn').at(-1);
  if (t === undefined || t.event.type !== 'human_turn') return null;
  return `operator           reply seq ${t.seq}: ${provenanceText(t.event.channel, t.event.agentEnv)}`;
}

/** The target clone's origin must be the contract's Repo (reading a metric on another repository proves nothing). */
export async function checkOrigin(repoDir: string, repo: string, run: Exec): Promise<string | null> {
  const r = await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { cwd: repoDir });
  if (r.code !== 0) return `${repoDir} has no origin remote`;
  const url = r.stdout.trim().replace(/\.git$/, '');
  return new RegExp(`[/:]${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(url) ? null : `${repoDir}'s origin is ${url}, not ${repo}`;
}

/**
 * Why the clone at `repoDir` is not where an approved contract's work may happen (file mode), or null: its
 * origin must be the contract's Repo (checkOrigin) and its current branch the contract's Base, which the
 * run's worktree starts from. Otherwise a yes given for one change would authorize work on another
 * repository, or from another branch, than the one the stakeholder approved. A git query that fails is
 * a refusal.
 */
export async function targetRepoProblem(repoDir: string, contract: Pick<ContractParse, 'fields'>, run: Exec): Promise<string | null> {
  const repo = (contract.fields.Repo ?? '').trim();
  const base = (contract.fields.Base ?? '').trim();
  const origin = await checkOrigin(repoDir, repo, run);
  if (origin !== null) return `the target is not the contract's Repo (${repo}): ${origin}`;
  const head = await run('git', ['-C', repoDir, 'symbolic-ref', '-q', '--short', 'HEAD'], { cwd: repoDir });
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch.length === 0) return `${repoDir} is not on a branch (detached HEAD), but the run starts from the contract's Base (${base}): git switch ${base}`;
  if (branch !== base) return `${repoDir} is on ${branch}, but the contract's Base is ${base}: the run would start from another branch than the approved one (git switch ${base})`;
  return null;
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

export async function cmdItem(
  a: ItemArgs,
  out: Out,
  opts: {
    reader?: ReplyReader;
    exec?: Exec;
    root?: string;
    harnessRoot?: string;
    /**
     * Whether a Measure script may come from the harness's metrics/ when the items root lacks it. Default:
     * only for the file-mode items root (no `root` given: the harness's, or HARNESS_ITEMS_ROOT standing in
     * for it); an items root of its own never borrows a script.
     */
    harnessMetrics?: boolean;
  } = {},
): Promise<number> {
  const harnessRoot = opts.harnessRoot ?? HARNESS_ROOT;
  const root = opts.root ?? itemsRoot(harnessRoot);
  const harnessMetrics = opts.harnessMetrics ?? opts.root === undefined;
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
          if (slug !== undefined) {
            for (const l of st.lines) out(`  ${l}`);
            const op = operatorLine(st);
            if (op !== null) out(`  ${op}`);
          }
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
        if (c.measure === null && !c.noMeasure) return 1;
        // The Commit header is approved with the contract, so the repository's own rules see it first.
        const header = (c.fields.Commit ?? '').trim();
        const lint = await repoCommitlint(run, repoDir, `${header}\n`);
        if (lint.status === 'fail' || lint.status === 'unproven') {
          out(`refused: Commit "${header}": ${lint.summary}`);
          for (const d of lint.details) out(`  ${d}`);
          return 1;
        }
        // "Measure: none": proposed with no before value; such an item can ship, but it can never close.
        let reading: MetricReading | null = null;
        if (c.measure !== null) {
          const before = await readMetric({ harnessRoot, itemsRoot: root, repoDir, ref: `origin/${base}`, measure: c.measure, exec: run, label: slug, harnessMetrics });
          if (!before.ok) {
            out(`refused: the before value could not be read: ${before.reason}`);
            return 1;
          }
          reading = before.reading;
          if (before.unproven !== undefined) out(`note: the before value is UNPROVEN (${before.unproven}): close will refuse it; propose again where the sandbox works`);
        }
        const p = proposeItem(root, slug, { session, before: reading });
        out(`proposed ${slug} (ledger seq ${p.seq}, contract ${c.hash.slice(0, 12)}) to ${(c.fields.Stakeholder ?? '').trim()}`);
        out(`  Problem   ${(c.fields.Problem ?? '').split('\n')[0] ?? ''}`);
        out(`  Owner     ${(c.fields.Owner ?? '').trim()}`);
        out(`  Commit    ${header}  (${lint.summary})`);
        out(reading === null
          ? `  Metric    ${c.metric?.name ?? ''}, ${c.metric?.window ?? ''}: no Measure (the contract says "Measure: none"): the outcome cannot be read, so this item can never close`
          : `  Metric    ${c.metric?.name ?? ''}, ${c.metric?.window ?? ''}: before ${reading.value} (read at origin/${base} ${reading.sha.slice(0, 12)})`);
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
        const r = await closeItem({ root, harnessRoot, slug, repoDir: resolve(repoArg), exec: run, harnessMetrics });
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

// ───────────────────────────── harness gate ─────────────────────────────

/** The three gates of assignment 02, as `harness gate <name>` checks them. */
export const GATE_NAMES = ['problem-statement', 'human-yes', 'outcome'] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** A gate's verdict on an item now: PASS or REFUSE, with the reason. */
export interface GateCheck {
  pass: boolean;
  reason: string;
}

/**
 * The outcome gate, read-only: PASS only when the item is closed (the `closed` entry closeItem writes
 * after every fact held and the after reading was recorded). Otherwise REFUSE with what is missing: with
 * `repoDir`, every fact is gathered as close would (a dry run: nothing is recorded); without it, what
 * the item's own records show.
 */
async function outcomeCheck(root: string, slug: string, harnessRoot: string, repoDir: string | undefined, run: Exec, harnessMetrics: boolean): Promise<GateCheck> {
  const st = itemStatus(root, slug);
  if (st.ledger.problems.length > 0) return { pass: false, reason: `the item ledger is broken (${st.ledger.problems.join('; ')})` };
  const closed = st.ledger.entries.find((e) => e.event.type === 'closed');
  if (closed !== undefined && closed.event.type === 'closed') {
    const c = closed.event;
    return { pass: true, reason: `closed at ledger seq ${closed.seq}: before ${c.before.value} (at ${c.before.sha.slice(0, 12)}) -> after ${c.after.value} (at the merge ${c.mergeSha.slice(0, 12)}, merged by ${c.mergedBy})` };
  }
  const notYet = `not closed: harness item close ${slug} --repo <dir> reads the metric after the PR merged and records it`;
  if (repoDir === undefined) {
    const own = preconditions({ status: st, ...ledgerFacts(st) });
    return { pass: false, reason: own.length > 0 ? own.join('; ') : `${notYet} (pass --repo <dir> to check GitHub and the metric now)` };
  }
  const r = await closeItem({ root, harnessRoot, slug, repoDir, exec: run, dryRun: true, harnessMetrics });
  return { pass: false, reason: r.ok ? `every check holds, but the item is ${notYet}` : r.reasons.join('; ') };
}

/** The verdict of one gate on an item now (nothing is recorded). */
export async function gateCheck(gate: GateName, root: string, slug: string, opts: { harnessRoot: string; repoDir?: string; exec?: Exec; harnessMetrics?: boolean }): Promise<GateCheck> {
  if (gate === 'outcome') return outcomeCheck(root, slug, opts.harnessRoot, opts.repoDir, opts.exec ?? coreExec, opts.harnessMetrics ?? false);
  const st = itemStatus(root, slug);
  if (gate === 'problem-statement') return { pass: st.contract.ok, reason: st.contract.reason };
  if (!st.contract.ok) return { pass: false, reason: `needs a complete contract first: ${st.contract.reason}` };
  return { pass: st.approval?.ok === true, reason: st.approval?.reason ?? 'not proposed' };
}

/**
 * `harness gate <problem-statement|human-yes|outcome> <slug> [--repo <dir>]`: one gate's verdict on an
 * item, as the run's hooks and the close command decide it. Prints `PASS` or `REFUSE` with the reason;
 * exit 0 on PASS, 2 on REFUSE (and on a usage error). Read-only: nothing is proposed, recorded or closed.
 */
export async function cmdGate(a: ItemArgs, out: Out, opts: { exec?: Exec; root?: string; harnessRoot?: string; harnessMetrics?: boolean } = {}): Promise<number> {
  const usage = `usage: harness gate ${GATE_NAMES.join('|')} <slug> [--repo <dir>]`;
  const [gate, slug, ...extra] = a.positionals;
  const unknown = [...a.flags.keys()].find((k) => k !== 'repo');
  if (gate === undefined || slug === undefined || extra.length > 0 || unknown !== undefined || !(GATE_NAMES as readonly string[]).includes(gate)) {
    out(unknown !== undefined ? `unknown option --${unknown}\n${usage}` : usage);
    return 2;
  }
  const harnessRoot = opts.harnessRoot ?? HARNESS_ROOT;
  const root = opts.root ?? itemsRoot(harnessRoot);
  const repoArg = one(a, 'repo');
  let v: GateCheck;
  try {
    v = await gateCheck(gate as GateName, root, slug, {
      harnessRoot,
      ...(repoArg !== undefined ? { repoDir: resolve(repoArg) } : {}),
      ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
      harnessMetrics: opts.harnessMetrics ?? opts.root === undefined,
    });
  } catch (e) {
    v = { pass: false, reason: e instanceof Error ? e.message : String(e) };
  }
  out(`${v.pass ? 'PASS' : 'REFUSE'}  ${gate}  ${slug}: ${v.reason}`);
  return v.pass ? 0 : 2;
}

/** For tests: the item's ledger entries as types, in order. */
export function ledgerTypes(root: string, slug: string): string[] {
  return readLedger(itemPaths(root, slug).ledger).entries.map((e) => e.event.type);
}
