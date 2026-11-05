/**
 * A session's contract, proposed in chat: the harness (never the model) writes it, validates it with
 * the parser every gate uses, reads the metric's before value, records the proposal in the item ledger
 * and hands it to the REPL, which shows it and takes the owner's next typed line as the reply.
 *
 *   proposeDrafted   from the propose_contract tool's input: Repo and Base filled by the harness
 *   proposeImported  from a contract file the owner wrote (/import <path>), as written
 *
 * Records live in the session's items root (the repository's state directory), never in the repository:
 *   docs/contracts/<slug>.md, items/<slug>/ledger.jsonl, metrics/<slug>.mjs (when there is a Measure).
 *
 * Fail closed: an incomplete contract, a commit header the repository's commitlint rejects (or cannot
 * check), a Measure that prints no number, a slug already shipped or closed: each is refused with the
 * reason, and nothing is proposed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CONTRACTS_DIR, itemPaths, itemStatus, parseContract, proposeItem, SLUG_RE, type ContractParse, type MetricReading } from '../core/items.ts';
import { readMetric } from '../core/measure.ts';
import { repoCommitlint } from '../core/ship-text.ts';
import type { Exec } from '../core/types.ts';
import { ProposeContractInput, type ProposeContractInputT } from '../../plugins/tools/propose_contract.ts';

/** What proposing needs from the session. */
export interface ProposalEnv {
  /** The repository's top level (real path). */
  top: string;
  /** The session's items root (docs/contracts/, items/, metrics/). */
  itemsRoot: string;
  sessionId: string;
  harnessRoot: string;
  exec: Exec;
  /** HEAD when the session started: the before reading's fallback commit. */
  baseSha: string;
}

export interface Proposal {
  slug: string;
  /** The proposal's ledger seq. */
  seq: number;
  /** The contract hash the owner's reply approves. */
  hash: string;
  /** The contract text as written (what the owner is shown). */
  text: string;
  before: MetricReading | null;
  /** Lines shown under the proposal (before value, commitlint, where the records are). */
  notes: string[];
}

export type ProposalOutcome = { ok: true; proposal: Proposal } | { ok: false; reason: string };

/** The largest Measure script a session writes (it is meant to be small). */
export const MAX_MEASURE_SCRIPT = 20_000;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** owner/name from an origin URL (scp-like, ssh://, https://), or null. */
export function repoSlugFromRemote(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(u);
  return m === null ? null : `${m[1] ?? ''}/${m[2] ?? ''}`;
}

async function git(env: ProposalEnv, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await env.exec('git', ['-C', env.top, ...args], { cwd: env.top, timeoutMs: 30_000 });
  return { ok: r.code === 0, out: r.stdout.trim() };
}

/** Repo: the origin remote as owner/name, or local:<directory name> when there is no origin. */
export async function repoField(env: ProposalEnv): Promise<string> {
  const r = await git(env, ['remote', 'get-url', 'origin']);
  const slug = r.ok ? repoSlugFromRemote(r.out) : null;
  return slug ?? `local:${basename(env.top).replace(/[^A-Za-z0-9_.-]+/g, '-') || 'repo'}`;
}

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Base: the repository's default branch (origin/HEAD), else the current branch's upstream branch, else
 * a local development, main or master branch; null when none can be told (the model must name it).
 */
export async function defaultBase(env: ProposalEnv): Promise<string | null> {
  const head = await git(env, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.startsWith('origin/') && head.out.length > 'origin/'.length) return head.out.slice('origin/'.length);
  const up = await git(env, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.ok && up.out.includes('/')) return up.out.slice(up.out.indexOf('/') + 1);
  for (const b of ['development', 'main', 'master']) {
    if ((await git(env, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).ok) return b;
  }
  return null;
}

/** The contract text, in exactly the format items.ts parses (every value on one line). */
export function draftedContract(input: ProposeContractInputT, fields: { repo: string; base: string; measure: string }): string {
  const strip = (s: string, word: string): string => oneLine(s).replace(new RegExp(`^${word}\\s+`, 'i'), '');
  const notIncluded = input.notIncluded.map(oneLine);
  const lines = [
    `# ${input.slug}`,
    '',
    `Problem: ${oneLine(input.problem)}`,
    `Owner: ${oneLine(input.owner)}`,
    `Stakeholder: ${oneLine(input.stakeholder)}`,
    `Repo: ${fields.repo}`,
    `Base: ${fields.base}`,
    `Commit: ${oneLine(input.commit)}`,
    ...(input.ticket !== undefined ? [`Ticket: ${oneLine(input.ticket)}`] : []),
    `Metric: ${oneLine(input.metric.name).replace(/,/g, ';')}, ${oneLine(input.metric.window)} before: ____ after: ____`,
    `Measure: ${fields.measure}`,
    ...input.scenarios.map((s) => `Scenario: WHEN ${strip(s.when, 'when')} THEN ${strip(s.then, 'then')}`),
    `Not included: ${notIncluded[0] ?? ''}`,
    ...notIncluded.slice(1).map((n) => `- ${n}`),
    '',
  ];
  return lines.join('\n');
}

/** Why a parsed contract cannot be proposed, for the model or the owner (null = complete). */
export function incompleteReason(parse: ContractParse, text: string): string | null {
  if (parse.complete) return null;
  const parts = [...(parse.missing.length > 0 ? [`missing or placeholder: ${parse.missing.join(', ')}`] : []), ...parse.problems];
  const angle = /<[^<>]{1,200}>/.test(text) ? ' (text in angle brackets, e.g. <Login />, reads as a template placeholder: rephrase it)' : '';
  return `the contract is incomplete: ${parts.join('; ')}${angle}`;
}

/** A slug the session may (re)propose: valid, and not an item that already shipped or closed. */
function slugProblem(itemsRoot: string, slug: string): string | null {
  if (!SLUG_RE.test(slug)) return `invalid slug "${slug}": use lower-case letters, digits and dashes (2-63 characters)`;
  if (!existsSync(itemPaths(itemsRoot, slug).contract)) return null;
  const stage = itemStatus(itemsRoot, slug).stage;
  if (stage === 'shipped' || stage === 'closed' || stage === 'broken') return `item "${slug}" is ${stage} in this repository's records: choose another slug`;
  return null;
}

/** The ref the before value is read at: origin/<Base>, else <Base>, else the session's start commit. */
async function beforeRef(env: ProposalEnv, base: string): Promise<string> {
  for (const ref of [`origin/${base}`, base]) {
    if ((await git(env, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) return ref;
  }
  return env.baseSha;
}

/** Commitlint, the before reading, the contract file and the ledger entry: the common tail of both ways in. */
async function propose(env: ProposalEnv, slug: string, text: string, parse: ContractParse, notes: string[]): Promise<ProposalOutcome> {
  const header = (parse.fields.Commit ?? '').trim();
  const lint = await repoCommitlint(env.exec, env.top, `${header}\n`);
  if (lint.status === 'fail' || lint.status === 'unproven') {
    return { ok: false, reason: `commit header "${header}": ${lint.summary}${lint.details.length > 0 ? ` (${lint.details.join('; ')})` : ''}` };
  }
  notes.push(`commit header: ${lint.summary}`);
  const paths = itemPaths(env.itemsRoot, slug);
  mkdirSync(dirname(paths.contract), { recursive: true });
  writeFileSync(paths.contract, text);
  let before: MetricReading | null = null;
  if (parse.measure !== null) {
    const base = (parse.fields.Base ?? '').trim();
    const ref = await beforeRef(env, base);
    const r = await readMetric({ harnessRoot: env.harnessRoot, itemsRoot: env.itemsRoot, repoDir: env.top, ref, measure: parse.measure, exec: env.exec, label: slug });
    if (!r.ok) return { ok: false, reason: `the before value could not be read: ${r.reason}` };
    before = r.reading;
    notes.push(`before value: ${before.value} (read by the harness at ${ref === env.baseSha ? 'the session start commit' : ref} ${before.sha.slice(0, 12)})`);
  } else {
    notes.push('Measure: none: there is no metric script, so this item can ship but never close (the outcome cannot be read)');
  }
  const entry = proposeItem(env.itemsRoot, slug, { session: env.sessionId, before });
  const final = readFileSync(paths.contract, 'utf8');
  notes.push(`records: ${CONTRACTS_DIR}/${slug}.md and items/${slug}/ledger.jsonl in ${env.itemsRoot} (outside the repository)`);
  return { ok: true, proposal: { slug, seq: entry.seq, hash: parse.hash, text: final, before, notes } };
}

/** The propose_contract tool's input → a proposal (or the reason it is refused, for the model to fix). */
export async function proposeDrafted(raw: unknown, env: ProposalEnv): Promise<ProposalOutcome> {
  const parsed = ProposeContractInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}` };
  const input = parsed.data;
  const bad = slugProblem(env.itemsRoot, input.slug);
  if (bad !== null) return { ok: false, reason: bad };
  const base = input.base !== undefined ? oneLine(input.base) : await defaultBase(env);
  if (base === null) return { ok: false, reason: 'could not tell which branch the PR will target (no origin/HEAD, no upstream, no development/main/master branch): pass base' };
  if (!BRANCH_RE.test(base)) return { ok: false, reason: `base "${base}" is not a branch name` };
  if (input.measureScript !== undefined && input.measureScript.length > MAX_MEASURE_SCRIPT) {
    return { ok: false, reason: `measureScript is ${input.measureScript.length} characters; keep it under ${MAX_MEASURE_SCRIPT} (a small read-only script)` };
  }
  const measure = input.measureScript !== undefined ? `node metrics/${input.slug}.mjs` : 'none';
  const text = draftedContract(input, { repo: await repoField(env), base, measure });
  const parse = parseContract(text);
  const why = incompleteReason(parse, text);
  if (why !== null) return { ok: false, reason: why };
  if (input.measureScript !== undefined) {
    const script = join(env.itemsRoot, 'metrics', `${input.slug}.mjs`);
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, input.measureScript.endsWith('\n') ? input.measureScript : `${input.measureScript}\n`);
  }
  return propose(env, input.slug, text, parse, [`Repo and Base filled by the harness: ${(parse.fields.Repo ?? '').trim()}, base ${base}`]);
}

/**
 * A contract the owner wrote (/import <path>): <slug>.md, as written, with its Measure script next to it
 * (the file the Measure line names, or <slug>.mjs). `cwd` resolves a relative path.
 */
export async function proposeImported(path: string, cwd: string, env: ProposalEnv): Promise<ProposalOutcome> {
  const file = resolve(cwd, path);
  if (!existsSync(file)) return { ok: false, reason: `no such file: ${file}` };
  const slug = basename(file).replace(/\.md$/i, '');
  const bad = slugProblem(env.itemsRoot, slug);
  if (bad !== null) return { ok: false, reason: `${bad} (the file name, without .md, is the slug)` };
  const text = readFileSync(file, 'utf8');
  const parse = parseContract(text);
  const why = incompleteReason(parse, text);
  if (why !== null) return { ok: false, reason: why };
  if (parse.measure !== null) {
    const named = join(dirname(file), basename(parse.measure.script));
    const bySlug = join(dirname(file), `${slug}.mjs`);
    const source = existsSync(named) ? named : existsSync(bySlug) ? bySlug : null;
    if (source === null) return { ok: false, reason: `the Measure line names ${parse.measure.script}: put ${basename(parse.measure.script)} next to the contract (${dirname(file)})` };
    const dest = join(env.itemsRoot, parse.measure.script);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }
  return propose(env, slug, text, parse, [`imported from ${file} (Repo and Base as written)`]);
}
