/**
 * A session's contract, proposed in chat: the harness (never the model) writes it, validates it with
 * the parser every gate uses, records the proposal in the item ledger and hands it to the REPL, which
 * shows it (with the Measure script in full) and takes the owner's next typed line as the reply.
 *
 *   proposeDrafted   from the propose_contract tool's input: Repo, Base and Stakeholder filled by the
 *                    harness (Owner too when the model leaves it empty)
 *   proposeImported  from a contract file the owner wrote (/import <path>), as written
 *   readBefore       after the owner's typed yes: the metric's before value, read by the harness
 *
 * Records live in the session's items root (the repository's state directory), never in the repository:
 *   docs/contracts/<slug>.md, items/<slug>/ledger.jsonl, metrics/<slug>.mjs (when there is a Measure).
 *
 * Nothing the model wrote runs before the owner has seen it and said yes: proposing writes the contract
 * and the script and reads nothing; the before value is read once the contract is approved, and is
 * recorded as the ledger's `metric` entry (phase before). What the script prints never reaches the
 * model or a record (measure.ts): the model hears only how a reading failed.
 *
 * Fail closed: an incomplete contract, a commit header the repository's commitlint rejects (or cannot
 * check), a Base that is not a branch here or on origin, a model-written Measure where no sandbox
 * confines it, a slug already shipped or closed: each is refused with the reason, and nothing is
 * written. Every check runs before the first write; the contract and the script are written through
 * temp files and kept only when the ledger takes the proposal (otherwise the previous files come back).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { appendLedger, CONTRACTS_DIR, itemPaths, itemStatus, parseContract, proposeItem, SLUG_RE, writeMetricValues, type ContractParse, type MetricReading } from '../core/items.ts';
import { readMetric, type MeasureResult } from '../core/measure.ts';
import { repoCommitlint } from '../core/ship-text.ts';
import type { Exec } from '../core/types.ts';
import { measureScriptProblem, normalizeScript, ProposeContractInput, type ProposeContractInputT } from '../../plugins/tools/propose_contract.ts';
import type { ShownScript } from './ui.ts';

/** What proposing needs from the session. */
export interface ProposalEnv {
  /** The repository's top level (real path). */
  top: string;
  /** The session's items root (docs/contracts/, items/, metrics/). */
  itemsRoot: string;
  sessionId: string;
  harnessRoot: string;
  exec: Exec;
  /** The person at this terminal (personName): the Stakeholder of a drafted contract. */
  person: string;
  /** Whether a model-written Measure script may run: only where the sandbox confines it. */
  confined: { ok: true } | { ok: false; why: string };
}

export interface Proposal {
  slug: string;
  /** The proposal's ledger seq. */
  seq: number;
  /** The contract hash the owner's reply approves. */
  hash: string;
  /** The contract text as written (what the owner is shown). */
  text: string;
  /** The Measure script the harness runs after the yes, shown in full; null with Measure: none. */
  script: ShownScript | null;
  /** The contract's Base (a branch of origin or a local branch). */
  base: string;
  /** Lines shown under the proposal (commitlint, when the before value is read, where the records are). */
  notes: string[];
  /** What the model is told about what the harness changed in its input (a Stakeholder it sent, ...). */
  toModel: string[];
}

/** `environment`: the refusal is the checkout's or the machine's (the model cannot fix it: it stops and reports). */
export type ProposalOutcome = { ok: true; proposal: Proposal } | { ok: false; reason: string; environment?: boolean };

/** The largest Measure script a session writes (it is meant to be small). */
export const MAX_MEASURE_SCRIPT = 20_000;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A path for the owner's eyes: under the home directory as ~/... */
export function tildePath(p: string): string {
  const home = homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

/** owner/name from an origin URL (scp-like, ssh://, https://), or null. */
export function repoSlugFromRemote(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(u);
  return m === null ? null : `${m[1] ?? ''}/${m[2] ?? ''}`;
}

async function git(env: Pick<ProposalEnv, 'top' | 'exec'>, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await env.exec('git', ['-C', env.top, ...args], { cwd: env.top, timeoutMs: 30_000 });
  return { ok: r.code === 0, out: r.stdout.trim() };
}

/** Repo: the origin remote as owner/name, or local:<directory name> when there is no origin. */
export async function repoField(env: Pick<ProposalEnv, 'top' | 'exec'>): Promise<string> {
  const r = await git(env, ['remote', 'get-url', 'origin']);
  const slug = r.ok ? repoSlugFromRemote(r.out) : null;
  return slug ?? `local:${basename(env.top).replace(/[^A-Za-z0-9_.-]+/g, '-') || 'repo'}`;
}

/**
 * The person at this terminal: `git config user.name` in the repository, else the OS user name. It is
 * what a drafted contract's Stakeholder says (the model never chooses who approves).
 */
export async function personName(env: Pick<ProposalEnv, 'top' | 'exec'>, osUser: () => string): Promise<string> {
  const r = await git(env, ['config', 'user.name']);
  const fromGit = r.ok ? oneLine(r.out.replace(/[^\p{L}\p{N}\p{M} .,'@_()-]+/gu, ' ')) : '';
  if (fromGit.length > 0) return fromGit;
  const os = oneLine(osUser().replace(/[^\p{L}\p{N}\p{M} .,'@_()-]+/gu, ' '));
  return os.length > 0 ? os : 'the owner at this terminal';
}

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Base: the repository's default branch (origin/HEAD), else the current branch's upstream branch, else
 * a local development, main or master branch; null when none can be told (the model must name it).
 */
export async function defaultBase(env: Pick<ProposalEnv, 'top' | 'exec'>): Promise<string | null> {
  const head = await git(env, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.startsWith('origin/') && head.out.length > 'origin/'.length) return head.out.slice('origin/'.length);
  const up = await git(env, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.ok && up.out.includes('/')) return up.out.slice(up.out.indexOf('/') + 1);
  for (const b of ['development', 'main', 'master']) {
    if ((await git(env, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).ok) return b;
  }
  return null;
}

/**
 * The ref a contract's Base resolves through, or why it is no Base. A Base is a branch name (it passes
 * `git check-ref-format --branch` as it is and does not start with "-"), and it resolves only as
 * origin's branch (refs/remotes/origin/<base>) or a local one (refs/heads/<base>): never as a stash, a
 * tag, a revision expression or an option.
 */
export async function baseRef(env: Pick<ProposalEnv, 'top' | 'exec'>, base: string): Promise<{ ok: true; ref: string; short: string; sha: string } | { ok: false; reason: string }> {
  if (base.length === 0) return { ok: false, reason: 'Base is empty: name the branch the PR will target' };
  if (base.startsWith('-')) return { ok: false, reason: `base "${base}" starts with "-": a branch name never does` };
  if (!BRANCH_RE.test(base)) return { ok: false, reason: `base "${base}" is not a branch name (letters, digits, ".", "_", "/" and "-" only)` };
  const fmt = await env.exec('git', ['-C', env.top, 'check-ref-format', '--branch', base], { cwd: env.top, timeoutMs: 30_000 });
  if (fmt.code !== 0 || fmt.stdout.trim() !== base) return { ok: false, reason: `base "${base}" is not a valid branch name (git check-ref-format --branch refuses it)` };
  for (const [ref, short] of [[`refs/remotes/origin/${base}`, `origin/${base}`], [`refs/heads/${base}`, base]] as const) {
    const r = await git(env, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.ok && /^[0-9a-f]{40,64}$/.test(r.out)) return { ok: true, ref, short, sha: r.out };
  }
  return { ok: false, reason: `base "${base}" is neither a branch of origin (refs/remotes/origin/${base}) nor a local branch (refs/heads/${base}): name the branch the PR will target` };
}

/** The contract text, in exactly the format items.ts parses (every value on one line). */
export function draftedContract(input: ProposeContractInputT, fields: { repo: string; base: string; measure: string; stakeholder?: string; owner?: string }): string {
  const strip = (s: string, word: string): string => oneLine(s).replace(new RegExp(`^${word}\\s+`, 'i'), '');
  const notIncluded = input.notIncluded.map(oneLine);
  const lines = [
    `# ${input.slug}`,
    '',
    `Problem: ${oneLine(input.problem)}`,
    `Owner: ${oneLine(fields.owner ?? input.owner ?? '')}`,
    `Stakeholder: ${oneLine(fields.stakeholder ?? input.stakeholder ?? '')}`,
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

/**
 * Put every file in place, each through a temp file next to it and a rename; returns the undo, which
 * puts back what was there before (or removes a file that was not). All or nothing: when a rename
 * fails, the files already renamed get their previous content back and the temp files left are
 * removed, then the error is thrown. `rename` is for tests (default renameSync).
 */
export function replaceFiles(files: Array<{ file: string; content: string }>, rename: (from: string, to: string) => void = renameSync): () => void {
  const before = files.map((f) => ({ file: f.file, old: existsSync(f.file) ? readFileSync(f.file, 'utf8') : null }));
  const putBack = (b: { file: string; old: string | null }): void => {
    if (b.old === null) rmSync(b.file, { force: true });
    else writeFileSync(b.file, b.old);
  };
  const temps: Array<{ tmp: string; file: string }> = [];
  try {
    for (const f of files) {
      mkdirSync(dirname(f.file), { recursive: true });
      const tmp = join(dirname(f.file), `.${basename(f.file)}.${randomBytes(6).toString('hex')}.tmp`);
      writeFileSync(tmp, f.content, { flag: 'wx' });
      temps.push({ tmp, file: f.file });
    }
  } catch (e) {
    for (const t of temps) rmSync(t.tmp, { force: true });
    throw e;
  }
  let renamed = 0;
  try {
    for (const t of temps) {
      rename(t.tmp, t.file);
      renamed += 1;
    }
  } catch (e) {
    for (const b of before.slice(0, renamed)) putBack(b);
    for (const t of temps.slice(renamed)) rmSync(t.tmp, { force: true });
    throw e;
  }
  return () => {
    for (const b of before) putBack(b);
  };
}

/**
 * The common tail of both ways in: commitlint, then (every check passed) the contract and the script
 * written and the proposal recorded, all or nothing. No reading: the before value waits for the yes.
 */
async function propose(env: ProposalEnv, slug: string, text: string, parse: ContractParse, base: { short: string }, script: ShownScript | null, notes: string[], toModel: string[]): Promise<ProposalOutcome> {
  const header = (parse.fields.Commit ?? '').trim();
  const lint = await repoCommitlint(env.exec, env.top, `${header}\n`);
  if (lint.status === 'fail') return { ok: false, reason: `commit header "${header}": ${lint.summary}${lint.details.length > 0 ? ` (${lint.details.join('; ')})` : ''}` };
  // Not installed, timed out, no rule report: the checkout's problem, not the model's.
  if (lint.status === 'unproven') return { ok: false, environment: true, reason: `commit header "${header}" cannot be checked: ${lint.summary}` };
  notes.push(`commit header: ${lint.summary}`);
  const paths = itemPaths(env.itemsRoot, slug);
  const writes = [{ file: paths.contract, content: text }, ...(script !== null ? [{ file: join(env.itemsRoot, script.path), content: script.text }] : [])];
  let entry: ReturnType<typeof proposeItem>;
  let undo: () => void = () => undefined;
  try {
    undo = replaceFiles(writes);
    entry = proposeItem(env.itemsRoot, slug, { session: env.sessionId, before: null });
  } catch (e) {
    undo();
    return { ok: false, reason: `the proposal could not be recorded (nothing changed): ${errMsg(e)}` };
  }
  if (parse.measure !== null) notes.push(`before value: read by the harness at ${base.short} only after your yes (the script above, confined and offline)`);
  else notes.push('Measure: none: there is no metric script, so this item can ship but never close (the outcome cannot be read)');
  notes.push(`records: ${CONTRACTS_DIR}/${slug}.md and items/${slug}/ledger.jsonl in ${tildePath(env.itemsRoot)} (outside the repository)`);
  return { ok: true, proposal: { slug, seq: entry.seq, hash: parse.hash, text: readFileSync(paths.contract, 'utf8'), script, base: (parse.fields.Base ?? '').trim(), notes, toModel } };
}

/** The propose_contract tool's input → a proposal (or the reason it is refused, for the model to fix). */
export async function proposeDrafted(raw: unknown, env: ProposalEnv): Promise<ProposalOutcome> {
  const parsed = ProposeContractInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}` };
  const input = parsed.data;
  const bad = slugProblem(env.itemsRoot, input.slug);
  if (bad !== null) return { ok: false, reason: bad };
  if (input.measureScript !== undefined && !env.confined.ok) {
    return { ok: false, environment: true, reason: `a Measure script you write runs only where the sandbox confines it, and ${env.confined.why}` };
  }
  if (input.measureScript !== undefined && input.measureScript.length > MAX_MEASURE_SCRIPT) {
    return { ok: false, reason: `measureScript is ${input.measureScript.length} characters; keep it under ${MAX_MEASURE_SCRIPT} (a small read-only script)` };
  }
  const named = input.base !== undefined ? oneLine(input.base) : await defaultBase(env);
  if (named === null) return { ok: false, reason: 'could not tell which branch the PR will target (no origin/HEAD, no upstream, no development/main/master branch): pass base' };
  const base = await baseRef(env, named);
  if (!base.ok) return { ok: false, reason: base.reason };
  const toModel: string[] = [];
  if (input.stakeholder !== undefined) toModel.push(`the Stakeholder you sent ("${oneLine(input.stakeholder).slice(0, 80)}") was ignored: the harness names the person at this terminal (${env.person})`);
  const owner = input.owner !== undefined && oneLine(input.owner).length > 0 ? oneLine(input.owner) : env.person;
  const measure = input.measureScript !== undefined ? `node metrics/${input.slug}.mjs` : 'none';
  const text = draftedContract(input, { repo: await repoField(env), base: named, measure, stakeholder: env.person, owner });
  const parse = parseContract(text);
  const why = incompleteReason(parse, text);
  if (why !== null) return { ok: false, reason: why };
  // What is written is what the box shows and node runs: \r\n read as \n (the schema refused anything else that breaks a line).
  const drafted = input.measureScript !== undefined ? normalizeScript(input.measureScript) : undefined;
  const script = drafted !== undefined ? { path: `metrics/${input.slug}.mjs`, text: drafted.endsWith('\n') ? drafted : `${drafted}\n` } : null;
  return propose(env, input.slug, text, parse, base, script, [`Repo, Base and Stakeholder filled by the harness: ${(parse.fields.Repo ?? '').trim()}, base ${named}, ${env.person}`], toModel);
}

/**
 * A contract the owner wrote (/import <path>): <slug>.md, as written, with its Measure script next to it
 * (the file the Measure line names, or <slug>.mjs). `cwd` resolves a relative path.
 */
export async function proposeImported(path: string, cwd: string, env: ProposalEnv): Promise<ProposalOutcome> {
  const file = resolve(cwd, path);
  if (!existsSync(file)) return { ok: false, reason: `no such file: ${tildePath(file)}` };
  const slug = basename(file).replace(/\.md$/i, '');
  const bad = slugProblem(env.itemsRoot, slug);
  if (bad !== null) return { ok: false, reason: `${bad} (the file name, without .md, is the slug)` };
  const text = readFileSync(file, 'utf8');
  const parse = parseContract(text);
  const why = incompleteReason(parse, text);
  if (why !== null) return { ok: false, reason: why };
  const base = await baseRef(env, (parse.fields.Base ?? '').trim());
  if (!base.ok) return { ok: false, reason: base.reason };
  let script: ShownScript | null = null;
  if (parse.measure !== null) {
    const named = join(dirname(file), basename(parse.measure.script));
    const bySlug = join(dirname(file), `${slug}.mjs`);
    const source = existsSync(named) ? named : existsSync(bySlug) ? bySlug : null;
    if (source === null) return { ok: false, reason: `the Measure line names ${parse.measure.script}: put ${basename(parse.measure.script)} next to the contract (${tildePath(dirname(file))})` };
    const scriptText = normalizeScript(readFileSync(source, 'utf8'));
    // The owner reads it in the box before saying yes: it must read as node runs it.
    const unreadable = measureScriptProblem(scriptText);
    if (unreadable !== null) return { ok: false, reason: `the Measure script ${tildePath(source)} cannot be shown as it runs: ${unreadable}` };
    script = { path: parse.measure.script, text: scriptText };
  }
  return propose(env, slug, text, parse, base, script, [`imported from ${tildePath(file)} (Repo and Base as written)`], []);
}

/** What the model may hear about a failed reading: how it failed, never what the script printed. */
export function readingFailureForModel(r: Extract<MeasureResult, { ok: false }>): string {
  switch (r.failure) {
    case 'exit':
      return `the Measure script exited ${String(r.code ?? 'abnormally')}`;
    case 'no-number':
      return 'the Measure script printed no number';
    case 'timeout':
      return 'the Measure script timed out';
    case 'nondeterministic':
      return 'the Measure script printed two different numbers on two runs';
    default:
      return 'the harness could not run the Measure script';
  }
}

export interface BeforeReading {
  ok: boolean;
  /** For the owner's terminal. */
  owner: string;
  /** For the model: never the script's output. */
  model: string;
  reading?: MetricReading;
}

/**
 * After the owner's typed yes: the before value, read by the harness at the contract's Base (origin's
 * branch, else the local one), recorded as the ledger's `metric` entry (phase before) and written into
 * the contract's Metric line (which the contract hash ignores). Null when the contract has no Measure.
 */
export async function readBefore(env: Pick<ProposalEnv, 'top' | 'itemsRoot' | 'harnessRoot' | 'exec'>, slug: string): Promise<BeforeReading | null> {
  const status = itemStatus(env.itemsRoot, slug);
  const parse = status.contract.parse;
  if (parse === null || parse.measure === null) return null;
  const consequence = 'the item can ship, but it can never close without a before value';
  const base = await baseRef(env, (parse.fields.Base ?? '').trim());
  if (!base.ok) return { ok: false, owner: `no before value: ${base.reason}; ${consequence}`, model: 'the harness could not read the before value (the Base did not resolve)' };
  let r: MeasureResult;
  try {
    r = await readMetric({ harnessRoot: env.harnessRoot, itemsRoot: env.itemsRoot, repoDir: env.top, ref: base.ref, measure: parse.measure, exec: env.exec, label: slug });
  } catch (e) {
    return { ok: false, owner: `no before value: ${errMsg(e)}; ${consequence}`, model: 'the harness could not run the Measure script' };
  }
  if (!r.ok) return { ok: false, owner: `no before value: ${r.reason}; ${consequence}`, model: readingFailureForModel(r) };
  const paths = itemPaths(env.itemsRoot, slug);
  appendLedger(paths.ledger, { type: 'metric', phase: 'before', reading: r.reading });
  writeMetricValues(paths.contract, String(r.reading.value), null);
  const unproven = r.unproven !== undefined ? `; UNPROVEN: ${r.unproven}` : '';
  return { ok: true, reading: r.reading, owner: `before value: ${r.reading.value} (read by the harness at ${base.short} ${r.reading.sha.slice(0, 12)}${unproven})`, model: 'the harness read the before value after the approval and recorded it in the item ledger' };
}
