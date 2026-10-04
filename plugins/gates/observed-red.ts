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
 *   - REVERT CHECK (differential): the harness runs the tests in two fresh scratch copies of the API in
 *     equivalent contexts (same parent dir, same-length random names, same env; see
 *     CoreServices.runTestsReverted), one with the current source and one where every changed source file
 *     has its run-start content back. The same case (name and body hash) must PASS in the current copy and
 *     FAIL in the reverted one. So the flip is caused by the source change, not by an edit elsewhere in the
 *     test file (a new mock, a changed file-level constant or helper), the clock, randomness, or where the
 *     test runs (a case branching on process.cwd() sees the same kind of path in both copies).
 * A case EDITED after its red (the model fixed its own test) counts only by that differential execution,
 * which proves the source change, not the edit, is what makes it pass. An edit that makes the case pass
 * regardless of the source (`toBe(1)` -> `toBe(0)` over unchanged behaviour) fails the revert check, and an
 * edited case whose test file reads its environment, path, the clock or randomness (process.cwd/env,
 * __dirname, import.meta, Date, Math.random, ...) is not accepted at all: such a file can behave differently
 * between runs for reasons other than the source.
 */
import ts from 'typescript';
import { defineGate, sourceRootsLabel } from '../../src/core/plugin-api.ts';
import type { DifferentialRun, TestCaseObservation, TestMap, TestObservation, TestRunReport } from '../../src/core/plugin-api.ts';
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

/** The case passes in the current-source copy and fails (or cannot load) in the reverted one. */
function flipsWithSource(cur: TestObservation | undefined, rev: TestObservation | undefined, c: RedCase): boolean {
  return passesIn(cur, c) && (rev?.cases ?? []).some((x) => sameCase(x, c) && (x.status === 'fail' || x.status === 'error'));
}

function sameCase(x: TestCaseObservation, c: RedCase): boolean {
  return x.name === c.name && x.bodyHash === c.bodyHash;
}

function passesIn(o: TestObservation | undefined, c: RedCase): boolean {
  return (o?.cases ?? []).some((x) => sameCase(x, c) && x.status === 'pass');
}

const PROCESS_STATE = new Set(['cwd', 'chdir', 'env', 'argv', 'execArgv', 'execPath', 'pid', 'ppid', 'hrtime', 'uptime', 'platform', 'arch']);
const RANDOM = new Set(['random', 'randomUUID', 'randomBytes', 'randomInt', 'getRandomValues', 'randomFillSync']);
const CONTEXT_GLOBALS = new Set(['__dirname', '__filename', 'Date', 'performance']);

/**
 * What in `text` (a test file) reads the run's environment, its own path, the clock or randomness: process
 * state (cwd, env, argv, ...), __dirname / __filename, import.meta, Date, performance, Math.random / crypto.random*.
 * Sorted, deduplicated.
 */
export function contextReads(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) found.add('import.meta');
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const obj = node.expression.text;
      const prop = node.name.text;
      if (obj === 'process' && PROCESS_STATE.has(prop)) found.add(`process.${prop}`);
      else if (RANDOM.has(prop) && (obj === 'Math' || obj === 'crypto')) found.add(`${obj}.${prop}`);
    } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
      found.add('process[...]');
    } else if (ts.isIdentifier(node) && CONTEXT_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const key = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      if (!memberName && !key) found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
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
    /** Changed files proven by an unchanged case, and those proven only by an edited one (differential proof). */
    const unchangedProofs = new Set<string>();
    const editedProofs = new Set<string>();
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
    if (candidates.size > 0) {
      // An edited case whose test file reads its environment, path, clock or randomness is not provable by
      // differential execution alone: drop it (and say why when nothing else is left for the file).
      const reads = new Map<string, string[]>();
      for (const test of new Set([...candidates.values()].flat().filter((c) => c.edited === true).map((c) => c.test))) {
        reads.set(test, contextReads(test, (await ctx.workspace.read(test)) ?? ''));
      }
      const contextBound = (c: RedCase): string[] => (c.edited === true ? reads.get(c.test) ?? [] : []);
      for (const [f, greens] of candidates) {
        const kept = greens.filter((c) => contextBound(c).length === 0);
        if (kept.length > 0) {
          candidates.set(f, kept);
          continue;
        }
        candidates.delete(f);
        const c = greens[0];
        if (c === undefined) continue;
        problems.push(`${f}: ${c.test}: "${c.name}" was edited after its red and its test file reads ${contextBound(c).join(', ')}: an edited case is accepted through the revert check only when its outcome cannot depend on where, when or how it runs`);
      }
    }
    if (problems.length === 0 && candidates.size > 0) {
      // Revert check: in two equivalent fresh copies the cases must pass with the current source and fail with the run-start one.
      const files = [...new Set([...candidates.values()].flat().map((c) => c.test))].sort();
      let diff: DifferentialRun;
      try {
        diff = await ctx.services.runTestsReverted(files, changed);
      } catch (e) {
        return { status: 'unproven', summary: `revert check could not run: ${e instanceof Error ? e.message : String(e)}` };
      }
      const cur = new Map(diff.current.observations.map((o) => [o.file, o]));
      const rev = new Map(diff.reverted.observations.map((o) => [o.file, o]));
      for (const [f, greens] of candidates) {
        const proven = greens.filter((c) => flipsWithSource(cur.get(c.test), rev.get(c.test), c));
        if (proven.length > 0) {
          (proven.some((c) => c.edited !== true) ? unchangedProofs : editedProofs).add(f);
          continue;
        }
        const c = greens[0];
        if (c === undefined) continue;
        if (!passesIn(cur.get(c.test), c)) {
          problems.push(`${f}: ${c.test}: "${c.name}" does not pass in a fresh copy with the current source (revert check): its pass depends on where or how it runs, not on the source`);
          continue;
        }
        problems.push(
          c.edited === true
            ? `${f}: ${c.test}: "${c.name}" was edited after its red and its current body also passes with the run-start source (revert check): the edit, not the source change, makes it pass`
            : `${f}: ${c.test}: "${c.name}" also passes with the run-start source (revert check): its red did not depend on the source change`,
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
      summary: `${reds.length} red observations (${new Set(reds.map((o) => o.file)).size} test files); ${changed.length} changed source files went red -> green (${unchangedProofs.size} on unchanged cases, ${editedProofs.size} on edited cases by differential proof), red again with the original source`,
    };
  },
});
