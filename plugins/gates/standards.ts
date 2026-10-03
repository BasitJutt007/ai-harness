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
 * Brownfield (the API existed before the run: files the task scope denies are read-only, and a
 * checker may misread an unfamiliar style, so whole-API 100% could make DONE impossible):
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
 */
import { isAbsolute, posix, relative, sep } from 'node:path';
import { z } from 'zod';
import { defineGate } from '../../src/core/plugin-api.ts';
import type { CheckFinding, CheckReport, GateResult, RuleSummary, RunContext } from '../../src/core/plugin-api.ts';
import { removeSnapshot, snapshotBase } from '../lib/contract.ts';
import { sha256 } from '../lib/red.ts';

const STANDARDS = 'standards';
const MAX_DETAILS = 25;
const MAX_HUMAN = 20;
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

/** Brownfield: block only on what this run introduced versus the base commit's report (see the file comment). */
async function brownfield(ctx: RunContext, report: CheckReport, counted: RuleSummary[], naNote: string): Promise<GateResult> {
  const percent = report.verdict.percent;
  const unprovenNow = new Map<string, string>();
  for (const r of counted) if (r.status === 'unproven') unprovenNow.set(r.rule, `${r.passed}/${r.total} ${r.unit}`);
  for (const f of report.findings) if (f.status === 'skip') unprovenNow.set(f.rule, `skipped: ${f.skipReason ?? 'no reason'}`);
  const failingRules = counted.filter((r) => r.status === 'fail');
  if (unprovenNow.size === 0 && failingRules.length === 0) {
    if (report.verdict.status !== 'pass') return { status: 'unproven', summary: `verdict ${percent}% with no failing rule to explain it` };
    return { status: 'pass', summary: `verdict 100% (${counted.length} rules${naNote})` };
  }
  if (report.verdict.status === 'pass') {
    const which = [...failingRules.map((r) => `${r.rule} fail`), ...[...unprovenNow].map(([rule, why]) => `${rule} ${why}`)];
    return { status: 'unproven', summary: `verdict 100% contradicted by ${which.length} rule results`, details: which.slice(0, MAX_DETAILS) };
  }

  const now = failingItems(report.findings, report.root);
  const cache = new Map<string, boolean>();
  const baseline = await loadBaseline(ctx);
  if (typeof baseline === 'string') {
    const blocking: string[] = [];
    const unknown: string[] = [];
    for (const it of now) (await changedIn(ctx, it.file, cache) ? blocking : unknown).push(it.text);
    const unprovenRules = [...unprovenNow].map(([rule, why]) => `${rule} ${why}`);
    const head = `verdict ${percent}% over the whole API; no baseline (${baseline})`;
    if (blocking.length > 0) {
      return { status: 'fail', summary: `${head}: ${blocking.length} violation(s) in files this run changed`, details: capped([...blocking.map((b) => `changed file: ${b}`), ...unknown.map((u) => `unproven (no baseline): ${u}`)], MAX_DETAILS, 'see the standards report') };
    }
    return {
      status: 'unproven',
      summary: `${head}: ${unknown.length} violation(s) in files this run did not change cannot be proven pre-existing${unprovenRules.length > 0 ? `; ${unprovenRules.length} rule(s) unproven` : ''}`,
      details: capped([...unprovenRules, ...unknown.map((u) => `unproven (no baseline): ${u}`)], MAX_DETAILS, 'see the standards report'),
    };
  }

  // Multiset of the baseline's violations: each one excuses at most one current violation.
  const remaining = new Map<string, number>();
  for (const it of failingItems(baseline.findings, baseline.root)) remaining.set(it.key, (remaining.get(it.key) ?? 0) + 1);
  const blocking: string[] = [];
  const pre: Array<{ text: string; where: 'untouched' | 'changed' | 'unattributed' }> = [];
  for (const it of now) {
    const changed = await changedIn(ctx, it.file, cache);
    const left = remaining.get(it.key) ?? 0;
    if (left > 0) {
      remaining.set(it.key, left - 1);
      pre.push({ text: it.text, where: it.file === null ? 'unattributed' : changed ? 'changed' : 'untouched' });
    } else {
      blocking.push(changed
        ? `introduced (in a file this run changed): ${it.text}`
        : `introduced (in a file this run did not change: a change elsewhere caused it): ${it.text}`);
    }
  }
  const baseRules = new Map(baseline.rules.map((r) => [r.rule, r]));
  const unproven: string[] = [];
  for (const r of counted) {
    const b = baseRules.get(r.rule);
    // "Pass count went down" net of removed units: more failing units than the base commit had.
    const failedBase = b === undefined ? 0 : b.total - b.passed;
    if (r.status === 'fail' && r.total - r.passed > failedBase) {
      blocking.push(`${r.rule}: ${r.total - r.passed} failing ${r.unit} vs ${failedBase} at the base commit`);
    }
    const why = unprovenNow.get(r.rule);
    if (why === undefined) continue;
    if (b !== undefined && (b.status === 'pass' || b.status === 'fail')) {
      blocking.push(`${r.rule}: UNPROVEN now (${why}) but proven at the base commit (${b.passed}/${b.total} ${b.unit})`);
    } else {
      unproven.push(`${r.rule}: ${why} (unproven at the base commit too: the checker cannot prove this API)`);
    }
  }

  const untouched = pre.filter((p) => p.where === 'untouched').length;
  const inChanged = pre.filter((p) => p.where === 'changed').length;
  const unattributed = pre.length - untouched - inChanged;
  const extra = [
    ...(inChanged > 0 ? [`${inChanged} in files this run changed`] : []),
    ...(unattributed > 0 ? [`${unattributed} not attributable to a file`] : []),
  ];
  const head = `verdict ${percent}% over the whole API (brownfield: ${untouched} pre-existing violation(s) in untouched files${extra.length > 0 ? `, ${extra.join(', ')}` : ''}; base commit ${baseline.percent}%)`;
  const preLines = pre.map((p) => `pre-existing (not blocking${p.where === 'changed' ? '; in a file this run changed' : p.where === 'unattributed' ? '; not attributable to a file' : ''}): ${p.text}`);
  const logPath = await ctx.logs.write('standards-brownfield.txt', [
    head,
    ...blocking.map((b) => `BLOCKING  ${b}`),
    ...unproven.map((u) => `UNPROVEN  ${u}`),
    ...preLines,
  ].join('\n'));
  const human = capped(preLines, MAX_HUMAN, `see ${logPath}`);
  const verify = human.length > 0 ? { humanMustVerify: human } : {};
  if (blocking.length > 0) {
    return { status: 'fail', summary: `${head}: ${blocking.length} introduced by this run`, details: capped([...blocking, ...preLines], MAX_DETAILS, `see ${logPath}`), logPath, ...verify };
  }
  if (unproven.length > 0) {
    return { status: 'unproven', summary: `${head}: ${unproven.length} rule(s) unproven`, details: capped([...unproven, ...preLines], MAX_DETAILS, `see ${logPath}`), logPath, ...verify };
  }
  return {
    status: 'pass',
    summary: `${head}; nothing introduced by this run (${counted.length} rules${naNote})`,
    details: capped(preLines, MAX_DETAILS, `see ${logPath}`),
    logPath,
    ...verify,
  };
}

export default defineGate({
  name: 'standards',
  description:
    'Greenfield: the standards rules pass at 100% over the whole API and other (ORM, lint) rules pass on every file this run changed. '
    + 'Brownfield: no rule may get worse than at the base commit (pre-existing violations are reported, not blocking). '
    + 'A skipped or empty rule is unproven, never green.',
  phases: ['finish', 'ship'],
  async run(ctx): Promise<GateResult> {
    let report: CheckReport;
    try {
      report = await ctx.services.runChecks();
    } catch (e) {
      return { status: 'unproven', summary: `checks could not run: ${errMsg(e)}` };
    }
    const compact = report.compact.split('\n').filter((l) => l.trim() !== '').slice(0, MAX_DETAILS);
    const { status, percent } = report.verdict;
    if (report.rules.length === 0) return { status: 'unproven', summary: 'verdict 100% over zero rules: no checks ran, nothing is proven', details: compact };

    const counted = report.rules.filter((r) => r.status !== 'n/a');
    const na = report.rules.length - counted.length;
    const naNote = na > 0 ? `, ${na} n/a` : '';
    const allNa = (): GateResult => ({ status: 'unproven', summary: `every rule was n/a (${na}): nothing is proven`, details: compact });
    if (ctx.task.kind === 'brownfield') return counted.length === 0 ? allNa() : brownfield(ctx, report, counted, naNote);

    if (status === 'unproven') return { status: 'unproven', summary: 'verdict UNPROVEN (a rule was skipped or had nothing to check)', details: compact };
    const skipped = report.findings.filter((f) => f.status === 'skip');
    const unproven = counted.filter((r) => r.status === 'unproven');
    if (counted.length === 0) return allNa();
    if (skipped.length > 0 || unproven.length > 0) {
      const which = [...unproven.map((r) => `${r.rule} ${r.status}`), ...skipped.map((f) => `${f.rule} skipped: ${f.skipReason ?? 'no reason'}`)];
      return { status: 'unproven', summary: `verdict ${status === 'pass' ? '100%' : `${percent}%`} contradicted by ${which.length} rule results`, details: which.slice(0, MAX_DETAILS) };
    }

    const standardsFailing = counted.filter((r) => r.category === STANDARDS && r.status === 'fail');
    if (standardsFailing.length > 0) return { status: 'fail', summary: `verdict ${percent}%`, details: compact };

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
        details: [...blocking.map((b) => `changed file: ${b}`), ...notes].slice(0, MAX_DETAILS),
      };
    }
    return {
      status: 'pass',
      summary: `standards rules 100%; every other rule passes on the files this run changed (${counted.length} rules${naNote})${pre}`,
      details: notes.slice(0, MAX_DETAILS),
      ...(notes.length > 0 ? { humanMustVerify: capped(notes, MAX_HUMAN, 'see the standards report') } : {}),
    };
  },
});
