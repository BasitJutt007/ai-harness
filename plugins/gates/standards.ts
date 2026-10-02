/**
 * standards: the registered checks prove the API, with a diff-aware policy.
 *
 * - The 'standards'-category rules (the graded four) are strict over the WHOLE API:
 *   100% or refuse.
 * - Any other rule (a dropped-in ORM or lint rule) blocks only for violations in files this
 *   run changed (content differs from the run-start snapshot in state.initialHashes, or the
 *   file is new). Violations in unchanged files (greenfield scaffold files, brownfield files
 *   the task scope denies; path-guard keeps both read-only, so the agent could never fix them)
 *   are listed as "pre-existing (not blocking)" instead of making DONE impossible.
 * - A skipped rule (any category), an empty standards rule, or zero rules is UNPROVEN, and an
 *   n/a rule (nothing to check) is never counted as green.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { CheckFinding, CheckReport, GateResult, RuleSummary, RunContext } from '../../src/core/plugin-api.ts';
import { sha256 } from '../lib/red.ts';

const STANDARDS = 'standards';
const MAX_DETAILS = 25;

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

/** Split the failing findings of non-standards rules into blocking and pre-existing ones. */
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

export default defineGate({
  name: 'standards',
  description:
    'The standards rules pass at 100% over the whole API; other (ORM, lint) rules must pass on every file this run changed '
    + '(violations in unchanged files are reported as pre-existing). A skipped or empty rule is unproven, never green.',
  phases: ['finish', 'ship'],
  async run(ctx): Promise<GateResult> {
    let report: CheckReport;
    try {
      report = await ctx.services.runChecks();
    } catch (e) {
      return { status: 'unproven', summary: `checks could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
    const compact = report.compact.split('\n').filter((l) => l.trim() !== '').slice(0, MAX_DETAILS);
    const { status, percent } = report.verdict;
    if (report.rules.length === 0) return { status: 'unproven', summary: 'verdict 100% over zero rules: no checks ran, nothing is proven', details: compact };
    if (status === 'unproven') return { status: 'unproven', summary: 'verdict UNPROVEN (a rule was skipped or had nothing to check)', details: compact };

    const counted = report.rules.filter((r) => r.status !== 'n/a');
    const na = report.rules.length - counted.length;
    const skipped = report.findings.filter((f) => f.status === 'skip');
    const unproven = counted.filter((r) => r.status === 'unproven');
    if (counted.length === 0) return { status: 'unproven', summary: `every rule was n/a (${na}): nothing is proven`, details: compact };
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
    const naNote = na > 0 ? `, ${na} n/a` : '';
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
    };
  },
});
