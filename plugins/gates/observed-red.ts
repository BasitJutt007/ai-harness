/**
 * observed-red: red -> green on UNCHANGED test code. The gate runs the tests fresh
 * itself, then every governed file the run changed (vs the initial snapshot)
 *   - was let through by the observed-red hook (so nothing changed it behind the
 *     write tools' back, e.g. test code writing source files), and
 *   - has a covering test T with a case C that an earlier run of T saw red (failing,
 *     or not loadable because a source module was missing, only for a file that did not
 *     exist at run start), using code imported from the API's source roots (its TargetProfile)
 *     with a non-constant assertion,
 *     and that the fresh run sees PASS with the same body hash (the hash covers the whole case call:
 *     title, callback, options, timeout, .each table), and
 *   - REVERT CHECK: that same case FAILS again when the harness runs it in a scratch copy of the
 *     API where every changed source file has its run-start content back. So the flip is caused
 *     by the source change, not by an edit elsewhere in the test file (a new mock, a changed
 *     file-level constant or helper), the clock, or randomness.
 * A case EDITED after its red (the model fixed its own test) counts only by differential execution:
 * its current body passes now AND fails with the run-start source (the revert check below), which proves
 * the source change, not the edit, is what makes it pass. An edit that makes the case pass regardless of
 * the source (`toBe(1)` -> `toBe(0)` over unchanged behaviour) still fails the revert check.
 */
import { defineGate, sourceRootsLabel } from '../../src/core/plugin-api.ts';
import type { TestCaseObservation, TestMap, TestObservation, TestRunReport } from '../../src/core/plugin-api.ts';
import { isGovernedSource, sha256, suggestedTest, unlockedSources } from '../lib/red.ts';

/** What is missing for one covering test, from least to most progress (the gate reports the most advanced one). */
const RANK = ['never red', 'only a missing-module red (the file existed at run start)', 'red only on constants', 'red only in cases that use nothing from the source', 'edited after red', 'still failing'] as const;
type Missing = (typeof RANK)[number];

function countsAsRed(c: TestCaseObservation): boolean {
  return c.exercisesSource && !c.constantOnly && c.bodyHash !== undefined;
}

/** A red case that may unlock `source`: a failure, or a missing-module error only for a file that is new in this run. */
function redCase(o: TestObservation, c: TestCaseObservation, existedAtStart: boolean): boolean {
  return o.validRed && countsAsRed(c) && (c.status === 'fail' || (c.status === 'error' && !existedAtStart));
}

interface RedCase {
  test: string;
  name: string;
  bodyHash: string | undefined;
  /** Edited after its red: accepted only through the revert check on its current body. */
  edited?: boolean;
}
type Evidence = { greens: RedCase[] } | { missing: Missing; detail: string };

/** Red -> green cases for `test` (still to pass the revert check), else what is missing and the case it concerns. */
function evidence(test: string, earlier: TestObservation[], fresh: TestObservation | undefined, existedAtStart: boolean): Evidence {
  const runs = earlier.filter((o) => o.file === test);
  const reds = runs.flatMap((o) => (o.cases ?? []).filter((c) => redCase(o, c, existedAtStart)));
  if (reds.length === 0) {
    const failing = runs.flatMap((o) => (o.cases ?? []).filter((c) => c.status === 'fail'));
    if (failing.length > 0 && failing.every((c) => c.constantOnly)) return { missing: 'red only on constants', detail: '' };
    if (failing.some((c) => !c.exercisesSource)) return { missing: 'red only in cases that use nothing from the source', detail: ` (nothing imported from ${sourceRootsLabel()})` };
    if (existedAtStart && runs.some((o) => o.validRed && o.status === 'error')) {
      return { missing: 'only a missing-module red (the file existed at run start)', detail: '' };
    }
    return { missing: 'never red', detail: runs.length === 0 ? ' (never run)' : '' };
  }
  let gap: { missing: Missing; detail: string } = { missing: 'edited after red', detail: '' };
  const greens: RedCase[] = [];
  for (const red of reds) {
    const now = (fresh?.cases ?? []).filter((c) => c.name === red.name && c.bodyHash === red.bodyHash);
    if (now.some((c) => c.status === 'pass')) greens.push({ test, name: red.name, bodyHash: red.bodyHash });
    else if (now.length > 0) gap = { missing: 'still failing', detail: ` ("${red.name}")` };
    else {
      // Edited after red: its CURRENT body is a candidate for the differential (revert) check.
      const edited = (fresh?.cases ?? []).filter((c) => c.name === red.name && c.status === 'pass' && countsAsRed(c));
      for (const c of edited) greens.push({ test, name: c.name, bodyHash: c.bodyHash, edited: true });
      if (edited.length === 0 && gap.missing !== 'still failing') gap = { missing: 'edited after red', detail: ` ("${red.name}")` };
    }
  }
  return greens.length > 0 ? { greens } : gap;
}

/** The case fails (or cannot load) in the reverted run. */
function redAgain(rev: TestObservation | undefined, c: RedCase): boolean {
  return (rev?.cases ?? []).some((x) => x.name === c.name && x.bodyHash === c.bodyHash && (x.status === 'fail' || x.status === 'error'));
}

export default defineGate({
  name: 'observed-red',
  description: 'Every changed source file has a covering test case seen red by the harness runner that now passes and fails again with the original source.',
  phases: ['finish', 'ship'],
  async run(ctx) {
    const earlier = ctx.state.tests.slice();
    const reds = earlier.filter((o) => o.validRed);
    if (reds.length === 0) {
      return {
        status: 'fail',
        summary: 'no observed red in this run',
        details: [`Write ${suggestedTest('<name>.ts')} (a test the API's runner collects) for the behaviour, run it with run_tests and see it fail before changing source.`],
      };
    }
    let changed: string[];
    let map: TestMap;
    try {
      const files = await ctx.workspace.list(['**/*.ts', '**/*.mts', '**/*.cts']);
      changed = [];
      for (const f of files.filter(isGovernedSource).sort()) {
        const content = await ctx.workspace.read(f);
        if (content !== null && sha256(content) !== ctx.state.initialHashes.get(f)) changed.push(f);
      }
      map = await ctx.services.testMap();
    } catch (e) {
      return { status: 'unproven', summary: `could not inspect changes: ${e instanceof Error ? e.message : String(e)}` };
    }
    let report: TestRunReport;
    try {
      report = await ctx.services.runTests();
    } catch (e) {
      return { status: 'unproven', summary: `test runner failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const fresh = new Map(report.observations.map((o) => [o.file, o]));
    const unlocked = unlockedSources(ctx.state);
    const problems: string[] = [];
    const candidates = new Map<string, RedCase[]>();
    for (const f of changed) {
      if (!unlocked.has(f)) {
        problems.push(`${f}: changed without passing the observed-red hook (not written by a write tool, e.g. modified by test code)`);
        continue;
      }
      const tests = map.testsFor(f);
      if (tests.length === 0) {
        problems.push(`${f}: no covering test`);
        continue;
      }
      const existed = ctx.state.initialHashes.has(f);
      const gaps = tests.map((t) => ({ t, e: evidence(t, earlier, fresh.get(t), existed) }));
      const greens = gaps.flatMap((g) => ('greens' in g.e ? g.e.greens : []));
      if (greens.length > 0) {
        candidates.set(f, greens);
        continue;
      }
      const rank = (e: Evidence): number => ('missing' in e ? RANK.indexOf(e.missing) : RANK.length);
      const best = gaps.reduce((a, b) => (rank(b.e) > rank(a.e) ? b : a));
      problems.push(`${f}: ${best.t}: ${'missing' in best.e ? `${best.e.missing}${best.e.detail}` : 'never red'}`);
    }
    if (problems.length === 0 && candidates.size > 0) {
      // Revert check: with every changed source file back at its run-start content, the red cases must fail again.
      const files = [...new Set([...candidates.values()].flat().map((c) => c.test))].sort();
      let reverted: TestRunReport;
      try {
        reverted = await ctx.services.runTestsReverted(files, changed);
      } catch (e) {
        return { status: 'unproven', summary: `revert check could not run: ${e instanceof Error ? e.message : String(e)}` };
      }
      const rev = new Map(reverted.observations.map((o) => [o.file, o]));
      for (const [f, greens] of candidates) {
        if (greens.some((c) => redAgain(rev.get(c.test), c))) continue;
        const c = greens[0];
        problems.push(
          c?.edited === true
            ? `${f}: ${c.test}: "${c.name}" was edited after its red and its current body also passes with the run-start source (revert check): the edit, not the source change, makes it pass`
            : `${f}: ${c?.test ?? ''}: "${c?.name ?? ''}" also passes with the run-start source (revert check): its red did not depend on the source change`,
        );
      }
    }
    if (problems.length > 0) {
      return {
        status: 'fail',
        summary: `${problems.length} of ${changed.length} changed source files lack a red -> green test case`,
        details: [
          ...problems,
          'Each changed file needs a covering case that was seen failing and now passes, and that fails again with the original source (a case edited after its red counts only through that revert check).',
        ],
        logPath: report.logPath,
      };
    }
    return {
      status: 'pass',
      summary: `${reds.length} red observations (${new Set(reds.map((o) => o.file)).size} test files); ${changed.length} changed source files went red -> green on unchanged cases, red again with the original source`,
    };
  },
});
