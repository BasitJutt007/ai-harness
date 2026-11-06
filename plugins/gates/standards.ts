/**
 * standards: the registered checks prove the API, with a diff-aware policy.
 *
 * Greenfield:
 * - The 'standards'-category rules (the graded four) are strict over the WHOLE API:
 *   100% or refuse.
 * - Any other rule (a dropped-in ORM or lint rule) blocks only for violations in files this
 *   run changed (content differs from the run-start snapshot in state.initialHashes, or the
 *   file is new). Violations in unchanged files (scaffold files path-guard keeps read-only, so
 *   the agent could never fix them) are listed as "pre-existing (not blocking)" instead of
 *   making DONE impossible.
 *
 * Brownfield, strict (the DEFAULT): every governed API must satisfy the standards, so the
 * 'standards'-category rules are held to 100% over the WHOLE API, exactly as in greenfield.
 * - A failing standards violation in a file the task scope forbids editing that the base commit
 *   already had is reported as "incompatible target: N pre-existing violation(s) in files outside
 *   the task scope (list)" and fails: the run cannot reach 100% without editing them, and a
 *   silent pass would claim standards the API does not meet.
 * - Any other failing standards violation blocks (the agent can and must fix it).
 * - When the standards rules are at 100%, the other rules (ORM, lint, ...) follow the base-commit
 *   comparison below.
 *
 * Brownfield, baseline mode (explicit opt-in: `standards: baseline` in the task file), labelled
 * "baseline mode: below 100% allowed" in the summary and in "human must verify":
 * - A BASELINE report is measured once on the base commit (a git archive snapshot of the API,
 *   checked with the same rules; cached in run state, logged as standards-baseline.txt).
 * - Every rule, any category, blocks on what the run introduced: a violation the baseline does not
 *   have (matched by rule, file and message as a multiset, so lines shifted by an edit do not count
 *   and a second copy does), wherever it is located (a change in one file can break an untouched
 *   one); a rule with more failing units than at the baseline; a rule UNPROVEN now that the baseline
 *   proved (pass or fail).
 * - Violations the baseline already had are pre-existing (not blocking): listed in the details and
 *   under "human must verify". A rule unproven at the baseline too stays UNPROVEN.
 * - Without a baseline (snapshot or checks failed) violations in changed files block and any other
 *   violation cannot be proven pre-existing: UNPROVEN.
 * - The summary always carries the true whole-API percentage.
 *
 * Both: a skipped rule, an empty standards rule, or zero rules is UNPROVEN, and an n/a rule
 * (nothing to check) is never counted as green.
 *
 * Stack web (the generic profile of an in-place run): its standards are the repository's own type check and
 * lint. When neither was counted (every one n/a) the gate stays UNPROVEN, saying "this repository configures no
 * type check or lint the harness can run; a human must verify standards" (or that they had nothing to check in
 * this change), whatever else passed.
 */
import { isAbsolute, posix, relative, sep } from 'node:path';
import { z } from 'zod';
import { defineGate, webStandardsConfigured } from '../../src/core/plugin-api.ts';
import type { CheckFinding, CheckReport, GateResult, RuleSummary, RunContext } from '../../src/core/plugin-api.ts';
import { removeSnapshot, snapshotBase } from '../lib/contract.ts';
import { writePolicyFor } from '../lib/path-policy.ts';
import { sha256 } from '../lib/red.ts';

const STANDARDS = 'standards';
const MAX_DETAILS = 25;
const MAX_HUMAN = 20;
/** Gate-summary label of the explicit brownfield opt-in (task file `standards: baseline`). */
export const BASELINE_MODE = 'baseline mode: below 100% allowed';
/** RunState.scratch key of the brownfield baseline. */
export const BASELINE_KEY = 'standards:baseline';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "src/x.ts:12:5" → "src/x.ts"; a location without a line number is taken as a path. */
function locationFile(location: string): string {
  return location.replace(/:\d+(?::\d+)?$/, '');
}

/** API-relative path of a finding's file or a violation's location file; null for "(project)", "(runtime)" and the like. */
function apiPath(ctx: RunContext, p: string): string | null {
  if (p === '' || p.startsWith('(')) return null;
  try {
    return ctx.workspace.rel(p);
  } catch {
    return null;
  }
}

/** Changed in this run: new since the run-start snapshot, or different content. Unattributable → treated as changed. */
async function changedIn(ctx: RunContext, rel: string | null, cache: Map<string, boolean>): Promise<boolean> {
  if (rel === null) return true;
  const known = cache.get(rel);
  if (known !== undefined) return known;
  const initial = ctx.state.initialHashes.get(rel);
  const current = initial === undefined ? null : await ctx.workspace.read(rel);
  const changed = initial === undefined || current === null || sha256(current) !== initial;
  cache.set(rel, changed);
  return changed;
}

function failing(f: CheckFinding): boolean {
  return f.status === 'fail' || f.units.passed < f.units.total;
}

interface Classified {
  /** Violations (or whole failing findings) in files this run changed: they block. */
  blocking: string[];
  /** Violations in files this run did not change: reported, not blocking. */
  preExisting: string[];
}

/** Split the failing findings of non-standards rules into blocking and pre-existing ones (greenfield). */
async function classify(ctx: RunContext, report: CheckReport, rules: RuleSummary[]): Promise<Classified> {
  const out: Classified = { blocking: [], preExisting: [] };
  const cache = new Map<string, boolean>();
  for (const rule of rules) {
    const bad = report.findings.filter((f) => f.rule === rule.rule && failing(f));
    if (bad.length === 0) {
      out.blocking.push(`${rule.rule}: failing (${rule.passed}/${rule.total} ${rule.unit}) with no finding to attribute to a file`);
      continue;
    }
    for (const f of bad) {
      const file = apiPath(ctx, f.file);
      if (f.violations.length === 0) {
        (await changedIn(ctx, file, cache) ? out.blocking : out.preExisting).push(`${rule.rule} ${file ?? f.file} (${f.units.passed}/${f.units.total} ${rule.unit})`);
        continue;
      }
      for (const v of f.violations) {
        // The finding's own file decides; a project-level finding is attributed by each violation's location.
        const where = file ?? apiPath(ctx, locationFile(v.location));
        (await changedIn(ctx, where, cache) ? out.blocking : out.preExisting).push(`${rule.rule} ${v.location}  ${v.message}`);
      }
    }
  }
  return out;
}

// ───────────────────────────── brownfield baseline ─────────────────────────────

const FindingShape = z.object({
  rule: z.string(),
  file: z.string(),
  status: z.enum(['pass', 'fail', 'skip']),
  units: z.object({ passed: z.number(), total: z.number() }),
  violations: z.array(z.object({ location: z.string(), message: z.string() })),
});
const RuleShape = z.object({
  rule: z.string(),
  category: z.string(),
  unit: z.string(),
  status: z.enum(['pass', 'fail', 'unproven', 'n/a']),
  passed: z.number(),
  total: z.number(),
  files: z.number(),
});
/** What a gate run needs of the base commit's report (kept small: it is saved in state.json). */
const BaselineShape = z.object({
  sha: z.string(),
  /** Absolute root that was checked (a snapshot that no longer exists): stripped from paths and messages. */
  root: z.string(),
  percent: z.number(),
  rules: z.array(RuleShape),
  /** Failing findings only. */
  findings: z.array(FindingShape),
});
type Baseline = z.infer<typeof BaselineShape>;
type FindingLike = z.infer<typeof FindingShape>;

/** The base commit's report: cached in run state, else measured on a snapshot. A string = why there is none. */
async function loadBaseline(ctx: RunContext): Promise<Baseline | string> {
  const cached = BaselineShape.safeParse(ctx.state.scratch.get(BASELINE_KEY));
  if (cached.success && cached.data.sha === ctx.run.baseSha) return cached.data;
  let snap: string;
  try {
    snap = await snapshotBase({
      repoRoot: ctx.workspace.repoRoot, baseSha: ctx.run.baseSha, rootRel: ctx.workspace.rootRel, harnessRoot: ctx.run.harnessRoot, exec: ctx.exec,
    });
  } catch (e) {
    return `base snapshot failed: ${errMsg(e)}`;
  }
  try {
    const report = await ctx.services.runChecks({ root: snap });
    const baseline: Baseline = {
      sha: ctx.run.baseSha,
      root: report.root,
      percent: report.verdict.percent,
      rules: report.rules.map((r) => ({ ...r })),
      findings: report.findings.filter(failing).map((f) => ({ rule: f.rule, file: f.file, status: f.status, units: { ...f.units }, violations: f.violations.map((v) => ({ ...v })) })),
    };
    ctx.state.scratch.set(BASELINE_KEY, baseline);
    await ctx.logs.write('standards-baseline.txt', `standards at the base commit ${ctx.run.baseSha} (measured on a snapshot; the brownfield baseline)\n${report.text}`);
    return baseline;
  } catch (e) {
    return `checks could not run on the base commit: ${errMsg(e)}`;
  } finally {
    removeSnapshot(snap);
  }
}

/** Root-relative POSIX path of a reported file or location file; null when unattributable or outside `root`. */
function relTo(root: string, p: string): string | null {
  if (p === '' || p.startsWith('(')) return null;
  const rel = isAbsolute(p) ? relative(root, p).split(sep).join('/') : posix.normalize(p.split('\\').join('/'));
  return rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? null : rel;
}

interface Item {
  rule: string;
  /** Root-relative file the item is attributed to; null = unattributable. */
  file: string | null;
  /** Identity: rule, file and message (no line:col, so edits above it do not change it). */
  key: string;
  text: string;
}

/** One item per violation of a failing finding (or per failing finding without violations). */
function failingItems(findings: readonly FindingLike[], root: string): Item[] {
  const out: Item[] = [];
  const bad = findings.filter((f) => f.status === 'fail' || f.units.passed < f.units.total);
  for (const f of bad) {
    const file = relTo(root, f.file);
    if (f.violations.length === 0) {
      // A failing marker with no failing unit (tsc's project summary) only repeats the rule's other findings.
      if (f.units.passed === f.units.total && bad.some((g) => g !== f && g.rule === f.rule)) continue;
      const what = `failing (${f.units.passed}/${f.units.total})`;
      out.push({ rule: f.rule, file, key: [f.rule, file ?? f.file, what].join('\u0000'), text: `${f.rule} ${file ?? f.file} ${what}` });
      continue;
    }
    for (const v of f.violations) {
      const where = file ?? relTo(root, locationFile(v.location));
      const message = v.message.split(root).join('<root>');
      out.push({
        rule: f.rule,
        file: where,
        key: [f.rule, where ?? locationFile(v.location), message].join('\u0000'),
        text: `${f.rule} ${where !== null && isAbsolute(v.location) ? v.location.split(root).join('<root>') : v.location}  ${v.message}`,
      });
    }
  }
  return out;
}

function capped(lines: string[], max: number, more: string): string[] {
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more (${more})`] : lines;
}

/** One line (line breaks become spaces), cut to `max` characters with an ellipsis. */
function oneLine(text: string, max: number): string {
  const t = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** How much of the first blocking finding a summary carries (the rest is in the details and the log). */
const LEAD_FINDING_CHARS = 200;

/** A finding (or a rule result) the standards gate blocks on: something this run introduced. */
export interface BlockingFinding {
  rule: string;
  /** The gate's detail line, e.g. "introduced (in a file this run changed): <text>". */
  detail: string;
  /** The finding itself: "rule location  message", or the rule-level line. */
  text: string;
}

/** A failing finding the base commit already had: reported, never blocking. */
export interface PreExistingFinding {
  rule: string;
  /** Root-relative file it is attributed to; null when it is not attributable to a file. */
  file: string | null;
  where: 'untouched' | 'changed' | 'unattributed';
  text: string;
}

/** The lists the baseline-mode verdict is made of (one classification, shared by the gate and check_standards). */
export interface BaselineFindings {
  /** Why there is no base report to compare with (null: there is one). */
  unavailable: string | null;
  /** What the gate blocks on now (without a base report: the violations in files this run changed). */
  blocking: BlockingFinding[];
  /** Matched against the base commit's report: not blocking (empty without a base report). */
  preExisting: PreExistingFinding[];
  /** Rules UNPROVEN now that the base commit did not prove either (never green). */
  unproven: string[];
  /** The base commit's whole-API percentage (null without a base report). */
  basePercent: number | null;
}

/** What a run of the comparison gives its callers: the gate result, what blocks first (its lead), and the lists. */
interface Assessed {
  result: GateResult;
  /** What blocks, said first in the summary ("4 introduced by this run: <first finding>"); null when nothing blocks. */
  lead: string | null;
  /** Null when the verdict was decided before any comparison (every rule green, or contradicted). */
  findings: BaselineFindings | null;
}

/** Pre-existing findings per rule: how many, in how many files, how many in files this run changed or in none. */
export interface PreExistingCount {
  rule: string;
  count: number;
  files: number;
  inChanged: number;
  unattributed: number;
}

/** The pre-existing findings counted per rule (rules in order of first appearance). */
export function preExistingByRule(pre: readonly PreExistingFinding[]): PreExistingCount[] {
  const by = new Map<string, { count: number; files: Set<string>; inChanged: number; unattributed: number }>();
  for (const p of pre) {
    const r = by.get(p.rule) ?? { count: 0, files: new Set<string>(), inChanged: 0, unattributed: 0 };
    r.count += 1;
    if (p.file !== null) r.files.add(p.file);
    if (p.where === 'changed') r.inChanged += 1;
    if (p.where === 'unattributed') r.unattributed += 1;
    by.set(p.rule, r);
  }
  return [...by].map(([rule, r]) => ({ rule, count: r.count, files: r.files.size, inChanged: r.inChanged, unattributed: r.unattributed }));
}

/** "nest-route-guard 120 in 31 files" (and how many of them are in files this run changed, or in no file). */
export function preExistingCountText(c: PreExistingCount): string {
  const extra = [
    ...(c.inChanged > 0 ? [`${c.inChanged} in files this run changed`] : []),
    ...(c.unattributed > 0 ? [`${c.unattributed} not attributable to a file`] : []),
  ];
  return `${c.rule} ${c.count} in ${c.files} file${c.files === 1 ? '' : 's'}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
}

/** The start of a "human must verify" or detail line about a pre-existing finding (never blocking). */
export const PRE_EXISTING = 'pre-existing (not blocking';

/**
 * Prefix the baseline-mode label to a below-100% result and name it under "human must verify". What
 * blocks (the lead) comes before the label, so a reader who sees only the start of the summary sees it.
 */
function labelled(a: Assessed): GateResult {
  const r = a.result;
  if (r.status === 'pass' && r.summary.startsWith('verdict 100% (')) return r;
  const note = `${BASELINE_MODE} (the task opted in with standards: baseline; the standards rules are not proven at 100% over the whole API)`;
  return {
    ...r,
    summary: [...(a.lead !== null ? [a.lead] : []), BASELINE_MODE, r.summary].join('; '),
    humanMustVerify: [note, ...(r.humanMustVerify ?? [])],
    ...(r.humanMustVerifyBrief !== undefined ? { humanMustVerifyBrief: [note, ...r.humanMustVerifyBrief] } : {}),
  };
}

/** The result with what blocks said first (the non-standards rules of strict mode: no label). */
function withLead(a: Assessed): GateResult {
  return a.lead === null ? a.result : { ...a.result, summary: `${a.lead}; ${a.result.summary}` };
}

/**
 * Brownfield (baseline mode, and the non-standards rules in strict mode): block only on what this run
 * introduced versus the base commit's report. `log` false (check_standards) writes no log.
 */
async function brownfield(ctx: RunContext, report: CheckReport, counted: RuleSummary[], naNote: string, log = true): Promise<Assessed> {
  const decided = (result: GateResult): Assessed => ({ result, lead: null, findings: null });
  const percent = report.verdict.percent;
  const unprovenNow = new Map<string, string>();
  for (const r of counted) if (r.status === 'unproven') unprovenNow.set(r.rule, `${r.passed}/${r.total} ${r.unit}`);
  for (const f of report.findings) if (f.status === 'skip') unprovenNow.set(f.rule, `skipped: ${f.skipReason ?? 'no reason'}`);
  const failingRules = counted.filter((r) => r.status === 'fail');
  if (unprovenNow.size === 0 && failingRules.length === 0) {
    if (report.verdict.status !== 'pass') return decided({ status: 'unproven', summary: `verdict ${percent}% with no failing rule to explain it` });
    return decided({ status: 'pass', summary: `verdict 100% (${counted.length} rules${naNote})` });
  }
  if (report.verdict.status === 'pass') {
    const which = [...failingRules.map((r) => `${r.rule} fail`), ...[...unprovenNow].map(([rule, why]) => `${rule} ${why}`)];
    return decided({ status: 'unproven', summary: `verdict 100% contradicted by ${which.length} rule results`, details: which.slice(0, MAX_DETAILS) });
  }

  const now = failingItems(report.findings, report.root);
  const cache = new Map<string, boolean>();
  const baseline = await loadBaseline(ctx);
  if (typeof baseline === 'string') {
    const blocking: BlockingFinding[] = [];
    const unknown: string[] = [];
    for (const it of now) {
      if (await changedIn(ctx, it.file, cache)) blocking.push({ rule: it.rule, detail: `changed file: ${it.text}`, text: it.text });
      else unknown.push(it.text);
    }
    const unprovenRules = [...unprovenNow].map(([rule, why]) => `${rule} ${why}`);
    const findings: BaselineFindings = { unavailable: baseline, blocking, preExisting: [], unproven: unprovenRules, basePercent: null };
    const head = `verdict ${percent}% over the whole API; no baseline (${baseline})`;
    const first = blocking[0];
    if (first !== undefined) {
      return {
        result: { status: 'fail', summary: head, failing: blocking.length, details: capped([...blocking.map((b) => b.detail), ...unknown.map((u) => `unproven (no baseline): ${u}`)], MAX_DETAILS, 'see the standards report') },
        lead: `${blocking.length} violation(s) in files this run changed: ${oneLine(first.text, LEAD_FINDING_CHARS)}`,
        findings,
      };
    }
    return {
      result: {
        status: 'unproven',
        summary: `${head}: ${unknown.length} violation(s) in files this run did not change cannot be proven pre-existing${unprovenRules.length > 0 ? `; ${unprovenRules.length} rule(s) unproven` : ''}`,
        details: capped([...unprovenRules, ...unknown.map((u) => `unproven (no baseline): ${u}`)], MAX_DETAILS, 'see the standards report'),
      },
      lead: null,
      findings,
    };
  }

  // Multiset of the baseline's violations: each one excuses at most one current violation.
  const remaining = new Map<string, number>();
  for (const it of failingItems(baseline.findings, baseline.root)) remaining.set(it.key, (remaining.get(it.key) ?? 0) + 1);
  const blocking: BlockingFinding[] = [];
  const pre: PreExistingFinding[] = [];
  for (const it of now) {
    const changed = await changedIn(ctx, it.file, cache);
    const left = remaining.get(it.key) ?? 0;
    if (left > 0) {
      remaining.set(it.key, left - 1);
      pre.push({ rule: it.rule, file: it.file, text: it.text, where: it.file === null ? 'unattributed' : changed ? 'changed' : 'untouched' });
    } else {
      blocking.push({
        rule: it.rule,
        text: it.text,
        detail: changed
          ? `introduced (in a file this run changed): ${it.text}`
          : `introduced (in a file this run did not change: a change elsewhere caused it): ${it.text}`,
      });
    }
  }
  const baseRules = new Map(baseline.rules.map((r) => [r.rule, r]));
  const unproven: string[] = [];
  for (const r of counted) {
    const b = baseRules.get(r.rule);
    // "Pass count went down" net of removed units: more failing units than the base commit had.
    const failedBase = b === undefined ? 0 : b.total - b.passed;
    if (r.status === 'fail' && r.total - r.passed > failedBase) {
      const line = `${r.rule}: ${r.total - r.passed} failing ${r.unit} vs ${failedBase} at the base commit`;
      blocking.push({ rule: r.rule, detail: line, text: line });
    }
    const why = unprovenNow.get(r.rule);
    if (why === undefined) continue;
    if (b !== undefined && (b.status === 'pass' || b.status === 'fail')) {
      const line = `${r.rule}: UNPROVEN now (${why}) but proven at the base commit (${b.passed}/${b.total} ${b.unit})`;
      blocking.push({ rule: r.rule, detail: line, text: line });
    } else {
      unproven.push(`${r.rule}: ${why} (unproven at the base commit too: the checker cannot prove this API)`);
    }
  }
  const findings: BaselineFindings = { unavailable: null, blocking, preExisting: pre, unproven, basePercent: baseline.percent };

  const untouched = pre.filter((p) => p.where === 'untouched').length;
  const inChanged = pre.filter((p) => p.where === 'changed').length;
  const unattributed = pre.length - untouched - inChanged;
  const extra = [
    ...(inChanged > 0 ? [`${inChanged} in files this run changed`] : []),
    ...(unattributed > 0 ? [`${unattributed} not attributable to a file`] : []),
  ];
  const head = `verdict ${percent}% over the whole API (brownfield: ${untouched} pre-existing violation(s) in untouched files${extra.length > 0 ? `, ${extra.join(', ')}` : ''}; base commit ${baseline.percent}%)`;
  const preLines = pre.map((p) => `${PRE_EXISTING}${p.where === 'changed' ? '; in a file this run changed' : p.where === 'unattributed' ? '; not attributable to a file' : ''}): ${p.text}`);
  const logPath = log
    ? await ctx.logs.write('standards-brownfield.txt', [
      head,
      ...blocking.map((b) => `BLOCKING  ${b.detail}`),
      ...unproven.map((u) => `UNPROVEN  ${u}`),
      ...preLines,
    ].join('\n'))
    : undefined;
  const more = logPath !== undefined ? `see ${logPath}` : 'see the standards report';
  const human = capped(preLines, MAX_HUMAN, more);
  const brief = preExistingByRule(pre).map((c) => `${PRE_EXISTING}): ${preExistingCountText(c)}`);
  const verify = human.length > 0 ? { humanMustVerify: human, humanMustVerifyBrief: brief } : {};
  const logged = logPath !== undefined ? { logPath } : {};
  const first = blocking[0];
  if (first !== undefined) {
    return {
      result: { status: 'fail', summary: head, failing: blocking.length, details: capped([...blocking.map((b) => b.detail), ...preLines], MAX_DETAILS, more), ...logged, ...verify },
      lead: `${blocking.length} introduced by this run: ${oneLine(first.text, LEAD_FINDING_CHARS)}`,
      findings,
    };
  }
  if (unproven.length > 0) {
    return { result: { status: 'unproven', summary: `${head}: ${unproven.length} rule(s) unproven`, details: capped([...unproven, ...preLines], MAX_DETAILS, more), ...logged, ...verify }, lead: null, findings };
  }
  return {
    result: {
      status: 'pass',
      summary: `${head}; nothing introduced by this run (${counted.length} rules${naNote})`,
      details: capped(preLines, MAX_DETAILS, more),
      ...logged,
      ...verify,
    },
    lead: null,
    findings,
  };
}

/**
 * Brownfield strict (the default): the standards rules at 100% over the whole API. A failing standards
 * violation the base commit already had, in a file the task scope forbids editing, makes the target
 * incompatible with the task; any other one blocks. With the standards rules green, the other rules
 * follow the base-commit comparison.
 */
async function brownfieldStrict(ctx: RunContext, report: CheckReport, counted: RuleSummary[], naNote: string): Promise<GateResult> {
  const standardsRules = new Set(report.rules.filter((r) => r.category === STANDARDS).map((r) => r.rule));
  const failingStandards = counted.filter((r) => r.category === STANDARDS && r.status === 'fail');
  if (failingStandards.length === 0) return withLead(await brownfield(ctx, report, counted, naNote));

  const percent = report.verdict.percent;
  const now = failingItems(report.findings.filter((f) => standardsRules.has(f.rule)), report.root);
  const task = ctx.task;
  const outsideScope = (file: string | null): boolean => file !== null && task.kind === 'brownfield' && !writePolicyFor(ctx, file).allowed;
  const baseline = now.some((it) => outsideScope(it.file)) ? await loadBaseline(ctx) : 'not needed';
  const remaining = new Map<string, number>();
  if (typeof baseline !== 'string') {
    for (const it of failingItems(baseline.findings, baseline.root)) remaining.set(it.key, (remaining.get(it.key) ?? 0) + 1);
  }
  const cache = new Map<string, boolean>();
  const incompatible: Item[] = [];
  const blocking: string[] = [];
  for (const it of now) {
    if (!outsideScope(it.file)) {
      blocking.push(`must fix (in scope): ${it.text}`);
      continue;
    }
    const left = remaining.get(it.key) ?? 0;
    if (left > 0) {
      remaining.set(it.key, left - 1);
      incompatible.push(it);
    } else if (typeof baseline === 'string' && !(await changedIn(ctx, it.file, cache))) {
      // No base report to prove it pre-existing: an untouched file the run may not edit still cannot be fixed by the run.
      incompatible.push({ ...it, text: `${it.text} (not proven pre-existing: ${baseline})` });
    } else {
      blocking.push(`introduced (in a file outside the task scope: a change elsewhere caused it): ${it.text}`);
    }
  }
  if (now.length === 0) {
    for (const r of failingStandards) blocking.push(`${r.rule}: failing (${r.passed}/${r.total} ${r.unit}) with no finding to attribute to a file`);
  }
  const files = [...new Set(incompatible.map((it) => it.file ?? '?'))].sort();
  const head = `verdict ${percent}% over the whole API (brownfield, strict: the standards rules must be 100%)`;
  const incompatibleLine = `incompatible target: ${incompatible.length} pre-existing violation(s) in files outside the task scope (${files.join(', ')})`;
  const lines = [
    ...(incompatible.length > 0 ? [incompatibleLine, ...incompatible.map((it) => `outside scope (pre-existing): ${it.text}`)] : []),
    ...blocking,
  ];
  const logPath = await ctx.logs.write('standards-brownfield.txt', [head, ...lines].join('\n'));
  const failing = incompatible.length + blocking.length;
  if (incompatible.length > 0) {
    return {
      status: 'fail',
      summary: `${incompatibleLine}: the standards rules cannot reach 100% without editing them; ${head}${blocking.length > 0 ? `; ${blocking.length} more in scope` : ''}. Widen the task scope, fix the target first, or opt in with "standards: baseline"`,
      failing,
      details: capped(lines, MAX_DETAILS, `see ${logPath}`),
      logPath,
      humanMustVerify: capped([incompatibleLine, ...incompatible.map((it) => it.text)], MAX_HUMAN, `see ${logPath}`),
    };
  }
  return { status: 'fail', summary: `${head}: ${blocking.length} standards violation(s) to fix`, failing, details: capped(lines, MAX_DETAILS, `see ${logPath}`), logPath };
}

/** The standards of the generic web profile: the repository's own type check and lint (the rules it configures). */
const WEB_STANDARD_CATEGORIES = new Set(['typecheck', 'lint']);
/** The UNPROVEN summary of a web repository that configures no type check or lint (fail closed, never green). */
export const WEB_NO_STANDARDS = 'this repository configures no type check or lint the harness can run; a human must verify standards';
/** The UNPROVEN summary of a web repository whose type check and lint had nothing to check in this change. */
export const WEB_NOTHING_CHECKED = "the repository's type check and lint had nothing to check in this change (n/a); a human must verify standards";

/**
 * Stack web: a result means something only when the repository's own type check or lint was counted (not n/a).
 * Without one, the gate stays UNPROVEN and says why: the repository configures neither (no tsconfig.json, no
 * ESLint config: its profile lists that as unsupported, so the session banner says up front that "Work
 * completed" cannot be reached), or what it configures
 * had nothing to check in this change. A failure stays a failure.
 */
function webStandardsProven(ctx: RunContext, report: CheckReport, r: GateResult): GateResult {
  if (r.status === 'fail') return r;
  if (report.rules.some((x) => WEB_STANDARD_CATEGORIES.has(x.category) && x.status !== 'n/a')) return r;
  const summary = webStandardsConfigured(ctx.workspace.root) ? WEB_NOTHING_CHECKED : WEB_NO_STANDARDS;
  return { status: 'unproven', summary, details: [...(r.details ?? []), `standards: ${r.summary}`], humanMustVerify: [summary, ...(r.humanMustVerify ?? [])] };
}

export default defineGate({
  name: 'standards',
  description:
    'Greenfield: the standards rules pass at 100% over the whole API and other (ORM, lint) rules pass on every file this run changed. '
    + 'Brownfield (strict, default): the standards rules pass at 100% over the whole API too (pre-existing violations in files outside the task scope: incompatible target); other rules may not get worse than at the base commit. '
    + 'Brownfield with "standards: baseline": no rule may get worse than at the base commit (baseline mode: below 100% allowed). '
    + 'The generic web profile needs its type check or lint counted. A skipped or empty rule is unproven, never green.',
  phases: ['finish', 'ship'],
  async run(ctx): Promise<GateResult> {
    let report: CheckReport;
    try {
      report = await ctx.services.runChecks();
    } catch (e) {
      return { status: 'unproven', summary: `checks could not run: ${errMsg(e)}` };
    }
    const r = await verdictOf(ctx, report);
    return ctx.stack === 'web' ? webStandardsProven(ctx, report, r) : r;
  },
});

/** What every policy starts from: the report's compact lines, its counted (not n/a) rules, and the n/a note. */
function counting(report: CheckReport): { compact: string[]; counted: RuleSummary[]; naNote: string; zeroRules: () => GateResult; allNa: () => GateResult } {
  const compact = report.compact.split('\n').filter((l) => l.trim() !== '').slice(0, MAX_DETAILS);
  const counted = report.rules.filter((r) => r.status !== 'n/a');
  const na = report.rules.length - counted.length;
  return {
    compact,
    counted,
    naNote: na > 0 ? `, ${na} n/a` : '',
    zeroRules: () => ({ status: 'unproven', summary: 'verdict 100% over zero rules: no checks ran, nothing is proven', details: compact }),
    allNa: () => ({ status: 'unproven', summary: `every rule was n/a (${na}): nothing is proven`, details: compact }),
  };
}

/** Baseline mode's verdict over the report (labelled), and the lists it is made of (null when decided without them). */
async function assessBaseline(ctx: RunContext, report: CheckReport, log: boolean): Promise<{ result: GateResult; findings: BaselineFindings | null }> {
  const c = counting(report);
  if (report.rules.length === 0) return { result: c.zeroRules(), findings: null };
  if (c.counted.length === 0) return { result: c.allNa(), findings: null };
  const a = await brownfield(ctx, report, c.counted, c.naNote, log);
  return { result: labelled(a), findings: a.findings };
}

/**
 * What the standards gate decides over `report` in baseline mode, and the lists that decision is made
 * of: the check_standards tool reports exactly this (one classification, never a copy of it). It writes
 * no log. Null when the task is not a brownfield task in baseline mode (`standards: baseline`).
 */
export async function baselineAssessment(ctx: RunContext, report: CheckReport): Promise<{ result: GateResult; findings: BaselineFindings | null } | null> {
  if (ctx.task.kind !== 'brownfield' || ctx.task.standards !== 'baseline') return null;
  const a = await assessBaseline(ctx, report, false);
  return { result: ctx.stack === 'web' ? webStandardsProven(ctx, report, a.result) : a.result, findings: a.findings };
}

/** The gate's verdict over the checks' report (see the module comment). */
async function verdictOf(ctx: RunContext, report: CheckReport): Promise<GateResult> {
  if (ctx.task.kind === 'brownfield' && ctx.task.standards === 'baseline') return (await assessBaseline(ctx, report, true)).result;
  const { compact, counted, naNote, zeroRules, allNa } = counting(report);
  const { status, percent } = report.verdict;
  if (report.rules.length === 0) return zeroRules();
  if (ctx.task.kind === 'brownfield') {
    if (counted.length === 0) return allNa();
    return brownfieldStrict(ctx, report, counted, naNote);
  }

  if (status === 'unproven') return { status: 'unproven', summary: 'verdict UNPROVEN (a rule was skipped or had nothing to check)', details: compact };
  const skipped = report.findings.filter((f) => f.status === 'skip');
  const unproven = counted.filter((r) => r.status === 'unproven');
  if (counted.length === 0) return allNa();
  if (skipped.length > 0 || unproven.length > 0) {
    const which = [...unproven.map((r) => `${r.rule} ${r.status}`), ...skipped.map((f) => `${f.rule} skipped: ${f.skipReason ?? 'no reason'}`)];
    return { status: 'unproven', summary: `verdict ${status === 'pass' ? '100%' : `${percent}%`} contradicted by ${which.length} rule results`, details: which.slice(0, MAX_DETAILS) };
  }

  const standardsFailing = counted.filter((r) => r.category === STANDARDS && r.status === 'fail');
  if (standardsFailing.length > 0) {
    return { status: 'fail', summary: `verdict ${percent}%`, failing: standardsFailing.reduce((n, r) => n + Math.max(1, r.total - r.passed), 0), details: compact };
  }

  const otherFailing = counted.filter((r) => r.category !== STANDARDS && r.status === 'fail');
  if (status === 'pass' && otherFailing.length > 0) {
    return { status: 'unproven', summary: `verdict 100% contradicted by ${otherFailing.length} failing rules`, details: otherFailing.map((r) => `${r.rule} fail`) };
  }
  if (otherFailing.length === 0) {
    if (status !== 'pass') return { status: 'unproven', summary: `verdict ${percent}% with no failing rule to explain it`, details: compact };
    return { status: 'pass', summary: `verdict 100% (${counted.length} rules${naNote})` };
  }

  // Only non-standards rules fail: diff-aware.
  const { blocking, preExisting } = await classify(ctx, report, otherFailing);
  const notes = preExisting.map((p) => `pre-existing (not blocking): ${p}`);
  const pre = preExisting.length > 0 ? `; ${preExisting.length} pre-existing violation(s) in files this run did not change (not blocking)` : '';
  if (blocking.length > 0) {
    return {
      status: 'fail',
      summary: `verdict ${percent}%: ${blocking.length} violation(s) in files this run changed${pre}`,
      failing: blocking.length,
      details: [...blocking.map((b) => `changed file: ${b}`), ...notes].slice(0, MAX_DETAILS),
    };
  }
  return {
    status: 'pass',
    summary: `standards rules 100%; every other rule passes on the files this run changed (${counted.length} rules${naNote})${pre}`,
    details: notes.slice(0, MAX_DETAILS),
    ...(notes.length > 0 ? { humanMustVerify: capped(notes, MAX_HUMAN, 'see the standards report') } : {}),
  };
}
