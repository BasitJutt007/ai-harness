/**
 * The harness's own test runner: the ONLY source of "observed red".
 *
 * Runs vitest with its default (console) AND JSON reporters, parses the JSON
 * report and turns it into one TestObservation per test file. Whether a red
 * counts (validRed) is decided here, deterministically, never by the model.
 *
 * Each observation also carries per-case evidence (TestObservation.cases): the cases
 * are parsed statically from the exact file content that was hashed and joined with
 * the runner's per-case results. A red only counts when a failing case uses code
 * imported from src/ and asserts on something other than constants.
 *
 * The child runs agent-written code: it runs sandboxed (writes only to a per-run temp
 * dir, network only to localhost; the API root is read-only, so test code cannot edit
 * source or tests behind the hooked write tools' back), and its home/config/temp
 * directories point at that throw-away directory: tests cannot read the operator's
 * ~/.config/gh, ~/.aws, ~/.npmrc or ~/.ssh.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { glob } from 'tinyglobby';
import { safeEnv } from './exec.ts';
import { graphFiles, importGraph, reachesSource, resolveSpecifier, staticTestCases } from './testmap.ts';
import type { ImportGraph, StaticTestCase } from './testmap.ts';
import type { Exec, LogStore, TestCaseObservation, TestCaseResult, TestObservation, TestRunReport } from './types.ts';

const VITEST_TIMEOUT_MS = 300_000;
/** Where vitest's JSON reporter writes: the exec channel (fd 3), a pipe only the vitest process itself holds. */
export const REPORT_CHANNEL = '/dev/fd/3';
const MAX_SUMMARY_FAILURES = 10;
const MAX_MESSAGE_CHARS = 160;
/** Cap of TestRunReport.console (the runner's own console output). */
export const MAX_CONSOLE_BYTES = 64 * 1024;

/** The subset of vitest's JSON report we rely on (verified against vitest 5.0.3). */
export interface VitestAssertion {
  ancestorTitles: string[];
  title: string;
  status: string;
  failureMessages: string[];
}
export interface VitestFileResult {
  name: string;
  status: string;
  message: string;
  assertionResults: VitestAssertion[];
}

export async function runVitest(opts: {
  root: string;
  files?: string[];
  exec: Exec;
  harnessRoot: string;
  logs: LogStore;
  turn: number;
}): Promise<TestRunReport> {
  const files = checkFileArgs(opts.root, opts.files ?? []);
  // Under the OS temp dir, never inside the harness repo: nothing the confined child can write lives next to plugin code.
  const tmpDir = await mkdtemp(join(tmpdir(), 'harness-vitest-'));
  const home = join(tmpDir, 'home');
  await mkdir(home, { recursive: true });
  const vitest = join(opts.harnessRoot, 'node_modules', '.bin', 'vitest');
  // Both reporters: the console one is what a developer sees (the honest raw return), JSON is what we parse.
  // The JSON report travels over a private pipe on vitest's fd 3 (REPORT_CHANNEL), never through a file:
  // test workers (forced to child processes) and anything they spawn do not inherit that descriptor, so
  // agent code cannot rewrite the report between vitest writing it and the harness reading it.
  const args = ['run', '--root', opts.root, '--configLoader', 'runner', '--pool=forks', '--reporter=default', '--reporter=json',
    `--outputFile.json=${REPORT_CHANNEL}`, ...files];
  try {
    const res = await opts.exec(vitest, args, {
      cwd: opts.root,
      env: runnerEnv(home, tmpDir),
      timeoutMs: VITEST_TIMEOUT_MS,
      sandbox: { writable: [tmpDir], network: 'localhost' },
      channel: true,
    });
    const json = res.channel !== undefined && res.channel.trim() !== '' ? res.channel : null;
    const consoleText = consoleOutput(res.stdout, res.stderr, REPORT_CHANNEL);
    const logPath = await opts.logs.write(
      'vitest',
      [`$ vitest ${args.join(' ')}`, `exit: ${String(res.code)}${res.timedOut ? ' (timed out)' : ''}`,
        '--- stdout ---', res.stdout, '--- stderr ---', res.stderr, '--- json ---', json ?? '(no report written)'].join('\n'),
    );
    const parsed = json === null ? null : parseReport(json);
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
    const graph = await sourceGraph(opts.root);
    const observations: TestObservation[] = [];
    for (const fr of parsed) observations.push(await observe(opts.root, fr, opts.turn, at, graph));
    return { ...buildReport(opts.root, parsed, observations, logPath, consoleText), console: consoleText };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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
        assertions.push({
          ancestorTitles: stringArray(a['ancestorTitles']),
          title: typeof a['title'] === 'string' ? a['title'] : '',
          status: typeof a['status'] === 'string' ? a['status'] : 'unknown',
          failureMessages: stringArray(a['failureMessages']),
        });
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

/** Import graph of the API root's .ts files as they are on disk after the run (for "does this import reach src/?"). */
async function sourceGraph(root: string): Promise<ImportGraph> {
  const listed = await glob(['**/*.ts', '**/*.mts', '**/*.cts'], { cwd: root, ignore: ['**/node_modules/**', '**/.git/**'] }).catch(() => []);
  return importGraph(graphFiles(listed), (f) => readFile(join(root, f), 'utf8').catch(() => null));
}

async function observe(root: string, fr: VitestFileResult, turn: number, at: string, graph: ImportGraph): Promise<TestObservation> {
  const file = relPath(root, fr.name);
  const content = await readFile(resolve(root, file)).catch(() => null);
  const hash = createHash('sha256').update(content ?? '').digest('hex');
  const collected = fr.assertionResults.length;
  const failed = fr.assertionResults.filter((a) => a.status === 'failed').length;
  const loadError = collected === 0 && (fr.status === 'failed' || fr.message !== '');
  // Static cases come from the very bytes that were hashed above.
  const statics = staticTestCases(file, (content ?? Buffer.alloc(0)).toString('utf8'), {
    resolve: (spec) => resolveSpecifier(file, spec, graph.existing),
    reachesSource: (target) => reachesSource(target, graph.edges),
  });
  const cases = joinCases(statics, fr.assertionResults, loadError);
  const base = { file, hash, collected, failed, turn, at, cases };
  if (failed > 0) {
    const counts = cases.some((c) => c.status === 'fail' && countsAsRed(c));
    const why = `${failed} of ${collected} tests failed`;
    return { ...base, status: 'fail', validRed: counts, reason: counts ? why : `${why}; ${rejectedFailures(cases)}` };
  }
  if (loadError || fr.status === 'failed') {
    const missing = missingSourceModule(root, fr.message);
    if (missing !== null) {
      const why = `imports ${missing}, which does not exist yet`;
      const counts = cases.some(countsAsRed);
      return { ...base, status: 'error', validRed: counts, reason: counts ? why : `${why}; ${rejectedCases(cases)}` };
    }
    const msg = shortMessage(root, fr.message) || 'suite failed to load';
    return { ...base, status: 'error', validRed: false, reason: `suite error: ${msg}` };
  }
  return { ...base, status: 'pass', validRed: false, reason: `${collected} tests passed` };
}

/** A case whose failure can count as red: an expect() subject uses a value from src/ and is not a constant. */
export function countsAsRed(c: TestCaseObservation): boolean {
  return c.exercisesSource && !c.constantOnly;
}

/** Why the failing cases of a run do not count as red. */
function rejectedFailures(cases: TestCaseObservation[]): string {
  const failing = cases.filter((c) => c.status === 'fail');
  if (failing.length === 0) return 'red rejected: the failing tests could not be matched to a test case in the file (use literal titles)';
  if (failing.every((c) => c.constantOnly)) return 'red rejected: the failing cases only assert constants';
  if (failing.every((c) => !c.exercisesSource)) {
    return "red rejected: the failing cases do not assert on anything imported from src/ (an expect() subject must use its value; side-effect imports, void x and typeof x don't count)";
  }
  return 'red rejected: no failing case both asserts on something imported from src/ and has a non-constant subject';
}

/** Why a missing-module red does not count: no case would exercise the missing code. */
function rejectedCases(cases: TestCaseObservation[]): string {
  if (cases.every((c) => !c.exercisesSource)) {
    return "red rejected: no test case uses anything imported from src/ (side-effect imports don't count)";
  }
  return 'red rejected: the test cases that use src/ only assert constants';
}

const RUNTIME_STATUS: Record<string, TestCaseObservation['status']> = { passed: 'pass', failed: 'fail' };

/**
 * Join static cases with the runner's per-case results. Exact keys ("describe > ... > title")
 * pair up in order; a table/dynamic case takes the leftover results its pattern matches, and a
 * result that two patterns match is attributed to neither. A case with no result is 'skip'
 * (not observed); every case of a file that failed to load is 'error'.
 */
export function joinCases(statics: StaticTestCase[], results: VitestAssertion[], loadError: boolean): TestCaseObservation[] {
  const keyed = results.map((a) => ({ key: [...a.ancestorTitles, a.title].join(' > '), status: RUNTIME_STATUS[a.status] ?? 'skip', used: false }));
  const assigned = statics.map((): Array<TestCaseObservation['status']> => []);
  statics.forEach((s, i) => {
    if (!('exact' in s.match)) return;
    const hit = keyed.find((k) => !k.used && 'exact' in s.match && k.key === s.match.exact);
    if (hit === undefined) return;
    hit.used = true;
    assigned[i]?.push(hit.status);
  });
  for (const k of keyed.filter((x) => !x.used)) {
    const owners = statics.flatMap((s, i) => ('pattern' in s.match && s.match.pattern.test(k.key) ? [i] : []));
    const owner = owners[0];
    if (owners.length === 1 && owner !== undefined) assigned[owner]?.push(k.status);
  }
  return statics.map((s, i) => {
    const seen = assigned[i] ?? [];
    const status: TestCaseObservation['status'] = loadError ? 'error'
      : seen.includes('fail') ? 'fail'
        : seen.length > 0 && seen.every((x) => x === 'pass') ? 'pass'
          : 'skip';
    const c: TestCaseObservation = { name: s.name, status, exercisesSource: s.exercisesSource, constantOnly: s.constantOnly };
    if (s.bodyHash !== undefined) c.bodyHash = s.bodyHash;
    return c;
  });
}

/**
 * If `message` is a missing-module error whose specifier resolves to a path under
 * `<root>/src/` that does not exist, return that API-relative path; otherwise null.
 */
export function missingSourceModule(root: string, message: string): string | null {
  const text = stripAnsi(message);
  const patterns: RegExp[] = [
    /Cannot find module ['"]([^'"]+)['"] imported from ['"]?([^'"\s]+)/,
    /Failed to resolve import ["']([^"']+)["'] from ["']([^"']+)["']/,
    /Failed to load url (\S+) \(resolved id: \S+\) in (\S+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const spec = m?.[1];
    const importer = m?.[2];
    if (spec === undefined || importer === undefined) continue;
    let target: string;
    if (spec.startsWith('.')) {
      const imp = isAbsolute(importer) ? importer : resolve(root, importer);
      target = resolve(dirname(imp), spec);
    } else if (isAbsolute(spec)) {
      target = spec;
    } else {
      return null; // bare package specifier: never valid red
    }
    const rel = relPath(root, target);
    if (!rel.startsWith('src/')) return null;
    const abs = resolve(root, rel);
    const candidates = [abs, abs.replace(/\.(m|c)?js$/, '.$1ts'), `${abs}.ts`, join(abs, 'index.ts')];
    if (candidates.some((c) => existsSync(c))) return null;
    const asTs = rel.replace(/\.(m|c)?js$/, '.$1ts');
    return /\.[cm]?ts$/.test(asTs) ? asTs : `${asTs}.ts`;
  }
  return null;
}

/**
 * Where a suite that failed to load broke, from the runner's console output: the first
 * in-project stack frame (src/ or test/) after `file`'s failure header and `message`, plus the
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
    // `❯ fn src/a.ts:1:2`, `❯ new UsersService src/a.ts:1:2` (a constructor frame) or a bare `❯ src/a.ts:1:2`.
    const loc = /❯\s+(?:new\s+)?(?:\S+\s+)?((?:src|test)\/[^\s:]+:(\d+):\d+)\s*$/.exec(line);
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
      const msg = firstLine(stripAnsi(a.failureMessages[0] ?? '')).replace(/^AssertionError:\s*/, '');
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
