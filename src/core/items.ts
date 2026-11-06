/**
 * Backlog items (assignment 02): the contract every item gate reads, the ledger that records what
 * the stakeholder and the harness did, and the verdicts the gates block on.
 *
 *   contract  docs/contracts/<slug>.md, written by people (the agent may only draft one through a
 *             harness tool): Problem, Owner, Stakeholder, Repo, Base, Commit (the Conventional
 *             Commits header the harness ships with), Metric (name, window, before, after), Measure
 *             (the command the harness runs to read the metric), one or more Scenario lines
 *             (WHEN ... THEN ...), Not included, optionally Ticket, and Signed (written by the harness).
 *   ledger    items/<slug>/ledger.jsonl: append-only, hash-chained, written only by the harness
 *             process, never by a model tool (path-guard confines model writes to the target
 *             worktree): proposed, human_turn, approved, declined, metric, run, shipped, closed.
 *   verdicts  contractVerdict (problem-statement gate) and approvalVerdict (human-yes gate) are pure
 *             functions of the contract text and the ledger, so the hooks that block on them, the
 *             finish gate and the CLI that reports them can never disagree.
 *
 * Fail closed: an unparsable contract, a placeholder value, a broken hash chain, an approval of an
 * older contract text, a reply that was not typed at a terminal, a reply before the proposal and an
 * ambiguous reply are never an approval, and every refusal names what is missing.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { operatorProvenance, provenanceText, type OperatorProvenance } from './provenance.ts';
import { commitHeaderProblems } from './ship-text.ts';

// ───────────────────────────── paths ─────────────────────────────

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const CONTRACTS_DIR = 'docs/contracts';
export const ITEMS_DIR = 'items';

export interface ItemPaths {
  slug: string;
  /** Absolute path of docs/contracts/<slug>.md. */
  contract: string;
  /** Absolute path of items/<slug>/. */
  dir: string;
  /** Absolute path of items/<slug>/ledger.jsonl. */
  ledger: string;
}

/**
 * Where docs/contracts/ and items/ live: the harness root, or HARNESS_ITEMS_ROOT (relative to the
 * harness root) so tests never write into the committed records, like HARNESS_RUNS_DIR for runs/.
 */
export function itemsRoot(harnessRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const o = env['HARNESS_ITEMS_ROOT'];
  return o !== undefined && o.length > 0 ? resolve(harnessRoot, o) : harnessRoot;
}

/** Why `slug` cannot name an item, or null (the command line checks it before reading anything). */
export function slugProblem(slug: string): string | null {
  return SLUG_RE.test(slug) ? null : `invalid item slug "${slug}": use lower-case letters, digits and dashes (2-63 characters)`;
}

export function itemPaths(harnessRoot: string, slug: string): ItemPaths {
  const bad = slugProblem(slug);
  if (bad !== null) throw new Error(bad);
  const dir = join(harnessRoot, ITEMS_DIR, slug);
  return { slug, contract: join(harnessRoot, CONTRACTS_DIR, `${slug}.md`), dir, ledger: join(dir, 'ledger.jsonl') };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ───────────────────────────── contract ─────────────────────────────

/** Every field a contract must carry before an edit may happen (the refusal names the missing ones). */
export const REQUIRED_FIELDS = ['Problem', 'Owner', 'Stakeholder', 'Repo', 'Base', 'Commit', 'Metric', 'Measure', 'Scenario', 'Not included'] as const;
/** Ticket is optional (work reaches me through people more often than tickets); Signed is written by the harness. */
export type ContractField = (typeof REQUIRED_FIELDS)[number] | 'Ticket' | 'Signed';

const FIELD_NAMES: Record<string, ContractField> = {
  problem: 'Problem',
  owner: 'Owner',
  stakeholder: 'Stakeholder',
  repo: 'Repo',
  repository: 'Repo',
  base: 'Base',
  'base branch': 'Base',
  commit: 'Commit',
  'commit header': 'Commit',
  'commit title': 'Commit',
  ticket: 'Ticket',
  metric: 'Metric',
  measure: 'Measure',
  scenario: 'Scenario',
  scenarios: 'Scenario',
  'not included': 'Not included',
  'not-included': 'Not included',
  signed: 'Signed',
};

export interface MetricSpec {
  name: string;
  window: string;
  /** The value in the contract text ("____" and other placeholders read as null). */
  before: string | null;
  after: string | null;
}

export interface MeasureSpec {
  /** Items-root-relative script path, always metrics/<file>.mjs (measure.ts measureScriptPath finds it). */
  script: string;
  args: string[];
  /** The command as written. */
  text: string;
}

export interface Scenario {
  when: string;
  then: string;
}

export interface ContractParse {
  /** Raw text per field (Scenario: every scenario line joined by newlines). */
  fields: Partial<Record<ContractField, string>>;
  metric: MetricSpec | null;
  /** The Measure command; null when it is missing, malformed, or the contract says "Measure: none". */
  measure: MeasureSpec | null;
  /**
   * The contract says "Measure: none": an item without a metric script (a session's small change). The
   * contract is complete without one, but its outcome can never be read, so it can never close.
   */
  noMeasure: boolean;
  scenarios: Scenario[];
  notIncluded: string[];
  /** The Signed line, verbatim (the harness writes it; the human-yes gate never reads it). */
  signed: string | null;
  /** Fields that are absent or still a placeholder, named for the refusal. */
  missing: string[];
  /** Fields that are present but malformed. */
  problems: string[];
  /** missing and problems are both empty. */
  complete: boolean;
  /** sha256 of the approval-relevant text: no Signed line, before/after values blanked. */
  hash: string;
}

/** Template placeholders: <...>, underscores, TBD/TODO/N/A, or nothing at all. */
export function isPlaceholder(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const v = value.trim();
  if (v.length === 0) return true;
  if (/^_+$/.test(v)) return true;
  if (/^(tbd|todo|n\/a|na|none|-+|\.\.\.|…)$/i.test(v)) return true;
  if (/<[^<>]{1,200}>/.test(v)) return true;
  return false;
}

/** A markdown line reduced to "Field: value" form when it starts a field (bold, list markers stripped). */
function fieldStart(line: string): { field: ContractField; value: string } | null {
  const s = line.replace(/^\s*(?:[-*+]\s+)?/, '').replace(/^(\*\*|__)(.+?)\1\s*/, '$2 ').trim();
  const m = /^([A-Za-z][A-Za-z -]{1,20}?)\s*:\s*(.*)$/.exec(s.replace(/^(\*\*|__)/, ''));
  if (m === null) return null;
  const key = (m[1] ?? '').trim().toLowerCase();
  const field = FIELD_NAMES[key];
  if (field === undefined) return null;
  return { field, value: (m[2] ?? '').replace(/^(\*\*|__)\s*/, '').trim() };
}

const METRIC_RE = /^(?<name>[^,]+),\s*(?<window>.*?)\s+before:\s*(?<before>.*?)\s+after:\s*(?<after>.*?)\s*$/i;

export function parseMetric(text: string): MetricSpec | { error: string } {
  const m = METRIC_RE.exec(text.trim());
  if (m?.groups === undefined) return { error: 'Metric must read "<name>, <window> before: ____ after: ____"' };
  const g = m.groups;
  const value = (v: string | undefined): string | null => (isPlaceholder(v) ? null : (v ?? '').trim());
  return { name: (g['name'] ?? '').trim(), window: (g['window'] ?? '').trim(), before: value(g['before']), after: value(g['after']) };
}

/**
 * Repo: `<owner>/<name>` (the origin remote), or `local:<name>` for a repository with no remote (a
 * session contract in a local checkout; such an item can be committed but never pushed or closed).
 */
export const REPO_RE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|local:[A-Za-z0-9_.-]+)$/;

/** The Measure value that says, explicitly, that an item has no metric script. */
export const NO_MEASURE = 'none';

/** "Measure: none" (any letter case): no metric script, said on purpose (not a placeholder left unfilled). */
export function isNoMeasure(value: string | undefined): boolean {
  return value !== undefined && value.trim().replace(/^`+|`+$/g, '').trim().toLowerCase() === NO_MEASURE;
}

const MEASURE_SCRIPT_RE = /^metrics\/[a-z0-9][a-z0-9._-]*\.mjs$/;
const MEASURE_ARG_RE = /^[A-Za-z0-9._=:,/@+-]+$/;

/**
 * Measure: `node metrics/<file>.mjs [args]` only: a script in metrics/ under the items root (the harness
 * root in file mode, the session's state directory in a session), plain arguments, no shell.
 */
export function parseMeasure(text: string): MeasureSpec | { error: string } {
  const t = text.trim().replace(/^`+|`+$/g, '').trim();
  const parts = t.split(/\s+/).filter((p) => p.length > 0);
  const err = { error: 'Measure must be `node metrics/<script>.mjs [args]`: a script in the metrics/ directory of the items root with plain arguments (no shell syntax)' };
  if (parts[0] !== 'node' || parts.length < 2) return err;
  const script = parts[1] ?? '';
  if (!MEASURE_SCRIPT_RE.test(script) || script.includes('..')) return err;
  const args = parts.slice(2);
  if (args.some((a) => !MEASURE_ARG_RE.test(a) || a.includes('..'))) return err;
  return { script, args, text: t };
}

const SCENARIO_RE = /^\s*WHEN\s+(?<when>.+?)\s+THEN\s+(?<then>.+?)\s*$/;

/**
 * The control characters in `text` other than `allowed` (C0 and ESC, DEL, C1, the bidirectional
 * overrides and isolates), as code points such as "U+001B", deduplicated; [] when there are none.
 */
export function controlChars(text: string, allowed = '\n\t'): string[] {
  const found = new Set<string>();
  for (const ch of text) {
    if (allowed.includes(ch)) continue;
    const c = ch.codePointAt(0) ?? 0;
    const bad = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x61c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    if (bad) found.add(`U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  return [...found];
}

function normalizeForHash(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const f = fieldStart(line);
    if (f?.field === 'Signed') continue;
    if (f?.field === 'Metric') {
      out.push(`Metric: ${f.value.replace(/\s+before:.*$/i, ' before: ____ after: ____')}`.trimEnd());
      continue;
    }
    out.push(line.trimEnd());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parse docs/contracts/<slug>.md. A field continues on the following lines until the next field or
 * heading; Scenario may repeat ("Scenario: WHEN ... THEN ..." or a "Scenarios:" header followed by
 * "- WHEN ... THEN ..." lines); "Not included" may be one line or a list.
 */
export function parseContract(text: string): ContractParse {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const values = new Map<ContractField, string[]>();
  const scenarioLines: string[] = [];
  let current: ContractField | null = null;
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || /^\s*```/.test(raw)) {
      current = null;
      continue;
    }
    const f = fieldStart(raw);
    if (f !== null) {
      current = f.field;
      if (f.field === 'Scenario') {
        if (f.value.length > 0) scenarioLines.push(f.value);
      } else {
        const prev = values.get(f.field);
        values.set(f.field, prev === undefined ? [f.value] : [...prev, f.value]);
      }
      continue;
    }
    if (current === null || raw.trim().length === 0) continue;
    const cont = raw.replace(/^\s*(?:[-*+]\s+)?/, '').trim();
    if (current === 'Scenario') scenarioLines.push(cont);
    else values.get(current)?.push(cont);
  }

  const fields: Partial<Record<ContractField, string>> = {};
  for (const [k, v] of values) fields[k] = v.filter((x) => x.length > 0).join('\n');
  if (scenarioLines.length > 0) fields.Scenario = scenarioLines.join('\n');

  const missing: string[] = [];
  const problems: string[] = [];
  for (const name of ['Problem', 'Owner', 'Stakeholder', 'Repo', 'Base'] as const) {
    if (isPlaceholder(fields[name])) missing.push(name);
  }
  if (values.has('Problem') && (values.get('Problem') ?? []).length > 1) problems.push('Problem appears more than once');
  // The commit the harness will ship is part of what the stakeholder approves (habit 5: commits that say nothing).
  if (isPlaceholder(fields.Commit)) missing.push('Commit');
  else problems.push(...commitHeaderProblems(fields.Commit ?? ''));

  let metric: MetricSpec | null = null;
  if (isPlaceholder(fields.Metric?.replace(/\s+before:.*$/i, ''))) missing.push('Metric');
  else {
    const m = parseMetric((fields.Metric ?? '').split('\n')[0] ?? '');
    if ('error' in m) problems.push(m.error);
    else {
      metric = m;
      if (isPlaceholder(m.name)) missing.push('Metric name');
      if (isPlaceholder(m.window)) missing.push('Metric window');
    }
  }

  let measure: MeasureSpec | null = null;
  // "Measure: none" says, explicitly, that the item has no metric script ("none" is a placeholder everywhere else).
  const noMeasure = isNoMeasure(fields.Measure);
  if (noMeasure) measure = null;
  else if (isPlaceholder(fields.Measure)) missing.push('Measure');
  else {
    const m = parseMeasure(fields.Measure ?? '');
    if ('error' in m) problems.push(m.error);
    else measure = m;
  }

  const scenarios: Scenario[] = [];
  if (scenarioLines.length === 0 || scenarioLines.every((s) => isPlaceholder(s))) missing.push('Scenario (WHEN ... THEN ...)');
  else {
    for (const s of scenarioLines) {
      if (isPlaceholder(s)) {
        problems.push(`Scenario is still a placeholder: "${s}"`);
        continue;
      }
      const m = SCENARIO_RE.exec(s);
      const when = m?.groups?.['when'] ?? '';
      const then = m?.groups?.['then'] ?? '';
      if (m === null || isPlaceholder(when) || isPlaceholder(then)) problems.push(`Scenario must read "WHEN <condition> THEN <observable result>": "${s}"`);
      else scenarios.push({ when: when.trim(), then: then.trim() });
    }
  }

  const notIncluded = (values.get('Not included') ?? []).flatMap((v) => v.split('\n')).map((v) => v.trim()).filter((v) => !isPlaceholder(v));
  if (notIncluded.length === 0) missing.push('Not included');

  const repo = fields.Repo?.trim();
  if (repo !== undefined && !isPlaceholder(repo) && !REPO_RE.test(repo)) problems.push(`Repo must be "<owner>/<name>", or "local:<name>" for a repository without a remote (got "${repo}")`);
  const base = fields.Base?.trim();
  if (base !== undefined && !isPlaceholder(base) && !/^[A-Za-z0-9._/-]+$/.test(base)) problems.push(`Base must be a branch name (got "${base}")`);
  // What the stakeholder approves must read as it is: no ESC sequence, carriage return or bidi override.
  const control = controlChars(lines.join('\n'));
  if (control.length > 0) problems.push(`the contract contains control characters (${control.join(', ')}): remove them, a contract must read as it is`);

  const signedRaw = values.get('Signed');
  const signed = signedRaw === undefined ? null : signedRaw.join(' ').trim() || null;
  return {
    fields,
    metric,
    measure,
    noMeasure,
    scenarios,
    notIncluded,
    signed,
    missing,
    problems,
    complete: missing.length === 0 && problems.length === 0,
    hash: sha256Hex(normalizeForHash(lines)),
  };
}

/** The problem-statement verdict: whether an edit may happen under this contract, and why not. */
export interface ContractVerdict {
  ok: boolean;
  reason: string;
  parse: ContractParse | null;
}

export function contractVerdict(paths: ItemPaths, read: (file: string) => string | null = readOrNull): ContractVerdict {
  const rel = `${CONTRACTS_DIR}/${paths.slug}.md`;
  const text = read(paths.contract);
  if (text === null) return { ok: false, reason: `no contract for item "${paths.slug}": write ${rel} (${REQUIRED_FIELDS.join(', ')}) before any source edit`, parse: null };
  const parse = parseContract(text);
  if (parse.complete) return { ok: true, reason: `${rel} names every required field`, parse };
  const parts: string[] = [];
  if (parse.missing.length > 0) parts.push(`missing ${parse.missing.join(', ')}`);
  if (parse.problems.length > 0) parts.push(parse.problems.join('; '));
  return { ok: false, reason: `${rel} is incomplete: ${parts.join('; ')}`, parse };
}

/**
 * Why a contract cannot authorize a run that is not in place (file mode), or null: it says "Measure: none". A
 * file-mode item exists to be closed on its metric, and without a Measure its outcome can never be read. Only an
 * interactive session (a run in place) may work under such a contract: it can ship, but it never closes.
 */
export function fileModeMeasureProblem(parse: Pick<ContractParse, 'noMeasure'>, slug: string): string | null {
  if (!parse.noMeasure) return null;
  return `${CONTRACTS_DIR}/${slug}.md says "Measure: none", but a run outside an interactive session needs a Measure (node metrics/<script>.mjs): without one the item's outcome can never be read, so it could never close`;
}

/**
 * The problem-statement verdict where the work happens: the contract's own (contractVerdict), and for a run that
 * is not in place (file mode) "Measure: none" refused (fileModeMeasureProblem), as problem-gate and bindItem
 * refuse it. `harness gate problem-statement` and `harness item status` read it, so they can never disagree.
 */
export function problemStatementVerdict(contract: ContractVerdict, slug: string, opts: { fileMode: boolean }): { ok: boolean; reason: string } {
  const noMeasure = opts.fileMode && contract.ok && contract.parse !== null ? fileModeMeasureProblem(contract.parse, slug) : null;
  return noMeasure !== null ? { ok: false, reason: noMeasure } : { ok: contract.ok, reason: contract.reason };
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ───────────────────────────── ledger ─────────────────────────────

/** Where a human turn came from. Only 'tty' (typed at an interactive terminal) can approve. */
export type TurnChannel = 'tty' | 'pipe';

export interface MetricReading {
  value: number;
  /** Commit the metric was read at. */
  sha: string;
  /** Branch or ref name the commit was resolved from. */
  ref: string;
  command: string;
  /** sha256 of the Measure script that produced the value (before and after must match). */
  scriptSha256: string;
  /** sha256 of the command's stdout. */
  stdoutSha256: string;
  /** Last lines of stdout, for the record. */
  excerpt: string;
  /** The sandbox mechanism that confined the Measure run ('none' = unconfined). */
  confinement: string;
}

export type LedgerEvent =
  | { type: 'proposed'; contractHash: string; stakeholder: string; before: MetricReading | null; session: string; text: string }
  | {
      type: 'human_turn';
      text: string;
      channel: TurnChannel;
      session: string;
      inReplyTo: number | null;
      /** sha256 of the contract text on disk when the reply was typed (null: no contract); absent on older entries. */
      contractHash?: string | null;
      /** Agent-shell environment markers present when it was recorded, names only (provenance.ts); absent on older entries. */
      agentEnv?: string[];
    }
  | { type: 'approved'; turn: number; contractHash: string; stakeholder: string }
  | { type: 'declined'; turn: number; contractHash: string; reason: string }
  | { type: 'metric'; phase: 'before' | 'after'; reading: MetricReading }
  | { type: 'run'; runId: string; status: string; verdict: string; contractHash: string }
  | { type: 'shipped'; runId: string; branch: string; headSha: string; base: string; prUrl: string | null }
  | { type: 'closed'; before: MetricReading; after: MetricReading; prUrl: string; mergeSha: string; mergedBy: string; closeRunId: string };

export interface LedgerEntry {
  seq: number;
  at: string;
  /** The previous entry's `hash` ('' for the first). */
  prev: string;
  event: LedgerEvent;
  /** sha256 of {seq, at, prev, event}: an edit of any entry, the last one included, shows. */
  hash: string;
}

function entryHash(e: Pick<LedgerEntry, 'seq' | 'at' | 'prev' | 'event'>): string {
  return sha256Hex(JSON.stringify({ seq: e.seq, at: e.at, prev: e.prev, event: e.event }));
}

export interface Ledger {
  entries: LedgerEntry[];
  /** Hash-chain and sequence problems (any one makes every verdict that needs the ledger UNPROVEN). */
  problems: string[];
}

export function readLedger(file: string): Ledger {
  if (!existsSync(file)) return { entries: [], problems: [] };
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  const entries: LedgerEntry[] = [];
  const problems: string[] = [];
  let prev = '';
  lines.forEach((line, i) => {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1} is not JSON`);
      return;
    }
    const entry = e as LedgerEntry;
    if (entry.seq !== i + 1) problems.push(`line ${i + 1} has seq ${String(entry.seq)} (expected ${i + 1})`);
    if (entry.prev !== prev) problems.push(`line ${i + 1} does not chain to the line before it (edited by hand?)`);
    if (entry.hash !== entryHash(entry)) problems.push(`line ${i + 1} does not match its own hash (edited by hand?)`);
    prev = typeof entry.hash === 'string' ? entry.hash : '';
    entries.push(entry);
  });
  return { entries, problems };
}

/** Append one event (the only writer of the ledger); returns the new entry. Refuses to extend a broken chain. */
export function appendLedger(file: string, event: LedgerEvent, now: () => Date = () => new Date()): LedgerEntry {
  const ledger = readLedger(file);
  if (ledger.problems.length > 0) throw new Error(`item ledger ${file} is broken (${ledger.problems.join('; ')}): refusing to append`);
  const body = { seq: ledger.entries.length + 1, at: now().toISOString(), prev: ledger.entries.at(-1)?.hash ?? '', event };
  const entry: LedgerEntry = { ...body, hash: entryHash(body) };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

// ───────────────────────────── human yes ─────────────────────────────

export type ReplyKind = 'yes' | 'no' | 'unclear';

const YES_RE = /\b(yes|yep|yeah|yup|approve|approved|approving|go ahead|go for it|looks good|lgtm|ship it|sounds good|agreed|agree|confirm|confirmed|proceed|do it|okay|ok|sure)\b/;
const NO_RE = /\b(no|nope|nah|not|don'?t|dont|do not|never|wait|hold|stop|reject|rejected|decline|declined|change|changes|but|except|however|instead|later|unless|if|until|without|cancel)\b/;

/**
 * A stakeholder reply in their own words. 'yes' needs an affirmative and nothing that negates,
 * conditions or questions it; anything mixed or unclear is not a yes (fail closed): "yes but change
 * the metric" is unclear, so the proposal stays open.
 */
export function classifyReply(text: string): { kind: ReplyKind; why: string } {
  const t = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (t.length === 0) return { kind: 'unclear', why: 'empty reply' };
  const yes = YES_RE.exec(t);
  const no = NO_RE.exec(t);
  if (t.includes('?')) return { kind: 'unclear', why: 'the reply asks a question' };
  if (yes !== null && no === null) return { kind: 'yes', why: `affirmative "${yes[0]}"` };
  if (no !== null && yes === null) return { kind: 'no', why: `"${no[0]}"` };
  if (yes !== null && no !== null) return { kind: 'unclear', why: `"${yes[0]}" together with "${no[0]}": approve plainly, or say what to change` };
  return { kind: 'unclear', why: 'no affirmative word (yes, approve, go ahead, looks good, ...)' };
}

export interface ApprovalVerdict {
  ok: boolean;
  reason: string;
  /** The ledger seq of the proposal the verdict is about, if any. */
  proposal: number | null;
  /** The approving human turn. */
  turn: LedgerEntry | null;
  stakeholder: string | null;
  /** Replies that were seen but did not count, with why (shown in refusals). */
  ignored: string[];
  /**
   * Seqs of plain yes replies to the latest proposal, typed at a terminal, that record no contract text
   * (typed before replies recorded one): they never count, and the stakeholder must type the yes again.
   * Set only when no reply decided the proposal.
   */
  retype?: number[];
}

/**
 * The human-yes verdict: the latest proposal of THIS contract text, followed by a typed terminal
 * turn whose latest decisive reply is a yes. Nothing else counts: not assistant text, not tool or
 * hook output (they never enter the ledger as human turns), not a turn on a pipe, not a reply to an
 * older proposal, not a reply typed while the contract on disk read differently from the proposed text
 * (or one that does not record which text it was typed against), and not a Signed line. The approving
 * reason says how the reply arrived (provenance.ts): a terminal proves a terminal, not a person.
 */
export function approvalVerdict(ledger: Ledger, contractHash: string): ApprovalVerdict {
  const none = { proposal: null, turn: null, stakeholder: null };
  if (ledger.problems.length > 0) return { ok: false, reason: `the item ledger is broken (${ledger.problems.join('; ')}): the stakeholder's yes cannot be proven`, ignored: [], ...none };
  const proposals = ledger.entries.filter((e) => e.event.type === 'proposed');
  const latest = proposals.at(-1);
  if (latest === undefined || latest.event.type !== 'proposed') return { ok: false, reason: 'the contract was never proposed to the stakeholder (harness item propose <slug>)', ignored: [], ...none };
  const stakeholder = latest.event.stakeholder;
  if (latest.event.contractHash !== contractHash) {
    return { ok: false, reason: `the contract changed after it was proposed (proposal seq ${latest.seq}): propose it again and get a new yes`, ignored: [], proposal: latest.seq, turn: null, stakeholder };
  }
  const ignored: string[] = [];
  const retype: number[] = [];
  let decisive: { entry: LedgerEntry; kind: ReplyKind } | null = null;
  for (const e of ledger.entries) {
    if (e.event.type !== 'human_turn') continue;
    const ev = e.event;
    const quote = ev.text.length > 60 ? `${ev.text.slice(0, 57)}...` : ev.text;
    if (e.seq < latest.seq) {
      if (classifyReply(ev.text).kind === 'yes') ignored.push(`"${quote}" (seq ${e.seq}) came before the proposal`);
      continue;
    }
    if (ev.channel !== 'tty') {
      ignored.push(`"${quote}" (seq ${e.seq}) arrived on a pipe, not typed at a terminal`);
      continue;
    }
    if (ev.inReplyTo !== latest.seq) {
      ignored.push(`"${quote}" (seq ${e.seq}) answers proposal ${String(ev.inReplyTo)}, not the latest (${latest.seq})`);
      continue;
    }
    // A reply counts only for the contract text that was on disk when it was typed: never as a yes for
    // another text. A "no" still stands, whatever text it was typed against (fail closed).
    if (ev.contractHash !== latest.event.contractHash) {
      if (classifyReply(ev.text).kind === 'no') {
        decisive = { entry: e, kind: 'no' };
        continue;
      }
      ignored.push(ev.contractHash === undefined
        ? `"${quote}" (seq ${e.seq}) does not record the contract text it was typed against`
        : `"${quote}" (seq ${e.seq}) was typed while the contract read differently (${(ev.contractHash ?? 'none').slice(0, 12)}), not the proposed text (${latest.event.contractHash.slice(0, 12)})`);
      if (ev.contractHash === undefined && classifyReply(ev.text).kind === 'yes') retype.push(e.seq);
      continue;
    }
    const c = classifyReply(ev.text);
    if (c.kind === 'unclear') {
      ignored.push(`"${quote}" (seq ${e.seq}) is not a plain yes: ${c.why}`);
      continue;
    }
    decisive = { entry: e, kind: c.kind };
  }
  if (decisive === null) {
    return {
      ok: false,
      reason: `no typed yes from ${stakeholder} after the proposal (seq ${latest.seq})${ignored.length > 0 ? `; not counted: ${ignored.join('; ')}` : ''}`,
      ignored,
      proposal: latest.seq,
      turn: null,
      stakeholder,
      ...(retype.length > 0 ? { retype } : {}),
    };
  }
  if (decisive.kind === 'no') {
    const ev = decisive.entry.event;
    const text = ev.type === 'human_turn' ? ev.text : '';
    return { ok: false, reason: `${stakeholder} did not approve (seq ${decisive.entry.seq}: "${text}"): change the contract and propose it again`, ignored, proposal: latest.seq, turn: decisive.entry, stakeholder };
  }
  const how = decisive.entry.event.type === 'human_turn' ? provenanceText(decisive.entry.event.channel, decisive.entry.event.agentEnv) : '';
  return { ok: true, reason: `${stakeholder} approved proposal seq ${latest.seq} in a typed turn (seq ${decisive.entry.seq}): ${how}`, ignored, proposal: latest.seq, turn: decisive.entry, stakeholder };
}

/** The proposal the next human turn answers (the latest one), or null. */
export function openProposal(ledger: Ledger): number | null {
  const p = ledger.entries.filter((e) => e.event.type === 'proposed').at(-1);
  return p === undefined ? null : p.seq;
}

/** What `harness item status <slug>` says when a yes stopped counting because it records no contract text (ApprovalVerdict.retype). */
export function retypeLine(slug: string): string {
  return `a reply recorded without the contract text it answered does not count; type it again: harness item reply ${slug}`;
}

// ───────────────────────────── runs and ships ─────────────────────────────

/** The item's record of one governed run: executeRun writes it before any ship (a ship needs it on record). */
export type LedgerRun = Omit<Extract<LedgerEvent, { type: 'run' }>, 'type'>;
/** The item's record of a ship: the branch pushed, the head commit, the PR the harness opened. */
export type LedgerShipped = Omit<Extract<LedgerEvent, { type: 'shipped' }>, 'type'>;

/** A `run` verdict that ended DONE: 'DONE', or 'DONE (...)' (the gates decided without a finish call, or a fresh green ship). */
export function isDoneVerdict(verdict: string): boolean {
  return /^DONE\b/.test(verdict);
}

/** The verdict `harness ship` records for a run once every ship-phase gate re-ran fresh and green on its tree. */
export const SHIP_DONE_VERDICT = 'DONE (harness ship: every ship gate re-ran fresh and green)';

function isDoneRunOf(e: LedgerEntry, run: LedgerRun): boolean {
  return e.event.type === 'run' && e.event.runId === run.runId && e.event.contractHash === run.contractHash && isDoneVerdict(e.event.verdict);
}

/**
 * Why no new work may happen under this item, or null: it is closed. An approval covers the work it was given
 * for, once; the outcome of that work is recorded, so another run, or another ship, needs a new item. One
 * wording for every place that refuses it (bindItem, ship, the ledger writer), so they can never disagree.
 */
export function closedItemProblem(ledger: Ledger, slug: string): string | null {
  const closed = ledger.entries.find((e) => e.event.type === 'closed');
  if (closed === undefined) return null;
  return `item "${slug}" is closed (ledger seq ${closed.seq}): its approval covered the work that closed it; new work needs a new item (harness item new <slug>)`;
}

/**
 * The DONE run a ship stands on, as the ledger's latest entry: the entry already there when the latest entry
 * is a DONE run of this run id under this contract text, else this `run` record appended now. Throws, writing
 * nothing, for a run that did not end DONE, a contract text the ledger does not approve (a broken ledger
 * approves nothing) or a closed item: what it records is exactly what the outcome check accepts (close.ts
 * shippedRunProblem), for an item whose outcome is not recorded yet.
 */
export function recordDoneRun(file: string, run: LedgerRun, now: () => Date = () => new Date()): LedgerEntry {
  if (!isDoneVerdict(run.verdict)) throw new Error(`run ${run.runId} did not end DONE (${run.verdict}): no ship stands on it`);
  const ledger = readLedger(file);
  const approval = approvalVerdict(ledger, run.contractHash);
  if (!approval.ok) throw new Error(`run ${run.runId} worked under contract text ${run.contractHash.slice(0, 12)}, which is not approved: ${approval.reason}`);
  const closed = closedItemProblem(ledger, basename(dirname(file)));
  if (closed !== null) throw new Error(`no ship of run ${run.runId} can be recorded: ${closed}`);
  const latest = ledger.entries.at(-1);
  if (latest !== undefined && isDoneRunOf(latest, run)) return latest;
  return appendLedger(file, { type: 'run', ...run }, now);
}

/**
 * The only writer of `shipped` (ship.ts): it goes in immediately after a DONE `run` entry of the same run id
 * under the approved contract text (recordDoneRun appends that entry when the latest one is not it), so the
 * outcome check finds the run that cleared what shipped. Throws, writing no `shipped` entry, when that run
 * cannot be recorded.
 */
export function appendShipped(file: string, run: LedgerRun, shipped: LedgerShipped, now: () => Date = () => new Date()): LedgerEntry {
  if (shipped.runId !== run.runId) throw new Error(`a ship of run ${shipped.runId} cannot stand on the record of run ${run.runId}`);
  recordDoneRun(file, run, now);
  return appendLedger(file, { type: 'shipped', ...shipped }, now);
}

// ───────────────────────────── operations ─────────────────────────────

export type ItemStage = 'no-contract' | 'incomplete' | 'unproposed' | 'awaiting-yes' | 'declined' | 'approved' | 'shipped' | 'closed' | 'broken';

export interface ItemStatus {
  slug: string;
  paths: ItemPaths;
  contract: ContractVerdict;
  /** Null when there is no complete contract to approve. */
  approval: ApprovalVerdict | null;
  ledger: Ledger;
  stage: ItemStage;
  /** Edits may happen: the contract is complete and THIS text is approved in a typed turn. */
  editable: boolean;
  /** One line per gate: what is proven and what is missing. */
  lines: string[];
}

/**
 * The item's stage and one line per gate. `fileMode`: the item is read for a run that is not in place (the
 * file-mode items root), so its problem-statement line is the verdict problem-gate and bindItem reach there
 * (problemStatementVerdict); the stage and `editable` say what the contract and the ledger record, either way.
 */
export function itemStatus(root: string, slug: string, opts: { fileMode?: boolean } = {}): ItemStatus {
  const paths = itemPaths(root, slug);
  const contract = contractVerdict(paths);
  const statement = problemStatementVerdict(contract, slug, { fileMode: opts.fileMode === true });
  const ledger = readLedger(paths.ledger);
  const approval = contract.parse !== null && contract.ok ? approvalVerdict(ledger, contract.parse.hash) : null;
  const has = (t: LedgerEvent['type']): boolean => ledger.entries.some((e) => e.event.type === t);
  // A proposal of an older text is no proposal of this one: the item needs a new proposal, not a yes.
  const latest = ledger.entries.filter((e) => e.event.type === 'proposed').at(-1);
  const proposedThis = latest?.event.type === 'proposed' && contract.parse !== null && latest.event.contractHash === contract.parse.hash;
  let stage: ItemStage;
  if (ledger.problems.length > 0) stage = 'broken';
  else if (contract.parse === null) stage = 'no-contract';
  else if (!contract.ok) stage = 'incomplete';
  else if (has('closed')) stage = 'closed';
  else if (approval?.ok === true && has('shipped')) stage = 'shipped';
  else if (approval?.ok === true) stage = 'approved';
  else if (approval?.proposal === null || !proposedThis) stage = 'unproposed';
  else if (approval?.turn !== null && approval?.turn !== undefined) stage = 'declined';
  else stage = 'awaiting-yes';
  const editable = contract.ok && approval?.ok === true;
  const lines = [
    `problem-statement  ${statement.ok ? 'pass' : 'REFUSE'}  ${statement.reason}`,
    `human-yes          ${approval?.ok === true ? 'pass' : 'REFUSE'}  ${approval?.reason ?? 'needs a complete contract first'}`,
    // A yes typed before replies recorded their contract text stops counting: say why, and what to do.
    ...(approval !== null && !approval.ok && (approval.retype?.length ?? 0) > 0 ? [`                   ${retypeLine(slug)}`] : []),
  ];
  return { slug, paths, contract, approval, ledger, stage, editable, lines };
}

/** Propose the contract as it is now; refuses an incomplete one (naming what is missing). */
export function proposeItem(root: string, slug: string, opts: { session: string; before: MetricReading | null; now?: () => Date }): LedgerEntry {
  const paths = itemPaths(root, slug);
  const v = contractVerdict(paths);
  if (!v.ok || v.parse === null) throw new Error(`refusing to propose: ${v.reason}`);
  const text = readFileSync(paths.contract, 'utf8');
  const stakeholder = (v.parse.fields.Stakeholder ?? '').trim();
  const entry = appendLedger(paths.ledger, { type: 'proposed', contractHash: v.parse.hash, stakeholder, before: opts.before, session: opts.session, text }, opts.now);
  if (opts.before !== null) {
    appendLedger(paths.ledger, { type: 'metric', phase: 'before', reading: opts.before }, opts.now);
    writeMetricValues(paths.contract, String(opts.before.value), null);
  }
  return entry;
}

/**
 * Record what the stakeholder typed. Only the harness's terminal reader calls this with 'tty'; a
 * piped stdin is recorded as 'pipe' and can never approve. With it the entry records the hash of the
 * contract text on disk at this moment (approvalVerdict counts the reply only for that text) and the
 * operator's provenance (provenance.ts: agent-shell markers, names only; computed here by default). On
 * a yes the harness writes the Signed line itself (the human-yes gate still reads the ledger, never
 * that line).
 */
export function recordReply(
  root: string,
  slug: string,
  text: string,
  channel: TurnChannel,
  session: string,
  now: () => Date = () => new Date(),
  provenance: OperatorProvenance = operatorProvenance(),
): { entry: LedgerEntry; verdict: ApprovalVerdict } {
  const paths = itemPaths(root, slug);
  const ledger = readLedger(paths.ledger);
  const atReply = contractVerdict(paths).parse?.hash ?? null;
  const entry = appendLedger(paths.ledger, { type: 'human_turn', text, channel, session, inReplyTo: openProposal(ledger), contractHash: atReply, agentEnv: provenance.agentEnv }, now);
  const v = contractVerdict(paths);
  const verdict = v.parse !== null && v.ok ? approvalVerdict(readLedger(paths.ledger), v.parse.hash) : approvalVerdict({ entries: [], problems: [] }, '');
  if (verdict.ok && verdict.turn?.seq === entry.seq && v.parse !== null) {
    appendLedger(paths.ledger, { type: 'approved', turn: entry.seq, contractHash: v.parse.hash, stakeholder: verdict.stakeholder ?? '' }, now);
    writeSigned(paths.contract, `${verdict.stakeholder ?? ''}, ${now().toISOString().slice(0, 10)} (recorded by the harness from the typed reply at ledger seq ${entry.seq}; the human-yes gate reads the ledger, not this line)`);
  } else if (classifyReply(text).kind === 'no' && v.parse !== null && verdict.proposal !== null) {
    appendLedger(paths.ledger, { type: 'declined', turn: entry.seq, contractHash: v.parse.hash, reason: text }, now);
  }
  return { entry, verdict };
}

/** Write (or replace) the harness-owned Signed line. */
export function writeSigned(contract: string, value: string): void {
  const text = readFileSync(contract, 'utf8');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => /^\s*(?:[-*+]\s+)?(?:\*\*|__)?signed(?:\*\*|__)?\s*:/i.test(l));
  const line = `Signed: ${value}`;
  if (i >= 0) lines[i] = line;
  else {
    while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
    lines.push(line, '');
  }
  writeFileSync(contract, lines.join('\n'));
}

/** Write the harness-read before/after values into the Metric line (null keeps what is there). */
export function writeMetricValues(contract: string, before: string | null, after: string | null): void {
  const text = readFileSync(contract, 'utf8');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => fieldStart(l)?.field === 'Metric');
  if (i < 0) throw new Error(`${contract} has no Metric line to record the reading in`);
  const line = lines[i] ?? '';
  const m = /^(.*?\bbefore:\s*)(.*?)(\s+after:\s*)(.*?)\s*$/i.exec(line);
  if (m === null) throw new Error(`${contract}: the Metric line has no before/after slots`);
  lines[i] = `${m[1] ?? ''}${before ?? m[2] ?? '____'}${m[3] ?? ' after: '}${after ?? m[4] ?? '____'}`;
  writeFileSync(contract, lines.join('\n'));
}
