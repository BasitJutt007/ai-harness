/**
 * "Observed red" predicate shared by the observed-red hook, the observed-red
 * gate and the test_map tool.
 *
 * R.validRed is decided by the harness's runner (src/core/testing.ts): a failing
 * case whose expect() subject uses a value imported from src/ and is not a constant, or a
 * missing src/ module that such a case imports.
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
 *
 * EXPORT-ONLY edits (src/core/export-only.ts) are the one write a locked file takes: compared with its current
 * content, the write only exports existing top-level declarations. A test that imports a module-private
 * function fails to LOAD, which is no red for a file that existed at run start, and only adding `export` lets
 * it load: without this the lock and the load failure wait on each other forever. Such a write is recorded
 * (recordExportOnly: content hash before and after) and unlocks nothing; the test must then be observed
 * failing on an assertion like any other red.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { activeLayout, codeGlobs, declaresUnexported, isGovernedCodePath, isTestFile, isTestSupport, resolveImport, suggestTestPath } from '../../src/core/plugin-api.ts';
import type { RunContext, RunState, TestObservation } from '../../src/core/plugin-api.ts';

/**
 * The core's single definition (per the API's layout): runnable test = *.test|spec.(c|m)?ts, or what the
 * runner collects in a dedicated test dir; test support = any other file in a dedicated test dir (test/, tests/, …).
 */
export { isTestFile, isTestSupport };

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Source files the observed-red rule governs: every code file of the API's layout (TypeScript; in an
 * in-place web layout JavaScript and .vue/.svelte components too) that is neither a runnable test nor
 * test support (its source roots and anything else a broad brownfield scope allows, e.g. scripts/x.ts).
 */
export function isGovernedSource(rel: string): boolean {
  return isGovernedCodePath(rel, activeLayout());
}

/**
 * The runnable test file to suggest for a source file: one the API's runner actually collects
 * (tests/<name>.test.ts, a colocated <dir>/<name>.test.ts, …; test/<name>.test.ts for the template).
 */
export function suggestedTest(source: string): string {
  return suggestTestPath(posix.normalize(source), activeLayout());
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

/** scratch key: export-only edits of governed files in this run, as content-hash edges (recordExportOnly). */
export const EXPORT_ONLY_KEY = 'observed-red.export-only';

/** One export-only write: `file` went from content hash `from` to `to`, newly exporting `names`. */
export interface ExportOnlyRecord {
  file: string;
  from: string;
  to: string;
  names: string[];
}

export function exportOnlyRecords(state: RunState): ExportOnlyRecord[] {
  const v = state.scratch.get(EXPORT_ONLY_KEY);
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is ExportOnlyRecord => typeof r === 'object' && r !== null
    && typeof (r as ExportOnlyRecord).file === 'string' && typeof (r as ExportOnlyRecord).from === 'string' && typeof (r as ExportOnlyRecord).to === 'string'
    && Array.isArray((r as ExportOnlyRecord).names) && (r as ExportOnlyRecord).names.every((n) => typeof n === 'string'));
}

/** Record an export-only write (it unlocks nothing: see the module comment). */
export function recordExportOnly(state: RunState, r: ExportOnlyRecord): void {
  const all = exportOnlyRecords(state);
  if (all.some((x) => x.file === r.file && x.from === r.from && x.to === r.to)) return;
  state.scratch.set(EXPORT_ONLY_KEY, [...all, { file: r.file, from: r.from, to: r.to, names: [...r.names].sort() }]);
}

/**
 * The names a chain of recorded export-only edits exported on the way from `source`'s run-start content to
 * the content with hash `hash`, or null when no such chain exists (a file new in this run never has one). A
 * file whose current content is reached this way only exports declarations it had at run start: what any of
 * its code does is unchanged, so it has no behaviour of its own to prove.
 */
export function exportOnlySinceStart(state: RunState, source: string, hash: string): string[] | null {
  const start = state.initialHashes.get(source);
  if (start === undefined) return null;
  const edges = exportOnlyRecords(state).filter((r) => r.file === source);
  const names = new Map<string, string[]>([[start, []]]);
  const queue = [start];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (at === hash) return [...new Set(names.get(at) ?? [])].sort();
    for (const e of edges.filter((x) => x.from === at && !names.has(x.to))) {
      names.set(e.to, [...(names.get(at) ?? []), ...e.names]);
      queue.push(e.to);
    }
  }
  return null;
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
  /** The latest run's reason when it failed without counting as red (e.g. "red rejected: …"). */
  rejected?: string;
  /**
   * The latest run (of the test's current content) failed to load because the source this status is for
   * does not export `name` (the ESM linker's "does not provide an export named"); `declared`: the source
   * declares `name` at top level, so an export-only edit lets the test load.
   */
  missingExport?: { name: string; declared: boolean };
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
  if (latest !== undefined && latest.status !== 'pass' && !latest.validRed) status.rejected = latest.reason;
  if (source !== undefined && status.fresh && latest?.status === 'error' && latest.missingExport !== undefined) {
    const missing = await missingExportOf(ctx, test, latest.missingExport, source);
    if (missing !== null) status.missingExport = missing;
  }
  return status;
}

/**
 * The missing export of a test's load failure when its specifier, resolved from the test file itself, is
 * `source` (an import made elsewhere in the test's closure is not guessed at), and whether `source` declares
 * that name at top level without exporting it.
 */
async function missingExportOf(ctx: RunContext, test: string, missing: { module: string; name: string }, source: string): Promise<{ name: string; declared: boolean } | null> {
  const existing = new Set(await ctx.workspace.list(codeGlobs(activeLayout())).catch(() => [source]));
  if (resolveImport(test, missing.module, existing, activeLayout()) !== source) return null;
  const text = await ctx.workspace.read(source);
  return { name: missing.name, declared: text !== null && declaresUnexported(source, text, missing.name) };
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
        : t.rejected !== undefined
          ? `no valid red (last run: ${t.rejected})`
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
      `${path} is locked: no test covers it. Write ${suggestedTest(path)} that imports what it tests ` +
      `(e.g. import { … } from '../${path}'; a side-effect import does not count), run it with run_tests ` +
      `and observe a case that uses it fail on a real assertion, then edit ${path}.`
    );
  }
  const lines = lock.tests.map((t) => `  ${t.test}: ${describeTest(t)}`);
  const stale = lock.tests.filter((t) => t.red && !t.fresh).map((t) => t.test);
  const files = JSON.stringify(lock.tests.map((t) => t.test));
  const unexported = lock.tests.find((t) => t.missingExport !== undefined);
  let next: string;
  if (stale.length > 0) {
    next = `Next: re-run the edited test(s) with run_tests { "files": ${JSON.stringify(stale)} }; the edited content must be observed failing.`;
  } else if (unexported?.missingExport !== undefined) {
    const { name, declared } = unexported.missingExport;
    const run = `run_tests { "files": ${JSON.stringify([unexported.test])} }`;
    next = declared
      ? `${unexported.test} failed to load: it imports ${name} from ${path}, which declares ${name} but does not export it, and a load failure is not a red for a file that existed at run start.\n` +
        `Next: add \`export\` to the existing declaration of ${name} in ${path}. An export-only edit (adding \`export\` to existing top-level declarations and changing nothing else) is allowed while the file is locked; it unlocks nothing. ` +
        `Then ${run} to observe the case fail on an assertion, which unlocks ${path} for the fix.`
      : `${unexported.test} failed to load: it imports ${name} from ${path}, which has no top-level declaration of ${name} to export (an export-only edit can only export what already exists).\n` +
        `Next: test the behaviour through what ${path} exports, or put new code in a new module (a missing module counts as red for a file that did not exist at run start), then ${run} again.`;
  } else if (lock.existedAtStart && lock.tests.some((t) => t.loadRedOnly)) {
    next =
      `Next: ${path} existed before this run, so it needs a failing ASSERTION, not a missing module. ` +
      `Create the missing module(s) first, then run run_tests { "files": ${files} } again to observe an assertion fail.`;
  } else {
    next =
      `Next: add or change a case in ${lock.tests[0]?.test ?? suggestedTest(path)} that asserts on a value imported from src/ and ` +
      `fails on a non-constant assertion for the missing behaviour, then run run_tests { "files": ${files} } to observe red.`;
  }
  return [`${path} is locked: no covering test has an observed red at its current content.`, 'Covering tests:', ...lines, next].join('\n');
}
