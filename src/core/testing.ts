/**
 * The harness's own test runner: the ONLY source of "observed red".
 *
 * Runs the API's runner (vitest, jest or node:test, per the TargetProfile; the harness's
 * vitest by default) with its default (console) reporter AND a JSON report in one shape
 * (vitest's and jest's JSON reporters; node-test-reporter.mjs for node:test), parses it and
 * turns it into one TestObservation per test file. Whether a red counts (validRed) is decided
 * here, deterministically, never by the model.
 *
 * Each observation also carries per-case evidence (TestObservation.cases): the cases
 * are parsed statically from the exact file content that was hashed and joined with
 * the runner's per-case results. A red only counts when a failing case asserts (with any
 * assertion API) on a value from the API's source roots, judged at the statement it failed at: a constant
 * assertion or a hand-thrown error does not count (the revert check stays the final word).
 *
 * The child runs agent-written code: it runs sandboxed (writes only to a per-run temp
 * dir, network only to localhost; the API root is read-only, so test code cannot edit
 * source or tests behind the hooked write tools' back), and its home/config/temp
 * directories point at that throw-away directory: tests cannot read the operator's
 * ~/.config/gh, ~/.aws, ~/.npmrc or ~/.ssh.
 *
 * On request (RunTestsOptions.isolateFailures) a run with failing cases is followed by a
 * diagnosis: up to two failing cases are re-run alone, and one that passes alone is reported as
 * order-dependent (TestRunReport.diagnosis). Those runs are never observations.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'tinyglobby';
import { safeEnv } from './exec.ts';
import { activeLayout, isSourcePath, sourceRootsLabel, versionAtLeast } from './target.ts';
import type { TargetLayout, TestRunnerInfo } from './target.ts';
import { graphFiles, importGraph, reachesSource, locatedRed, resolveImport, staticTestCases } from './testmap.ts';
import type { ImportGraph, StaticTestCase } from './testmap.ts';
import type { Exec, ExecResult, LogStore, TestCaseObservation, TestCaseResult, TestObservation, TestRunReport } from './types.ts';

const VITEST_TIMEOUT_MS = 300_000;
/** Where the runner's JSON report is written: the exec channel (fd 3), a pipe only the runner process itself holds. */
export const REPORT_CHANNEL = '/dev/fd/3';
const MAX_SUMMARY_FAILURES = 10;
const MAX_MESSAGE_CHARS = 160;
/** Cap of TestRunReport.console (the runner's own console output). */
export const MAX_CONSOLE_BYTES = 64 * 1024;
/** At most this many failing cases of one run are re-run alone (the order-dependence diagnosis). */
export const MAX_ISOLATED_CASES = 2;

/**
 * The subset of the runner JSON report we rely on: vitest's (verified against vitest 5.0.3), jest's
 * --json report and node-test-reporter.mjs all have this shape.
 */
export interface VitestAssertion {
  ancestorTitles: string[];
  title: string;
  status: string;
  failureMessages: string[];
  /** Where the case is declared (jest --testLocationInResults, node:test); absent when the runner omits it. */
  location?: { line: number; column: number };
}
export interface VitestFileResult {
  name: string;
  status: string;
  message: string;
  assertionResults: VitestAssertion[];
}

/** What every runner adapter takes. */
export interface RunTestsOptions {
  root: string;
  files?: string[];
  exec: Exec;
  harnessRoot: string;
  logs: LogStore;
  turn: number;
  /** The target's runner (TargetProfile.runner). Default: the harness's own vitest. */
  runner?: TestRunnerInfo;
  /** Source/test classification for the observations. Default: the active layout. */
  layout?: TargetLayout;
  /**
   * When cases fail, re-run up to MAX_ISOLATED_CASES of them alone and report the ones that pass
   * alone (TestRunReport.diagnosis; see orderDependence). Diagnostic only: no observation comes of it.
   */
  isolateFailures?: boolean;
}

/** One concrete runner command: how it is started and the name of its raw log. */
interface Invocation {
  cmd: string;
  args: string[];
  label: string;
}

const NODE_TEST_REPORTER = fileURLToPath(new URL('./node-test-reporter.mjs', import.meta.url));

/**
 * The command for `runner` (vitest, jest or node:test). Each writes the same JSON report shape
 * (testResults/assertionResults) to the private fd-3 channel, next to its default console reporter.
 * `filter`: runner options that select cases by name (caseNameFilter), empty for a normal run.
 */
function invocation(runner: TestRunnerInfo | undefined, root: string, files: string[], filter: string[], tmpDir: string, harnessRoot: string): Invocation {
  const kind = runner?.kind ?? 'vitest';
  if (kind === 'jest' && runner?.bin !== undefined) {
    // --runTestsByPath: the entries are paths, not regexes; jest's cache stays in the per-run temp dir.
    // A worker memory limit makes jest (29+) never run tests in band, i.e. never inside the process that holds fd 3.
    const args = [runner.bin, '--ci', '--json', `--outputFile=${REPORT_CHANNEL}`, '--testLocationInResults', '--watchman=false',
      '--maxWorkers=2', '--workerIdleMemoryLimit=4GB', `--cacheDirectory=${join(tmpDir, 'jest-cache')}`, ...filter,
      ...(files.length > 0 ? ['--runTestsByPath', ...files] : [])];
    return { cmd: process.execPath, args, label: 'jest' };
  }
  if (kind === 'node-test') {
    const patterns = files.length > 0 ? files : runner?.patterns ?? [];
    const args = [...(runner?.nodeArgs ?? []), '--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${pathToFileURL(NODE_TEST_REPORTER).href}`, `--test-reporter-destination=${REPORT_CHANNEL}`, ...filter, ...patterns];
    return { cmd: process.execPath, args, label: 'node-test' };
  }
  // vitest: the target's own install when it has one (runner.bin), else the harness's. `--configLoader runner`
  // (vitest >= 3.1) loads the config without writing a bundled copy next to it (the API root is read-only).
  const version = runner?.version;
  const loader = version === undefined || version === null || versionAtLeast(version, 3, 1) ? ['--configLoader', 'runner'] : [];
  const args = ['run', '--root', root, ...loader, '--pool=forks', '--reporter=default', '--reporter=json', `--outputFile.json=${REPORT_CHANNEL}`, ...filter, ...files];
  if (runner?.bin !== undefined) return { cmd: process.execPath, args: [runner.bin, ...args], label: 'vitest' };
  return { cmd: join(harnessRoot, 'node_modules', '.bin', 'vitest'), args, label: 'vitest' };
}

/** The vitest adapter, kept for callers that name it: runTargetTests with the harness's vitest by default. */
export async function runVitest(opts: RunTestsOptions): Promise<TestRunReport> {
  return runTargetTests(opts);
}

/**
 * Run the API's tests with its own runner (vitest, jest or node:test) and turn the report into one
 * observation per test file. An unsupported runner runs nothing; the report says why (UNPROVEN).
 */
export async function runTargetTests(opts: RunTestsOptions): Promise<TestRunReport> {
  const files = checkFileArgs(opts.root, opts.files ?? []);
  if (opts.runner !== undefined && !opts.runner.supported) {
    const why = opts.runner.reason ?? `unsupported test runner ${opts.runner.name}`;
    const logPath = await opts.logs.write('tests', `not run: ${why}`);
    return { ok: false, totals: { files: 0, tests: 0, passed: 0, failed: 0 }, observations: [], summary: `tests: not run (UNPROVEN): ${why}`, logPath, console: '' };
  }
  const layout = opts.layout ?? activeLayout();
  const { res, parsed, consoleText, logPath } = await execRunner(opts, files, []);
  if (parsed === null) {
    const why = res.timedOut ? 'timed out' : `exit ${String(res.code)}`;
    const first = firstLine(stripAnsi(res.stderr || res.stdout)) || 'no JSON report';
    return {
      ok: false,
      totals: { files: 0, tests: 0, passed: 0, failed: 0 },
      observations: [],
      summary: `tests: runner error (${why}): ${clip(first)}\nlog: ${logPath}`,
      logPath,
      console: consoleText,
    };
  }
  const at = new Date().toISOString();
  const graph = await sourceGraph(opts.root, layout);
  const observations: TestObservation[] = [];
  for (const fr of parsed) observations.push(await observe(opts.root, fr, opts.turn, at, graph, layout));
  const report: TestRunReport = { ...buildReport(opts.root, parsed, observations, logPath, consoleText), console: consoleText };
  if (opts.isolateFailures !== true || report.totals.failed === 0) return report;
  const diagnosis = await orderDependence(opts, parsed, observations);
  return diagnosis.length > 0 ? { ...report, diagnosis } : report;
}

/** One runner process: its result, the parsed fd-3 report (null when none or unreadable), console text and raw log. */
interface RunnerOutput {
  res: ExecResult;
  parsed: VitestFileResult[] | null;
  consoleText: string;
  logPath: string;
}

/**
 * Start the runner over `files` (plus the case filter `filter`), sandboxed in a fresh per-run temp dir
 * that is removed afterwards. Every run, the diagnostic ones included, goes through here.
 */
async function execRunner(opts: RunTestsOptions, files: string[], filter: string[]): Promise<RunnerOutput> {
  // Under the OS temp dir, never inside the harness repo: nothing the confined child can write lives next to plugin code.
  const tmpDir = await mkdtemp(join(tmpdir(), 'harness-vitest-'));
  const home = join(tmpDir, 'home');
  await mkdir(home, { recursive: true });
  // Both reporters: the console one is what a developer sees (the honest raw return), JSON is what we parse.
  // The JSON report travels over a private pipe on the runner's fd 3 (REPORT_CHANNEL), never through a file:
  // test workers (forced to child processes) and anything they spawn do not inherit that descriptor, so
  // agent code cannot rewrite the report between the runner writing it and the harness reading it.
  const run = invocation(opts.runner, opts.root, files, filter, tmpDir, opts.harnessRoot);
  const args = run.args;
  try {
    const res = await opts.exec(run.cmd, args, {
      cwd: opts.root,
      env: runnerEnv(home, tmpDir),
      timeoutMs: VITEST_TIMEOUT_MS,
      sandbox: { writable: [tmpDir], network: 'localhost' },
      channel: true,
    });
    const json = res.channel !== undefined && res.channel.trim() !== '' ? res.channel : null;
    const consoleText = consoleOutput(res.stdout, res.stderr, REPORT_CHANNEL);
    const label = filter.length > 0 ? `${run.label}-alone` : run.label;
    const logPath = await opts.logs.write(
      label,
      [`$ ${run.label} ${args.join(' ')}`, `exit: ${String(res.code)}${res.timedOut ? ' (timed out)' : ''}`,
        '--- stdout ---', res.stdout, '--- stderr ---', res.stderr, '--- json ---', json ?? '(no report written)'].join('\n'),
    );
    return { res, parsed: json === null ? null : parseReport(json), consoleText, logPath };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ───────────────────────────── order dependence ─────────────────────────────

/** A failing case to re-run alone: its API-relative file, its titles (describe titles, then its own) and the runner's filter for it. */
interface IsolatedCase {
  file: string;
  titles: string[];
  filter: string[];
}

/** The note for a case that passes alone but failed among the other tests of its file. */
export function orderDependenceNote(file: string, titles: string[]): string {
  return `${file} > ${titles.join(' > ')}: passes when run alone, fails after the other tests in this file: it depends on test order `
    + '(shared state, e.g. a module-level store, is not reset between tests). Do not assume an empty store; assert only on the records this test created.';
}

/**
 * The options that make `runner` (the one invocation() starts) run exactly the case `titles` of a file,
 * by name, or null when it has no safe name filter. The pattern is the case's full name, every title
 * escaped as a literal, anchored at both ends:
 * - vitest matches `--testNamePattern` against the titles joined with ' > ' (vitest 4+) or ' ' (older),
 *   so either separator is accepted;
 * - jest matches it, case-insensitively, against the titles joined with ' '.
 * Either could still select another case whose full name reads the same: the isolated run's report must
 * show exactly this one case run (soleResult). node:test has no safe filter: its pattern also runs every
 * test under a suite whose own name matches and filters subtests, so a case run "alone" could skip its
 * own failing subtest and pass.
 */
export function caseNameFilter(runner: TestRunnerInfo | undefined, titles: string[]): string[] | null {
  if (titles.length === 0) return null;
  const parts = titles.map(escapeRegExp);
  const kind = runner?.kind ?? 'vitest';
  if (kind === 'jest' && runner?.bin !== undefined) return [`--testNamePattern=^${parts.join(' ')}$`];
  if (kind === 'node-test') return null;
  return [`--testNamePattern=^ ?${parts.join('(?: > | )')}$`];
}

/**
 * Diagnostic only, never an observation (no red, no green; nothing reaches RunState): re-run up to
 * MAX_ISOLATED_CASES failing cases alone, each through the runner's name filter on its own file, with
 * the same sandbox, env and fd-3 report channel as the run itself. A case that passes alone although
 * it failed after the other tests of its file depends on test order (state shared between the cases of
 * a file, e.g. a module-level store): one note per such case. No note for a file that failed to load or
 * broke outside its cases, a case whose name another case of the file shares, a runner without a safe
 * name filter, or an isolated run that errors, times out or does not run exactly that one case.
 */
async function orderDependence(opts: RunTestsOptions, files: VitestFileResult[], observations: TestObservation[]): Promise<string[]> {
  const status = new Map(observations.map((o) => [o.file, o.status]));
  const cases: IsolatedCase[] = [];
  for (const fr of files) {
    const file = relPath(opts.root, fr.name);
    if (status.get(file) !== 'fail' || fr.message !== '') continue;
    // A failing case that was the only one to run in its file already ran alone.
    if (fr.assertionResults.filter(didRun).length < 2) continue;
    for (const a of fr.assertionResults) {
      if (a.status !== 'failed') continue;
      const titles = [...a.ancestorTitles, a.title];
      if (fr.assertionResults.filter((b) => sameTitles([...b.ancestorTitles, b.title], titles)).length > 1) continue;
      const filter = caseNameFilter(opts.runner, titles);
      if (filter !== null) cases.push({ file, titles, filter });
    }
  }
  const notes: string[] = [];
  for (const c of cases.slice(0, MAX_ISOLATED_CASES)) {
    const alone = await execRunner(opts, [c.file], c.filter);
    if (alone.res.timedOut || alone.res.code !== 0 || alone.parsed === null) continue;
    if (soleResult(opts.root, alone.parsed, c) === 'passed') notes.push(orderDependenceNote(c.file, c.titles));
  }
  return notes;
}

/** A case the runner ran (not skipped, todo or filtered out by name). */
function didRun(a: VitestAssertion): boolean {
  return a.status === 'passed' || a.status === 'failed';
}

function sameTitles(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * The result of `target` in an isolated run when it is the only case that ran and its file reports no
 * error outside it; otherwise null (the filter selected nothing, or more than that case).
 */
function soleResult(root: string, files: VitestFileResult[], target: IsolatedCase): 'passed' | 'failed' | null {
  const runs = files.flatMap((fr) => fr.assertionResults.filter(didRun).map((a) => ({ fr, a })));
  const only = runs[0];
  if (runs.length !== 1 || only === undefined) return null;
  if (relPath(root, only.fr.name) !== target.file || only.fr.message !== '') return null;
  if (!sameTitles([...only.a.ancestorTitles, only.a.title], target.titles)) return null;
  return only.a.status === 'passed' ? 'passed' : 'failed';
}

/**
 * Vitest file filters must stay inside the API root: no option-looking entries
 * (`--config=…`), no absolute paths, no `..` escapes. Returns the entries unchanged.
 */
export function checkFileArgs(root: string, files: string[]): string[] {
  for (const f of files) {
    if (typeof f !== 'string' || f.trim() === '' || f.includes('\u0000')) {
      throw new Error(`runTests: invalid test file entry ${JSON.stringify(f)}`);
    }
    if (f.startsWith('-')) {
      throw new Error(`runTests: test file entry "${f}" looks like an option; pass API-relative test file paths only`);
    }
    if (isAbsolute(f) || /^[A-Za-z]:/.test(f) || f.startsWith('\\')) {
      throw new Error(`runTests: test file entry "${f}" is absolute; pass paths relative to the API root`);
    }
    const rel = relative(root, resolve(root, f));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`runTests: test file entry "${f}" escapes the API root`);
    }
  }
  return files;
}

/** Variables that point tools at the operator's own config/credential stores. */
const HOME_POINTERS = [
  'npm_config_userconfig', 'NPM_CONFIG_USERCONFIG', 'npm_config_globalconfig', 'NPM_CONFIG_GLOBALCONFIG',
  'GH_CONFIG_DIR', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'DOCKER_CONFIG', 'KUBECONFIG',
  'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK', 'GNUPGHOME', 'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR',
];

/**
 * Child env: credentials stripped, no colour, no leaked vitest worker state from a parent vitest,
 * HOME / USERPROFILE / XDG_* pointing at a fresh throw-away directory, and TMPDIR / TMP / TEMP
 * at the per-run temp dir (the only place the confined runner may write).
 */
export function runnerEnv(home: string, tmp?: string): NodeJS.ProcessEnv {
  const env = safeEnv({
    ...(tmp !== undefined ? { TMPDIR: tmp, TMP: tmp, TEMP: tmp } : {}),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
  });
  for (const k of Object.keys(env)) {
    if (/^(__)?VITEST/i.test(k) || k === 'TEST' || k === 'NODE_ENV' || HOME_POINTERS.includes(k)) delete env[k];
  }
  return env;
}

/** The default reporter's console output (no colour), without our JSON-file notice, capped at 64 KB. */
function consoleOutput(stdout: string, stderr: string, outFile: string): string {
  const text = stripAnsi([stdout, stderr].filter((s) => s.trim() !== '').join('\n'))
    .split('\n')
    .filter((l) => !(l.includes('JSON report written to') && l.includes(outFile)))
    .join('\n')
    .trim();
  return capBytes(text, MAX_CONSOLE_BYTES);
}

/** Keep the head and (mostly) the tail, where the failure details and totals are. */
export function capBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  const marker = `\n… [${buf.length - max} bytes of console output omitted] …\n`;
  const room = Math.max(0, max - Buffer.byteLength(marker));
  const head = Math.floor(room / 4);
  const tail = room - head;
  return `${buf.subarray(0, head).toString('utf8')}${marker}${buf.subarray(buf.length - tail).toString('utf8')}`;
}

// ───────────────────────────── parsing ─────────────────────────────

export function parseReport(json: string): VitestFileResult[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data['testResults'])) return null;
  const out: VitestFileResult[] = [];
  for (const raw of data['testResults']) {
    if (!isRecord(raw) || typeof raw['name'] !== 'string') continue;
    const assertions: VitestAssertion[] = [];
    const ar = raw['assertionResults'];
    if (Array.isArray(ar)) {
      for (const a of ar) {
        if (!isRecord(a)) continue;
        const assertion: VitestAssertion = {
          ancestorTitles: stringArray(a['ancestorTitles']),
          title: typeof a['title'] === 'string' ? a['title'] : '',
          status: typeof a['status'] === 'string' ? a['status'] : 'unknown',
          failureMessages: stringArray(a['failureMessages']),
        };
        const loc = a['location'];
        if (isRecord(loc) && typeof loc['line'] === 'number') {
          assertion.location = { line: loc['line'], column: typeof loc['column'] === 'number' ? loc['column'] : 0 };
        }
        assertions.push(assertion);
      }
    }
    out.push({
      name: raw['name'],
      status: typeof raw['status'] === 'string' ? raw['status'] : 'unknown',
      message: typeof raw['message'] === 'string' ? raw['message'] : '',
      assertionResults: assertions,
    });
  }
  return out;
}

/** Import graph of the API root's TypeScript files as they are on disk after the run (for "does this import reach source?"). */
async function sourceGraph(root: string, layout: TargetLayout): Promise<ImportGraph> {
  const listed = await glob(['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'], { cwd: root, ignore: ['**/node_modules/**', '**/.git/**'] }).catch(() => []);
  return importGraph(graphFiles(listed), (f) => readFile(join(root, f), 'utf8').catch(() => null), layout);
}

async function observe(root: string, fr: VitestFileResult, turn: number, at: string, graph: ImportGraph, layout: TargetLayout): Promise<TestObservation> {
  const file = relPath(root, fr.name);
  const content = await readFile(resolve(root, file)).catch(() => null);
  const hash = createHash('sha256').update(content ?? '').digest('hex');
  const collected = fr.assertionResults.length;
  const failed = fr.assertionResults.filter((a) => a.status === 'failed').length;
  const loadError = collected === 0 && (fr.status === 'failed' || fr.message !== '');
  // Static cases come from the very bytes that were hashed above.
  const text = (content ?? Buffer.alloc(0)).toString('utf8');
  const statics = staticTestCases(file, text, {
    resolve: (spec) => resolveImport(file, spec, graph.existing, layout),
    reachesSource: (target) => reachesSource(target, graph.edges, layout),
  });
  const cases = joinCases(statics, fr.assertionResults, loadError, { file, content: text });
  const base = { file, hash, collected, failed, turn, at, cases };
  const where = sourceRootsLabel(layout);
  if (failed > 0) {
    const counts = cases.some((c) => c.status === 'fail' && countsAsRed(c));
    const why = `${failed} of ${collected} tests failed`;
    return { ...base, status: 'fail', validRed: counts, reason: counts ? why : `${why}; ${rejectedFailures(cases, where)}` };
  }
  if (loadError || fr.status === 'failed') {
    const missing = missingSourceModule(root, fr.message, layout);
    if (missing !== null) {
      const why = `imports ${missing}, which does not exist yet`;
      const counts = cases.some(countsAsRed);
      return { ...base, status: 'error', validRed: counts, reason: counts ? why : `${why}; ${rejectedCases(cases, where)}` };
    }
    const msg = shortMessage(root, fr.message) || 'suite failed to load';
    return { ...base, status: 'error', validRed: false, reason: `suite error: ${msg}` };
  }
  return { ...base, status: 'pass', validRed: false, reason: `${collected} tests passed` };
}

/** A case whose failure can count as red: an assertion (any library) uses a value from the API's source and is not constant-only. */
export function countsAsRed(c: TestCaseObservation): boolean {
  return c.exercisesSource && !c.constantOnly;
}

/** Why the failing cases of a run do not count as red (`where`: the source roots, e.g. "src/"). */
function rejectedFailures(cases: TestCaseObservation[], where: string): string {
  const failing = cases.filter((c) => c.status === 'fail');
  if (failing.length === 0) return 'red rejected: the failing tests could not be matched to a test case in the file (use literal titles)';
  if (failing.every((c) => c.constantOnly)) return 'red rejected: the failing cases only assert constants';
  if (failing.every((c) => !c.exercisesSource)) {
    return `red rejected: the failing cases do not assert on anything imported from ${where} (an assertion, of any library, must use its value; side-effect imports, void x and typeof x don't count)`;
  }
  return `red rejected: no failing case both asserts on something imported from ${where} and has a non-constant subject`;
}

/** Why a missing-module red does not count: no case would exercise the missing code. */
function rejectedCases(cases: TestCaseObservation[], where: string): string {
  if (cases.every((c) => !c.exercisesSource)) {
    return `red rejected: no test case uses anything imported from ${where} (side-effect imports don't count)`;
  }
  return `red rejected: the test cases that use ${where} only assert constants`;
}

const RUNTIME_STATUS: Record<string, TestCaseObservation['status']> = { passed: 'pass', failed: 'fail' };

/**
 * Join static cases with the runner's per-case results. Exact keys ("describe > ... > title")
 * pair up in order; a table/dynamic case takes the leftover results its pattern matches, and a
 * result that two patterns match is attributed to neither. A case with no result is 'skip'
 * (not observed); every case of a file that failed to load is 'error'.
 *
 * With `located` (the file the statics were parsed from), a failing case is judged by WHERE it
 * failed (testmap.locatedRed): the statement its failure points at must be an assertion (of any
 * library) on a value from src/, not a constant one; with no frame in the case the static verdict stands.
 */
export function joinCases(
  statics: StaticTestCase[],
  results: VitestAssertion[],
  loadError: boolean,
  located?: { file: string; content: string },
): TestCaseObservation[] {
  const keyed = results.map((a) => ({ key: [...a.ancestorTitles, a.title].join(' > '), status: RUNTIME_STATUS[a.status] ?? 'skip', messages: a.failureMessages.map(stripAnsi), used: false }));
  const assigned = statics.map((): Array<TestCaseObservation['status']> => []);
  const messages = statics.map((): string[] => []);
  const assign = (i: number, k: (typeof keyed)[number]): void => {
    assigned[i]?.push(k.status);
    if (k.status === 'fail') messages[i]?.push(...k.messages);
  };
  statics.forEach((s, i) => {
    if (!('exact' in s.match)) return;
    const hit = keyed.find((k) => !k.used && 'exact' in s.match && k.key === s.match.exact);
    if (hit === undefined) return;
    hit.used = true;
    assign(i, hit);
  });
  for (const k of keyed.filter((x) => !x.used)) {
    const owners = statics.flatMap((s, i) => ('pattern' in s.match && s.match.pattern.test(k.key) ? [i] : []));
    const owner = owners[0];
    if (owners.length === 1 && owner !== undefined) assign(owner, k);
  }
  return statics.map((s, i) => {
    const seen = assigned[i] ?? [];
    const status: TestCaseObservation['status'] = loadError ? 'error'
      : seen.includes('fail') ? 'fail'
        : seen.length > 0 && seen.every((x) => x === 'pass') ? 'pass'
          : 'skip';
    const judged = status === 'fail' && located !== undefined ? locatedRed(s, messages[i] ?? [], located.file, located.content) : null;
    const c: TestCaseObservation = { name: s.name, status, exercisesSource: judged?.exercisesSource ?? s.exercisesSource, constantOnly: judged?.constantOnly ?? s.constantOnly };
    if (s.bodyHash !== undefined) c.bodyHash = s.bodyHash;
    return c;
  });
}

/**
 * If `message` is a missing-module error whose specifier resolves (relative, absolute, or through the
 * layout's tsconfig paths / runner aliases) to a source path that does not exist, return that
 * API-relative path; otherwise null. A bare package specifier is never a valid red.
 */
export function missingSourceModule(root: string, message: string, layout: TargetLayout = activeLayout()): string | null {
  const text = stripAnsi(message);
  const patterns: RegExp[] = [
    /Cannot find module ['"]([^'"]+)['"] imported from ['"]?([^'"\s]+)/,
    /Failed to resolve import ["']([^"']+)["'] from ["']([^"']+)["']/,
    /Failed to load url (\S+) \(resolved id: \S+\) in (\S+)/,
    // jest: Cannot find module '../src/x' from 'test/x.test.ts'
    /Cannot find module ['"]([^'"]+)['"] from ['"]([^'"]+)['"]/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const spec = m?.[1]?.replace(/^file:\/\//, '');
    const importer = m?.[2]?.replace(/^file:\/\//, '');
    if (spec === undefined || importer === undefined) continue;
    let rel: string;
    if (spec.startsWith('.')) {
      const imp = isAbsolute(importer) ? importer : resolve(root, importer);
      rel = relPath(root, resolve(dirname(imp), spec));
    } else if (isAbsolute(spec)) {
      rel = relPath(root, spec);
    } else {
      const from = relPath(root, isAbsolute(importer) ? importer : resolve(root, importer));
      const aliased = resolveImport(from, spec, new Set<string>(), layout);
      if (aliased === null) return null; // bare package specifier: never valid red
      rel = aliased;
    }
    if (rel.startsWith('../') || isAbsolute(rel)) return null;
    const asTs = rel.replace(/\.(m|c)?js$/, '.$1ts');
    const file = /\.[cm]?tsx?$/.test(asTs) ? asTs : `${asTs}.ts`;
    if (!isSourcePath(file, layout)) return null;
    const abs = resolve(root, rel);
    const candidates = [abs, abs.replace(/\.(m|c)?js$/, '.$1ts'), `${abs}.ts`, join(abs, 'index.ts')];
    if (candidates.some((c) => existsSync(c))) return null;
    return file;
  }
  return null;
}

/**
 * Where a suite that failed to load broke, from the runner's console output: the first
 * in-project stack frame (a project-relative path) after `file`'s failure header and `message`, plus the
 * source line the runner prints for it, e.g. `at src/routes/index.ts:10:7  app.use(usersRouter);`.
 * A load error with a location is actionable; the bare message usually is not. Null when the
 * console names no such frame, or has no failure header for `file` (a capped console may have
 * dropped it), or the message is not inside that file's own block.
 */
export function errorLocation(consoleText: string, file: string, message: string): string | null {
  const head = firstLine(stripAnsi(message));
  if (head === '') return null;
  const header = consoleText.search(new RegExp(`FAIL\\s+${escapeRegExp(file)}\\b`));
  // No header for this file (e.g. the console cap dropped it): any frame found would belong to another file's failure.
  if (header < 0) return null;
  const at = consoleText.indexOf(head, header);
  // The message must sit in the file's own block: before the next separator line after its header.
  const sep = /\n\s*⎯/g;
  sep.lastIndex = header;
  const end = sep.exec(consoleText)?.index ?? consoleText.length;
  if (at < 0 || at > end) return null;
  const block = consoleText.slice(at, at + 4000).split('\n');
  for (let i = 1; i < block.length; i += 1) {
    const line = block[i] ?? '';
    if (/^\s*⎯/.test(line) || /^\s*FAIL\s/.test(line)) break; // next failure block
    // `❯ fn src/a.ts:1:2`, `❯ new UsersService lib/a.ts:1:2` (a constructor frame) or a bare `❯ app.ts:1:2`:
    // any project-relative file (never `../…` or node_modules, which are outside the project).
    const loc = /❯\s+(?:new\s+)?(?:\S+\s+)?((?!\.\.?\/|node_modules\/)[\w@][^\s:]*\.[cm]?[jt]sx?:(\d+):\d+)\s*$/.exec(line);
    if (loc?.[1] === undefined) continue;
    const code = block.slice(i + 1, i + 8).map((l) => /^\s*(\d+)\|\s?(.*)$/.exec(l)).find((m) => m?.[1] === loc[2])?.[2]?.trim();
    return `at ${loc[1]}${code !== undefined && code.length > 0 ? `  ${clip(code)}` : ''}`;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A case's result as reported (vitest: passed, failed, skipped, pending, todo); anything that did not run is 'skip'. */
const CASE_RESULT: Record<string, TestCaseResult['status']> = { passed: 'pass', failed: 'fail', todo: 'todo' };

function buildReport(root: string, files: VitestFileResult[], observations: TestObservation[], logPath: string, consoleText = ''): TestRunReport {
  let tests = 0;
  let passed = 0;
  let failed = 0;
  const failLines: string[] = [];
  const errorLines: string[] = [];
  const results: TestCaseResult[] = [];
  for (const fr of files) {
    const rel = relPath(root, fr.name);
    for (const a of fr.assertionResults) {
      tests++;
      results.push({ file: rel, name: [...a.ancestorTitles, a.title].join(' > '), status: CASE_RESULT[a.status] ?? 'skip' });
      if (a.status === 'passed') passed++;
      if (a.status !== 'failed') continue;
      failed++;
      const title = [...a.ancestorTitles, a.title].join(' > ');
      // vitest: "AssertionError: …"; jest: "Error: expect(…)…"; node:assert: "AssertionError [ERR_ASSERTION]: …".
      const msg = firstLine(stripAnsi(a.failureMessages[0] ?? '')).replace(/^AssertionError(?: \[[A-Z_]+\])?:\s*|^Error:\s*(?=expect\()/, '');
      failLines.push(`FAIL ${rel} > ${title}: ${clip(stripRoot(root, msg))}`);
    }
  }
  const messages = new Map(files.map((fr) => [relPath(root, fr.name), fr.message]));
  for (const o of observations) {
    if (o.status !== 'error') continue;
    const where = errorLocation(consoleText, o.file, messages.get(o.file) ?? '');
    errorLines.push(`ERROR ${o.file}: ${clip(o.reason)}${where !== null ? ` (${where})` : ''}${o.validRed ? ' (valid red)' : ''}`);
  }
  const errors = observations.filter((o) => o.status === 'error').length;
  const skipped = tests - passed - failed;
  const head = `tests: ${failed} failed, ${passed} passed${skipped > 0 ? `, ${skipped} skipped/todo` : ''} (${tests}) in ${files.length} files${errors > 0 ? `, ${errors} failed to load` : ''}`;
  const detail = [...errorLines, ...failLines];
  const lines = [head, ...detail.slice(0, MAX_SUMMARY_FAILURES)];
  if (detail.length > MAX_SUMMARY_FAILURES) lines.push(`… ${detail.length - MAX_SUMMARY_FAILURES} more`);
  if (tests === 0 && errors === 0) lines.push('no tests ran');
  else if (passed === 0 && failed === 0 && errors === 0) lines.push('no test passed: skipped/todo tests are not green');
  else if (skipped > 0 && failed === 0 && errors === 0) lines.push('not green: skipped/todo tests count as not passed');
  // The raw log path stays in report.logPath for humans; the model cannot read harness logs.
  return {
    // Green means every collected test ran and passed: all-skipped / todo suites are not green.
    ok: passed > 0 && passed === tests && errors === 0,
    totals: { files: files.length, tests, passed, failed },
    observations,
    results,
    summary: lines.join('\n'),
    logPath,
  };
}

// ───────────────────────────── helpers ─────────────────────────────

/** API-relative POSIX path for an absolute (or relative) path; tolerant of symlinked roots (/var vs /private/var). */
function relPath(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const roots = [root];
  try {
    roots.push(realpathSync(root));
  } catch {
    // root may not exist
  }
  for (const r of roots) {
    const rel = relative(r, abs);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return abs.split(sep).join('/');
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** First few meaningful lines of a runner message, root-relative, box-drawing stripped, on one line. */
function shortMessage(root: string, message: string): string {
  const lines = stripRoot(root, stripAnsi(message))
    .replace(/[\u2500-\u257F]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
  return clip(lines.slice(0, 3).join(' '));
}

function stripRoot(root: string, s: string): string {
  const roots = [root];
  try {
    roots.push(realpathSync(root));
  } catch {
    // root may not exist
  }
  let out = s;
  for (const r of roots) out = out.split(`${r}${sep}`).join('');
  return out;
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
}

function clip(s: string): string {
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…` : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
