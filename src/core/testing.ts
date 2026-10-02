/**
 * The harness's own test runner: the ONLY source of "observed red".
 *
 * Runs vitest with its default (console) AND JSON reporters, parses the JSON
 * report and turns it into one TestObservation per test file. Whether a red
 * counts (validRed) is decided here, deterministically, never by the model.
 *
 * The child runs agent-written code, so its home/config directories point at
 * a throw-away directory: tests cannot read the operator's ~/.config/gh,
 * ~/.aws, ~/.npmrc or ~/.ssh.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeEnv } from './exec.ts';
import type { Exec, LogStore, TestObservation, TestRunReport } from './types.ts';

const VITEST_TIMEOUT_MS = 300_000;
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
  const tmpDir = join(opts.harnessRoot, '.harness', 'tmp', `vitest-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const home = join(tmpDir, 'home');
  await mkdir(home, { recursive: true });
  const outFile = join(tmpDir, 'report.json');
  const vitest = join(opts.harnessRoot, 'node_modules', '.bin', 'vitest');
  // Both reporters: the console one is what a developer sees (the honest raw return), JSON is what we parse.
  const args = ['run', '--root', opts.root, '--reporter=default', '--reporter=json', `--outputFile.json=${outFile}`, ...files];
  try {
    const res = await opts.exec(vitest, args, { cwd: opts.root, env: runnerEnv(home), timeoutMs: VITEST_TIMEOUT_MS });
    const json = await readFile(outFile, 'utf8').catch(() => null);
    const consoleText = consoleOutput(res.stdout, res.stderr, outFile);
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
    const observations: TestObservation[] = [];
    for (const fr of parsed) observations.push(await observe(opts.root, fr, opts.turn, at));
    return { ...buildReport(opts.root, parsed, observations, logPath), console: consoleText };
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
 * and HOME / USERPROFILE / XDG_* pointing at a fresh throw-away directory.
 */
export function runnerEnv(home: string): NodeJS.ProcessEnv {
  const env = safeEnv({
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

async function observe(root: string, fr: VitestFileResult, turn: number, at: string): Promise<TestObservation> {
  const file = relPath(root, fr.name);
  const content = await readFile(resolve(root, file)).catch(() => null);
  const hash = createHash('sha256').update(content ?? '').digest('hex');
  const collected = fr.assertionResults.length;
  const failed = fr.assertionResults.filter((a) => a.status === 'failed').length;
  const loadError = collected === 0 && (fr.status === 'failed' || fr.message !== '');
  if (failed > 0) {
    return { file, hash, status: 'fail', collected, failed, validRed: true, reason: `${failed} of ${collected} tests failed`, turn, at };
  }
  if (loadError || fr.status === 'failed') {
    const missing = missingSourceModule(root, fr.message);
    if (missing !== null) {
      return { file, hash, status: 'error', collected, failed, validRed: true,
        reason: `imports ${missing}, which does not exist yet`, turn, at };
    }
    const msg = shortMessage(root, fr.message) || 'suite failed to load';
    return { file, hash, status: 'error', collected, failed, validRed: false, reason: `suite error: ${msg}`, turn, at };
  }
  return { file, hash, status: 'pass', collected, failed, validRed: false, reason: `${collected} tests passed`, turn, at };
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

function buildReport(root: string, files: VitestFileResult[], observations: TestObservation[], logPath: string): TestRunReport {
  let tests = 0;
  let passed = 0;
  let failed = 0;
  const failLines: string[] = [];
  const errorLines: string[] = [];
  for (const fr of files) {
    const rel = relPath(root, fr.name);
    for (const a of fr.assertionResults) {
      tests++;
      if (a.status === 'passed') passed++;
      if (a.status !== 'failed') continue;
      failed++;
      const title = [...a.ancestorTitles, a.title].join(' > ');
      const msg = firstLine(stripAnsi(a.failureMessages[0] ?? '')).replace(/^AssertionError:\s*/, '');
      failLines.push(`FAIL ${rel} > ${title}: ${clip(stripRoot(root, msg))}`);
    }
  }
  for (const o of observations) {
    if (o.status === 'error') errorLines.push(`ERROR ${o.file}: ${clip(o.reason)}${o.validRed ? ' (valid red)' : ''}`);
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
