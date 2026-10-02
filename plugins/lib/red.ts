/**
 * "Observed red" predicate shared by the observed-red hook, the observed-red
 * gate and the test_map tool.
 *
 * A red observation R of test T counts for a source file S iff R.validRed and
 *   - R saw an assertion fail (status 'fail'), or
 *   - R is a missing-module red and S did not exist when the run started
 *     (a missing module proves new files are needed, not that existing code is wrong).
 *
 * S is unlocked for writing iff some covering test T
 *   (a) has a counting red observed AT T's CURRENT CONTENT, or
 *   (b) S was already unlocked earlier in this run (recorded by the hook), T has a
 *       counting red in this run, and T's latest run saw its current content.
 * (a) means a test cannot be observed red once and then rewritten to cover other
 * files; (b) lets an already-unlocked file be fixed after its test was tidied up.
 * Editing T without re-running it always re-locks (neither (a) nor (b) holds).
 */
import { createHash } from 'node:crypto';
import type { RunContext, RunState, TestObservation } from '../../src/core/plugin-api.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Test files: anything under test/, or *.test.ts / *.spec.ts anywhere. */
export function isTestFile(rel: string): boolean {
  return rel.startsWith('test/') || /\.(test|spec)\.[cm]?ts$/.test(rel);
}

/**
 * Source files the observed-red rule governs: every non-test TypeScript file
 * (src/** and anything else a broad brownfield scope allows, e.g. scripts/x.ts).
 */
export function isGovernedSource(rel: string): boolean {
  return /\.[cm]?ts$/.test(rel) && !rel.endsWith('.d.ts') && !isTestFile(rel);
}

/** scratch key: governed files the observed-red hook has let through in this run. */
export const UNLOCKED_KEY = 'observed-red.unlocked';

export function unlockedSources(state: RunState): Set<string> {
  const v = state.scratch.get(UNLOCKED_KEY);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

export function recordUnlocked(state: RunState, source: string): void {
  const set = unlockedSources(state);
  set.add(source);
  state.scratch.set(UNLOCKED_KEY, [...set].sort());
}

export function latestObservation(state: RunState, test: string): TestObservation | undefined {
  for (let i = state.tests.length - 1; i >= 0; i--) {
    const obs = state.tests[i];
    if (obs && obs.file === test) return obs;
  }
  return undefined;
}

/** Whether red observation `o` counts for a source that did / did not exist at run start. */
export function redCounts(o: TestObservation, sourceExistedAtStart: boolean): boolean {
  return o.validRed && (o.status === 'fail' || !sourceExistedAtStart);
}

/** Any valid red for `test` in this run (optionally: one that counts for `source`). */
export function hasValidRed(state: RunState, test: string, source?: string): boolean {
  const existed = source !== undefined && state.initialHashes.has(source);
  return state.tests.some((o) => o.file === test && (source === undefined ? o.validRed : redCounts(o, existed)));
}

export interface TestRedStatus {
  test: string;
  /** A counting red observation exists for this test in the run. */
  red: boolean;
  /** A counting red was observed at the test's current content. */
  redNow: boolean;
  /** Only missing-module reds exist, and they do not count for a file that existed at run start. */
  loadRedOnly: boolean;
  /** Ran at least once in this run. */
  ran: boolean;
  /** The latest run saw the test's current content. */
  fresh: boolean;
  /** Status of the latest run, if any. */
  lastStatus?: TestObservation['status'];
}

export interface LockState {
  path: string;
  tests: TestRedStatus[];
  unlocked: boolean;
  /** Tests that satisfy the predicate. */
  unlockedBy: string[];
  /** The file existed when the run started. */
  existedAtStart: boolean;
}

/** Red status of `test`; with `source`, only reds that count for that source are considered. */
export async function testRedStatus(ctx: RunContext, test: string, source?: string): Promise<TestRedStatus> {
  const existed = source !== undefined && ctx.state.initialHashes.has(source);
  const counts = (o: TestObservation): boolean => o.file === test && (source === undefined ? o.validRed : redCounts(o, existed));
  const latest = latestObservation(ctx.state, test);
  const current = await ctx.workspace.read(test);
  const currentHash = current === null ? null : sha256(current);
  const reds = ctx.state.tests.filter(counts);
  const status: TestRedStatus = {
    test,
    red: reds.length > 0,
    redNow: currentHash !== null && reds.some((o) => o.hash === currentHash),
    loadRedOnly: reds.length === 0 && ctx.state.tests.some((o) => o.file === test && o.validRed),
    ran: latest !== undefined,
    fresh: latest !== undefined && currentHash !== null && latest.hash === currentHash,
  };
  if (latest) status.lastStatus = latest.status;
  return status;
}

export async function lockState(ctx: RunContext, source: string): Promise<LockState> {
  const map = await ctx.services.testMap();
  const tests = await Promise.all(map.testsFor(source).map((t) => testRedStatus(ctx, t, source)));
  const sticky = unlockedSources(ctx.state).has(source);
  const unlockedBy = tests.filter((t) => t.redNow || (sticky && t.red && t.fresh)).map((t) => t.test);
  return { path: source, tests, unlocked: unlockedBy.length > 0, unlockedBy, existedAtStart: ctx.state.initialHashes.has(source) };
}

/** Short per-test label, e.g. "red observed at current content" / "never run" / "edited since last run". */
export function describeTest(t: TestRedStatus): string {
  if (!t.ran) return 'never run';
  if (t.redNow) return 'red observed at its current content';
  const parts = [
    t.red
      ? 'red observed on an earlier version'
      : t.loadRedOnly
        ? 'only a missing-module red (does not count for a file that already existed)'
        : `no red observed (last run: ${t.lastStatus ?? 'unknown'})`,
  ];
  parts.push(t.fresh ? 'unchanged since last run' : 'edited since last run');
  return parts.join(', ');
}

/** Actionable explanation of why a source file is locked. */
export function lockedReason(lock: LockState): string {
  const { path } = lock;
  if (lock.tests.length === 0) {
    return (
      `${path} is locked: no test covers it. Write a test under test/ that imports it ` +
      `(e.g. import from '../${path}'), run it with run_tests to observe it fail, then edit ${path}.`
    );
  }
  const lines = lock.tests.map((t) => `  ${t.test}: ${describeTest(t)}`);
  const stale = lock.tests.filter((t) => t.red && !t.fresh).map((t) => t.test);
  const files = JSON.stringify(lock.tests.map((t) => t.test));
  let next: string;
  if (stale.length > 0) {
    next = `Next: re-run the edited test(s) with run_tests { "files": ${JSON.stringify(stale)} }; the edited content must be observed failing.`;
  } else if (lock.existedAtStart && lock.tests.some((t) => t.loadRedOnly)) {
    next =
      `Next: ${path} existed before this run, so it needs a failing ASSERTION, not a missing module. ` +
      `Create the missing module(s) first, then run run_tests { "files": ${files} } again to observe an assertion fail.`;
  } else {
    next =
      `Next: add or change a test in ${lock.tests[0]?.test ?? 'a covering test'} that fails for the missing behaviour, ` +
      `then run run_tests { "files": ${files} } to observe red.`;
  }
  return [`${path} is locked: no covering test has an observed red at its current content.`, 'Covering tests:', ...lines, next].join('\n');
}
