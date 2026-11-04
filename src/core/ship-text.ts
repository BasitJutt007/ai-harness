/**
 * Commit and PR text from the approved contract, never from the agent (habit 5 in docs/workflow.md:
 * commits and PRs that say nothing: 22 content-free subjects such as `patch` and `fix: comment fixes`,
 * 58 numbered checkpoints, a commitlint hook commented out since my first commit, and 95.8% of my
 * backend PR bodies empty or the untouched template).
 *
 *   commitHeaderProblems  the contract's `Commit:` line is a Conventional Commits header with a known
 *                         type, at most 100 characters, whose subject names what changes: never a
 *                         filler subject ("patch", "comment fixes") or a numbered checkpoint.
 *   commitMessage         that header, then the contract's Problem, scenarios, Not included and metric.
 *   trailerProblems       no Co-Authored-By, "Generated with" or other AI attribution in the message.
 *   repoCommitlint        the repository's OWN commitlint config, run confined (it is code). A config
 *                         that accepts "patch" checks nothing, and the result says so: the built-in rules
 *                         above are what decided.
 *   fillPrTemplate        the repository's PR template, filled: the description and ticket placeholders
 *                         are replaced from the contract, a checkbox is ticked only when a gate proved it
 *                         at ship, and any template text left untouched refuses the PR.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractParse } from './items.ts';
import type { Exec } from './types.ts';

// ───────────────────────────── commit header ─────────────────────────────

export const COMMIT_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'] as const;
export const MAX_HEADER = 100;
const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s]+)\))?(?<bang>!)?: (?<subject>\S.*)$/;

export interface CommitHeader {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
}

export function parseHeader(header: string): CommitHeader | null {
  const m = HEADER_RE.exec(header.trim());
  if (m?.groups === undefined) return null;
  return { type: m.groups['type'] ?? '', scope: m.groups['scope'] ?? null, breaking: m.groups['bang'] === '!', subject: (m.groups['subject'] ?? '').trim() };
}

/** Words that carry no content on their own: a subject made only of these says nothing. */
const FILLER = new Set([
  'patch', 'patches', 'fix', 'fixes', 'fixed', 'fixing', 'update', 'updates', 'updated', 'updating', 'change', 'changes', 'changed',
  'wip', 'minor', 'misc', 'temp', 'tmp', 'stuff', 'things', 'cleanup', 'clean', 'tweak', 'tweaks', 'improve', 'improvement',
  'improvements', 'checkpoint', 'save', 'work', 'progress', 'done', 'final', 'test', 'tests', 'testing', 'comment', 'comments',
  'review', 'feedback', 'again', 'more', 'some', 'small', 'code', 'bug', 'bugs', 'issue', 'issues', 'various', 'few', 'round',
  'part', 'step', 'add', 'added', 'adds', 'remove', 'removed', 'new', 'latest', 'all', 'other', 'refactor', 'refactoring',
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'it', 'this', 'that', 'as', 'per', 'my',
]);

const normWord = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Why a contract's `Commit:` header may not be shipped (empty = fine). Case rules (scope-case,
 * subject-case) are the repository's own and come from its commitlint config, not from here.
 */
export function commitHeaderProblems(header: string): string[] {
  const h = header.trim();
  if (h.includes('\n')) return ['the Commit header must be one line'];
  const out: string[] = [];
  if (h.length > MAX_HEADER) out.push(`the Commit header is ${h.length} characters (at most ${MAX_HEADER})`);
  const p = parseHeader(h);
  if (p === null) return [...out, `Commit must be a Conventional Commits header "<type>(<scope>): <subject>" (got "${h}")`];
  if (!(COMMIT_TYPES as readonly string[]).includes(p.type)) out.push(`Commit type "${p.type}" is not one of ${COMMIT_TYPES.join(', ')}`);
  if (p.subject.endsWith('.')) out.push('the Commit subject must not end with a full stop');
  const words = p.subject.split(/\s+/).filter((w) => w.length > 0);
  const last = normWord(words.at(-1) ?? '');
  const content = words.map(normWord).filter((w) => w !== '' && !FILLER.has(w) && !/^\d+$/.test(w));
  if (/^\d+$/.test(last) && words.slice(0, -1).every((w) => FILLER.has(normWord(w)) || normWord(w) === '')) {
    out.push(`the Commit subject is a numbered checkpoint ("${p.subject}"): name what changes`);
  } else if (words.length < 3 || content.length < 2) {
    out.push(`the Commit subject says nothing ("${p.subject}"): name what changes, and where, in at least three words`);
  }
  return out;
}

// ───────────────────────────── commit message ─────────────────────────────

/** The "...-by:" trailers a person signs; any other (Assisted-by, Generated-by, ...) is attribution. */
const PERSON_TRAILERS = new Set(['signed-off-by', 'reviewed-by', 'acked-by', 'tested-by', 'reported-by', 'suggested-by', 'helped-by']);

/** AI attribution and co-author trailers: the harness commits, a person merges, nobody co-authors. */
export function trailerProblems(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split('\n')) {
    const l = line.trim();
    const by = /^([A-Za-z-]+-by)\s*:/i.exec(l)?.[1]?.toLowerCase();
    if (by === 'co-authored-by') out.push(`"${l}": no co-author trailer`);
    else if (/\bgenerated (with|by)\b/i.test(l) || l.includes('🤖')) out.push(`"${l}": no "generated with" attribution`);
    else if (by !== undefined && !PERSON_TRAILERS.has(by)) out.push(`"${l}": not a trailer a person signs (no attribution trailers)`);
  }
  return out;
}

/** Word-wrap one paragraph to `width`, continuation lines indented by `indent`. */
export function wrap(text: string, width = 72, indent = ''): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const next = line === '' ? word : `${line} ${word}`;
    if (next.length > width && line !== '') {
      out.push(line);
      line = `${indent}${word}`;
    } else line = next;
  }
  if (line !== '') out.push(line);
  return out;
}

export interface CommitInput {
  contract: ContractParse;
  slug: string;
  runId: string;
  /** The metric's before value the harness read when it proposed the contract. */
  before: string | null;
}

/** The commit message: the approved header, then the contract in plain text (lines of at most 72). */
export function commitMessage(input: CommitInput): string {
  const c = input.contract;
  const header = (c.fields.Commit ?? '').trim();
  const lines = [header, '', ...wrap((c.fields.Problem ?? '').replace(/\s+/g, ' '))];
  if (c.scenarios.length > 0) {
    lines.push('', 'Scenarios:');
    for (const s of c.scenarios) lines.push(...wrap(`- WHEN ${s.when} THEN ${s.then}`, 72, '  '));
  }
  if (c.notIncluded.length > 0) {
    lines.push('', 'Not included:');
    for (const n of c.notIncluded) lines.push(...wrap(`- ${n}`, 72, '  '));
  }
  const m = c.metric;
  lines.push('');
  if (m !== null) lines.push(...wrap(`Metric: ${m.name}, ${m.window}: before ${input.before ?? 'not read'}; the harness reads it again on the merge commit.`));
  lines.push(`Item: ${input.slug}`, `Harness run: ${input.runId}`);
  return `${lines.join('\n')}\n`;
}

// ───────────────────────────── repository commitlint ─────────────────────────────

export const COMMITLINT_CONFIGS = [
  'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', 'commitlint.config.cts', 'commitlint.config.mts',
  '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yaml', '.commitlintrc.yml', '.commitlintrc.js', '.commitlintrc.cjs', '.commitlintrc.mjs', '.commitlintrc.ts', '.commitlintrc.cts',
];

export interface CommitlintVerdict {
  /** none: the repository has no commitlint config (the built-in rules decide). unproven: it could not be run. */
  status: 'pass' | 'fail' | 'none' | 'unproven';
  summary: string;
  details: string[];
}

function packageCommitlint(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    return typeof pkg['commitlint'] === 'object' && pkg['commitlint'] !== null;
  } catch {
    return false;
  }
}

/**
 * The repository's own commitlint on `message`, confined (its config is code that runs on load): no
 * network, writes only to a temp dir. A pass is also probed with "patch": a config that accepts it
 * checks nothing, and the summary says so.
 */
export async function repoCommitlint(exec: Exec, root: string, message: string): Promise<CommitlintVerdict> {
  const config = COMMITLINT_CONFIGS.find((c) => existsSync(join(root, c))) ?? (packageCommitlint(root) ? 'package.json "commitlint"' : undefined);
  if (config === undefined) return { status: 'none', summary: 'the repository has no commitlint config: the built-in commit rules decided', details: [] };
  const cli = join(root, 'node_modules', '@commitlint', 'cli', 'cli.js');
  if (!existsSync(cli)) return { status: 'unproven', summary: `${config} exists but the repository's commitlint is not installed (node_modules/@commitlint/cli): its rules were not run`, details: [] };
  const lint = async (msg: string): Promise<{ code: number | null; out: string; timedOut: boolean }> => {
    const tmp = mkdtempSync(join(tmpdir(), 'commitlint-'));
    try {
      const r = await exec(process.execPath, [cli], { cwd: root, input: msg, timeoutMs: 120_000, env: { TMPDIR: tmp, HOME: tmp }, sandbox: { writable: [tmp], network: 'none' } });
      return { code: r.code, out: `${r.stdout}\n${r.stderr}`, timedOut: r.timedOut };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  const r = await lint(message);
  const problems = r.out.split('\n').map((l) => l.trim()).filter((l) => /^[✖⚠]/.test(l) && /\[[a-z-]+\]$/.test(l));
  if (r.timedOut) return { status: 'unproven', summary: `the repository's commitlint (${config}) timed out`, details: [] };
  if (r.code === 0) {
    const probe = await lint('patch\n');
    if (probe.code === 0) return { status: 'pass', summary: `the repository's commitlint (${config}) accepts even "patch": it checks nothing, so the built-in commit rules decided`, details: [] };
    return { status: 'pass', summary: `the repository's commitlint (${config}) accepts the message`, details: [] };
  }
  if (problems.length > 0) return { status: 'fail', summary: `the repository's commitlint (${config}) rejects the message`, details: problems };
  return { status: 'unproven', summary: `the repository's commitlint (${config}) exited ${String(r.code)} without a rule report: ${r.out.trim().split('\n').slice(0, 2).join(' | ')}`, details: [] };
}

// ───────────────────────────── PR template ─────────────────────────────

const TEMPLATE_PATHS = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'];

/** The repository's PR template (the first of GitHub's locations that exists), or null. */
export function findPrTemplate(root: string): { path: string; text: string } | null {
  for (const p of TEMPLATE_PATHS) {
    const abs = join(root, p);
    if (existsSync(abs)) return { path: p, text: readFileSync(abs, 'utf8') };
  }
  const dir = join(root, '.github', 'PULL_REQUEST_TEMPLATE');
  if (existsSync(dir)) {
    const first = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort()[0];
    if (first !== undefined) return { path: `.github/PULL_REQUEST_TEMPLATE/${first}`, text: readFileSync(join(dir, first), 'utf8') };
  }
  return null;
}

export interface PrFill {
  /** Markdown that replaces the description placeholder. */
  description: string;
  /** One line that replaces the ticket placeholder. */
  ticket: string;
  header: CommitHeader;
  /** Ship-phase gate statuses by gate name. */
  gates: ReadonlyMap<string, string>;
}

export interface PrFilled {
  body: string;
  ticked: string[];
  /** Checklist items left for the reviewer (the harness does not check them). */
  forReviewer: string[];
  /** Template text that would ship untouched: any one refuses the PR. */
  untouched: string[];
}

type Decision = { tick: boolean; why: string };
const CHECKS: Array<{ re: RegExp; decide: (f: PrFill) => Decision | null }> = [
  { re: /\bbug ?fix\b/i, decide: (f) => ({ tick: f.header.type === 'fix', why: 'commit type fix' }) },
  { re: /\bnew feature\b/i, decide: (f) => ({ tick: f.header.type === 'feat', why: 'commit type feat' }) },
  { re: /\bbreaking change\b/i, decide: (f) => ({ tick: f.header.breaking, why: 'the approved header marks a breaking change' }) },
  { re: /style guide/i, decide: (f) => (f.gates.get('standards') === 'pass' ? { tick: true, why: 'standards gate: pass at ship' } : null) },
  { re: /no new warnings/i, decide: (f) => (f.gates.get('standards') === 'pass' ? { tick: true, why: 'standards gate: no new finding against the base' } : null) },
  { re: /added tests that prove/i, decide: (f) => (f.gates.get('observed-red') === 'pass' ? { tick: true, why: 'observed-red: each changed file went red to green with its test' } : null) },
  { re: /tests pass/i, decide: (f) => (f.gates.get('tests-green') === 'pass' ? { tick: true, why: 'tests-green: the suite ran green, fresh, at ship' } : null) },
];

const CHECKBOX_RE = /^(\s*[-*]\s+)\[[ xX]\](\s+)(.*)$/;

/**
 * Fill the repository's template. Sections are read by their headings: a description section's
 * placeholder text becomes the contract's description, a ticket section's becomes the ticket line;
 * "type of change" options are ticked from the approved header; other checkboxes are ticked only when
 * a ship gate proved them, and otherwise say they are left for the reviewer. Any other template text
 * is reported untouched (the caller refuses the PR).
 */
export function fillPrTemplate(template: string, fill: PrFill): PrFilled {
  const lines = template.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out: string[] = [];
  const ticked: string[] = [];
  const forReviewer: string[] = [];
  const untouched: string[] = [];
  let section: 'description' | 'ticket' | 'type' | 'other' | 'top' = 'top';
  let filled = { description: false, ticket: false };
  for (const line of lines) {
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      const h = (heading[1] ?? '').toLowerCase();
      section = /descri|summary|overview|what does|motivation|context/.test(h) ? 'description' : /ticket|issue|jira/.test(h) ? 'ticket' : /type of change/.test(h) ? 'type' : 'other';
      out.push(line);
      continue;
    }
    const box = CHECKBOX_RE.exec(line);
    if (box !== null) {
      const text = (box[3] ?? '').trim();
      const rule = CHECKS.find((c) => c.re.test(text));
      const d = rule?.decide(fill) ?? null;
      if (section === 'type') {
        const tick = d?.tick === true;
        out.push(`${box[1] ?? '- '}[${tick ? 'x' : ' '}]${box[2] ?? ' '}${text}`);
        if (tick) ticked.push(text);
      } else if (d?.tick === true) {
        out.push(`${box[1] ?? '- '}[x]${box[2] ?? ' '}${text} (${d.why})`);
        ticked.push(text);
      } else {
        out.push(`${box[1] ?? '- '}[ ]${box[2] ?? ' '}${text} (left for the reviewer: not checked by the harness)`);
        forReviewer.push(text);
      }
      continue;
    }
    if (line.trim().length === 0) {
      out.push(line);
      continue;
    }
    if (section === 'description') {
      if (!filled.description) out.push(fill.description);
      filled = { ...filled, description: true };
      continue;
    }
    if (section === 'ticket') {
      if (!filled.ticket) out.push(fill.ticket);
      filled = { ...filled, ticket: true };
      continue;
    }
    untouched.push(line.trim());
    out.push(line);
  }
  let body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!filled.description) body = `# Description\n\n${fill.description}\n\n${body}`;
  return { body, ticked, forReviewer, untouched };
}

/** No template in the repository: the same sections, in the harness's own layout. */
export function defaultPrBody(fill: PrFill): string {
  return `# Description\n\n${fill.description}\n\n# Ticket\n\n${fill.ticket}`;
}

/** The PR description the contract gives: Problem, the approved scenarios, Not included, and the metric. */
export function prDescription(c: ContractParse, before: string | null, slug: string): string {
  const parts = [(c.fields.Problem ?? '').replace(/\s+/g, ' ').trim()];
  if (c.scenarios.length > 0) parts.push(`**Scenarios** (approved by ${(c.fields.Stakeholder ?? 'the stakeholder').trim()}):\n${c.scenarios.map((s) => `- WHEN ${s.when} THEN ${s.then}`).join('\n')}`);
  if (c.notIncluded.length > 0) parts.push(`**Not included:**\n${c.notIncluded.map((n) => `- ${n}`).join('\n')}`);
  const m = c.metric;
  if (m !== null) parts.push(`**Metric:** ${m.name} (${m.window}): before **${before ?? 'not read'}**. The item closes only after the harness reads it again on the merge commit (\`harness item close ${slug}\`).`);
  return parts.join('\n\n');
}

export function ticketLine(c: ContractParse, slug: string): string {
  const t = c.fields.Ticket?.trim();
  return t !== undefined && t.length > 0 ? t : `No ticket: backlog item \`${slug}\`; the approved contract in this description is the ticket.`;
}
