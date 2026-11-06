/**
 * typecheck-feedback (post, write): after a successful write, a fast in-process syntax + type check
 * of just the written TypeScript file(s) with the TypeScript language service. Its errors are RECORDED
 * on the tool result the model sees, at most 3 lines:
 *   tsc: <n> error(s): src/a.ts:3:7 TS2322 Type 'string' is not assignable to type 'number'.
 *
 * Which options, and which program, depend on where the run writes:
 * - file mode (a worktree run, the 01 rubric): the options the tsc-strict check forces
 *   (fileCheckOptions: the API's tsconfig.json with every strict flag on), over the written files.
 * - in place (a session in the owner's checkout, writesInPlace): what the repository's own type check
 *   (repo-typecheck / web-typecheck) would say. The projects are found as that check finds them
 *   (projectsOf: tsconfig.json, or every project a solution-style tsconfig references), parsed fresh on
 *   every write so a new file matching an `include` counts. A written file is checked in every project
 *   whose program contains it (real paths compared), as `tsc -p` of each does: the projects that list it
 *   and the projects one of whose files imports it, each with its own options (no forced strict; an
 *   option it leaves unset keeps the default of the repository's TypeScript), as part of that project's
 *   program (its declaration files apply). A project's own errors (a `types` entry that does not
 *   resolve) are recorded once per run.
 *   Nothing is recorded for a written file no project's program includes: the repository's type check
 *   never checks it (a test/ outside every tsconfig, run through a runner that strips types). Not even a
 *   one-line "not covered" note: it asks for no action, and the actions a model would try (moving the
 *   test into src/ "so it is covered", editing a tsconfig) break the gate or are refused. Without a
 *   tsconfig.json, or without the repository's own TypeScript (node_modules/typescript), the gate checks
 *   nothing (n/a, or UNPROVEN), so nothing is recorded either.
 *
 * It only ever passes or records: it never blocks (errors are normal in the middle of a change; the
 * gates decide at finish) and never writes a file (the language service only reads, through the read
 * fence of createTsFence). Services are kept warm (per API root in file mode, per root and project in
 * place), so after the first check only changed files are re-parsed. A check found still running after
 * BUDGET_MS is cancelled and skipped; after MAX_OVERRUNS cancelled checks in a row the hook stays off
 * for that API root (noted once). The budget is not a hard cap: the deadline is looked at inside type
 * checking and, in place, after each project's program is built, but building a program cannot be
 * interrupted, so the first (cold) check of a large project, and in place
 * every check of a large checkout (each file's content is read and hashed to find what changed), can
 * take longer than BUDGET_MS before it is cancelled.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createTsFence, defineHook, fileCheckOptions, writesInPlace } from '../../src/core/plugin-api.ts';
import type { RunState, TsFence } from '../../src/core/plugin-api.ts';
import { projectsOf } from '../checks/repo-typecheck.ts';
import type { Project } from '../checks/repo-typecheck.ts';
import { toApiRel } from '../lib/path-policy.ts';

/** Time budget of one check: a check still running at the deadline is cancelled and its result skipped. */
export const BUDGET_MS = 1500;
/** Cancelled checks in a row after which the hook stays off for the API root. */
export const MAX_OVERRUNS = 2;
/** API roots whose language services are kept warm (the least recently used is dropped). */
const MAX_SERVICES = 3;
const MAX_LINES = 3;
const MAX_MESSAGE = 160;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
/** scratch key: the project-level error lines already recorded in this run (in place). */
const NOTED_KEY = 'typecheck-feedback.project-errors';
const HARNESS_TS_MAJOR = Number(ts.versionMajorMinor.split('.')[0]);

/** What the language service host reports, per check. */
interface CheckState {
  /** Root names of the current check: the written files (file mode) or the project's files (in place). */
  roots: string[];
  /** Script versions memoised for one check: the content hash of each file inside the API root. */
  versions: Map<string, string>;
  /** performance.now() after which the current check is cancelled; null between checks. */
  deadline: number | null;
  options: ts.CompilerOptions;
}

/** Cancelled checks in a row, and whether the hook is off for the API root. */
interface Budget {
  overruns: number;
  off: boolean;
}

interface Service {
  ls: ts.LanguageService;
  state: CheckState;
  budget: Budget;
}

const documents = ts.createDocumentRegistry();
/** File mode: one service per API root. */
const services = new Map<string, Service>();
/** In place: per checkout root, its fence, its budget and one service per tsconfig project. */
interface InPlaceRoot {
  fence: TsFence;
  budget: Budget;
  projects: Map<string, Service>;
}
const inPlaceRoots = new Map<string, InPlaceRoot>();

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * A language service over `root` whose every read goes through `fence`. Files under one of `contentRoots`
 * (outside node_modules) are versioned by content; everything else (libraries) never changes during a run.
 */
function createService(root: string, contentRoots: readonly string[], options: ts.CompilerOptions, fence: TsFence, budget: Budget): Service {
  // Agent code steers what this program reads (imports, tsconfig paths): every read goes through the same
  // fence as the other in-process programs, so a file outside the API's tree reads as absent.
  const read = (f: string): string | undefined => (fence.allows(f) ? fence.host.readFile(f) : undefined);
  const state: CheckState = { roots: [], versions: new Map(), deadline: null, options };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => state.roots,
    getScriptVersion: (f) => {
      if (!contentRoots.some((r) => inside(r, f))) return '0'; // libraries and node_modules do not change during a run
      const memo = state.versions.get(f);
      if (memo !== undefined) return memo;
      const text = read(f);
      const v = text === undefined ? 'absent' : createHash('sha256').update(text).digest('hex');
      state.versions.set(f, v);
      return v;
    },
    getScriptSnapshot: (f) => {
      const text = read(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => state.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    getCancellationToken: () => ({ isCancellationRequested: () => state.deadline !== null && performance.now() > state.deadline }),
    fileExists: (f) => fence.host.fileExists(f),
    readFile: (f) => read(f),
    readDirectory: (dir, extensions, exclude, include, depth) => [...fence.host.readDirectory(dir, extensions ?? [], exclude, include ?? [], depth)],
    directoryExists: (d) => fence.host.directoryExists(d),
    getDirectories: (d) => fence.host.getDirectories(d),
    realpath: (p) => fence.host.realpath(p),
  };
  return { ls: ts.createLanguageService(host, documents), state, budget };
}

function serviceFor(root: string): Service {
  const known = services.get(root);
  if (known !== undefined) {
    services.delete(root); // re-insert: most recently used last
    services.set(root, known);
    return known;
  }
  const svc = createService(root, [root], fileCheckOptions(root), createTsFence(root), { overruns: 0, off: false });
  services.set(root, svc);
  for (const [k, old] of services) {
    if (services.size <= MAX_SERVICES) break;
    old.ls.dispose();
    services.delete(k);
  }
  return svc;
}

/** `rel:line:col TSxxxx message` for an error diagnostic of the file `rel`. */
function errorLine(rel: string, d: ts.Diagnostic): string {
  const where = d.file !== undefined && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
  const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').replace(/\s+/g, ' ');
  return `${rel}${where !== undefined ? `:${where.line + 1}:${where.character + 1}` : ''} TS${d.code} ${msg.length > MAX_MESSAGE ? `${msg.slice(0, MAX_MESSAGE - 1)}…` : msg}`;
}

/** The errors of `file` (syntax first), reported under `rel`. */
function fileErrors(ls: ts.LanguageService, file: string, rel: (d: ts.Diagnostic) => string): string[] {
  const out: string[] = [];
  for (const d of [...ls.getSyntacticDiagnostics(file), ...ls.getSemanticDiagnostics(file)]) {
    if (d.category === ts.DiagnosticCategory.Error) out.push(errorLine(rel(d), d));
  }
  return out;
}

/** A cancelled check counts as an overrun; MAX_OVERRUNS in a row switch the hook off for the root. */
function overran(budget: Budget): null {
  budget.overruns += 1;
  if (budget.overruns >= MAX_OVERRUNS) budget.off = true;
  return null;
}

/** File mode. Errors of `files` (absolute, inside `root`) as `rel:line:col TSxxxx message` lines; null when the check ran out of time. */
export function checkFiles(root: string, files: string[], budgetMs = BUDGET_MS): string[] | null {
  const svc = serviceFor(root);
  const { state } = svc;
  state.roots = files;
  state.versions.clear();
  state.deadline = performance.now() + budgetMs;
  const out: string[] = [];
  try {
    for (const f of files) out.push(...fileErrors(svc.ls, f, (d) => toPosix(path.relative(root, d.file?.fileName ?? f))));
  } catch (e) {
    if (e instanceof ts.OperationCanceledException) return overran(svc.budget);
    throw e;
  } finally {
    state.deadline = null;
  }
  svc.budget.overruns = 0;
  return out;
}

// ───────────────────────────── in place ─────────────────────────────

/** What an in-place check found (see the file comment). */
export interface InPlaceCheck {
  /** Errors of the written files a project's program includes, under that project's options. */
  errors: string[];
  /** Errors of those projects themselves (options, global: a `types` entry that does not resolve), as `config TSxxxx message`. */
  project: string[];
  /** Written files (API-relative) no project's program includes: the repository's type check does not check them. */
  uncovered: string[];
  /** Why nothing was checked (no tsconfig.json, no TypeScript, an unreadable tsconfig); null when the check ran. */
  skipped: string | null;
}

function inPlaceRoot(root: string): InPlaceRoot {
  const known = inPlaceRoots.get(root);
  if (known !== undefined) {
    inPlaceRoots.delete(root); // re-insert: most recently used last
    inPlaceRoots.set(root, known);
    return known;
  }
  const entry: InPlaceRoot = { fence: createTsFence(root), budget: { overruns: 0, off: false }, projects: new Map() };
  inPlaceRoots.set(root, entry);
  for (const [k, old] of inPlaceRoots) {
    if (inPlaceRoots.size <= MAX_SERVICES) break;
    for (const svc of old.projects.values()) svc.ls.dispose();
    inPlaceRoots.delete(k);
  }
  return entry;
}

/** The major version of the repository's own TypeScript (node_modules/typescript, as the gate runs it), or null without one. */
function repoTypeScriptMajor(root: string, fence: TsFence): number | null {
  const text = fence.host.readFile(path.join(root, 'node_modules', 'typescript', 'package.json'));
  if (text === undefined) return null;
  try {
    const version: unknown = (JSON.parse(text) as { version?: unknown }).version;
    const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
    return Number.isFinite(major) ? major : HARNESS_TS_MAJOR;
  } catch {
    return HARNESS_TS_MAJOR;
  }
}

/**
 * A project's options as `tsc --noEmit -p <config>` of the repository's TypeScript uses them. The harness's
 * TypeScript 6 changed defaults the repository's older TypeScript still has, so an option the config leaves
 * unset gets the pre-6.0 default (strict off, every visible @types package, unchecked side-effect imports)
 * and the 6.0 option deprecations are silenced, as that compiler would not raise them.
 */
export function repoCompilerOptions(options: ts.CompilerOptions, repoMajor: number): ts.CompilerOptions {
  const out: ts.CompilerOptions = { ...options, noEmit: true };
  if (repoMajor < 6 && HARNESS_TS_MAJOR >= 6) {
    out.strict ??= false;
    out.alwaysStrict ??= options.strict === true;
    out.noUncheckedSideEffectImports ??= false;
    out.types ??= ['*'];
    out.ignoreDeprecations ??= `${HARNESS_TS_MAJOR}.0`;
  }
  return out;
}

/**
 * In place. Checks `files` (absolute, inside `root`) as the repository's own type check would: each in the
 * tsconfig project whose program includes it, with that project's options (see the file comment). Null when
 * the check ran out of time.
 */
export function checkInPlace(root: string, files: string[], budgetMs = BUDGET_MS): InPlaceCheck | null {
  const absRoot = path.resolve(root);
  const entry = inPlaceRoot(absRoot);
  const { fence } = entry;
  const skipped = (why: string): InPlaceCheck => ({ errors: [], project: [], uncovered: [], skipped: why });
  const found = projectsOf(absRoot, { ...fence.host, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (found.problem !== undefined) return skipped(found.problem);
  const major = repoTypeScriptMajor(absRoot, fence);
  if (major === null) return skipped('the repository has no TypeScript of its own (node_modules/typescript): its type check cannot run');

  const realpath = (p: string): string => fence.host.realpath(p);
  const relOf = (abs: string): string => toPosix(path.relative(absRoot, abs));
  /** The spelling `names` give the file `abs` (same base name, same real path), or undefined. */
  const spelled = (names: Iterable<string>, abs: string): string | undefined => {
    const base = path.basename(abs);
    let real: string | undefined;
    for (const n of names) {
      if (path.basename(n) !== base) continue;
      if (n === abs) return n;
      real ??= realpath(abs);
      if (realpath(n) === real) return n;
    }
    return undefined;
  };

  const deadline = performance.now() + budgetMs;
  /**
   * Past the deadline the check is cancelled: here after each project's program is built (the step nothing
   * else interrupts), and inside type checking by the cancellation token.
   */
  const inTime = (): void => {
    if (performance.now() > deadline) throw new ts.OperationCanceledException();
  };
  // One read and hash per file per check, however many projects' programs contain it.
  const versions = new Map<string, string>();
  const used = new Set<Service>();
  const serviceOf = (p: Project): Service => {
    let svc = entry.projects.get(p.config);
    const options = repoCompilerOptions(p.parsed.options, major);
    if (svc === undefined) {
      // A project may spell its files through the checkout's real path: those are the repository's files too.
      svc = createService(absRoot, [...new Set([absRoot, realpath(absRoot)])], options, fence, entry.budget);
      entry.projects.set(p.config, svc);
    }
    if (!used.has(svc)) {
      used.add(svc);
      svc.state.options = options;
      svc.state.roots = [...p.parsed.fileNames];
      svc.state.versions = versions;
      svc.state.deadline = deadline;
    }
    return svc;
  };

  const errors: string[] = [];
  const project: string[] = [];
  const covered = new Set<string>();
  try {
    // Which projects compile each file, as `tsc -p` of each does: every project whose program contains it,
    // whether the project lists it (files/include) or one of its files imports it (a src/ file the app project
    // lists AND the test project imports is checked under both). The repository's type check runs every
    // project, so an error under any of them counts; the same error under two of them is one line.
    const owned: Array<{ svc: Service; config: string; list: Array<{ name: string; rel: string }> }> = [];
    for (const p of found.projects) {
      const svc = serviceOf(p);
      const program = svc.ls.getProgram();
      inTime();
      if (program === undefined) continue;
      const names = program.getSourceFiles().map((s) => s.fileName);
      const list: Array<{ name: string; rel: string }> = [];
      for (const f of files) {
        const name = spelled(names, f);
        if (name === undefined) continue;
        list.push({ name, rel: relOf(f) });
        covered.add(f);
      }
      if (list.length > 0) owned.push({ svc, config: relOf(p.config), list });
    }
    for (const { svc, config, list } of owned) {
      for (const d of svc.ls.getCompilerOptionsDiagnostics()) {
        if (d.category !== ts.DiagnosticCategory.Error) continue;
        const first = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] ?? '';
        project.push(errorLine(d.file !== undefined ? relOf(d.file.fileName) : config, { ...d, messageText: first }));
      }
      for (const { name, rel } of list) errors.push(...fileErrors(svc.ls, name, () => rel));
    }
  } catch (e) {
    if (e instanceof ts.OperationCanceledException) return overran(entry.budget);
    throw e;
  } finally {
    for (const svc of used) svc.state.deadline = null;
  }
  entry.budget.overruns = 0;
  const uncovered = files.filter((f) => !covered.has(f)).map(relOf).sort();
  return { errors: [...new Set(errors)], project: [...new Set(project)], uncovered, skipped: null };
}

/** Project-level lines not yet recorded in this run (marks them recorded). */
function firstTimeInRun(state: RunState, lines: string[]): string[] {
  const v = state.scratch.get(NOTED_KEY);
  const noted = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const fresh = lines.filter((l) => !noted.has(l));
  if (fresh.length > 0) state.scratch.set(NOTED_KEY, [...noted, ...fresh].sort());
  return fresh;
}

/** The record note for a list of error lines (at most MAX_LINES lines), or null when there are none. */
export function formatNote(errors: string[]): string | null {
  if (errors.length === 0) return null;
  const shown = errors.slice(0, MAX_LINES);
  const lines = shown.map((e, i) => (i === 0 ? `tsc: ${errors.length} error(s): ${e}` : `  ${e}`));
  if (errors.length > shown.length) lines[lines.length - 1] += ` (+${errors.length - shown.length} more)`;
  return lines.join('\n');
}

const OFF_NOTE = `typecheck feedback is off for this run: checks took longer than ${BUDGET_MS} ms`;

export default defineHook({
  name: 'typecheck-feedback',
  description: 'Records type errors of the files a write produced (post-tool, in-process, time-boxed; never blocks).',
  events: ['post_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'post_tool' || !event.result.ok) return { decision: 'pass' };
    try {
      const root = ctx.workspace.root;
      const inPlace = writesInPlace(ctx);
      const off = (): boolean => (inPlace ? inPlaceRoots.get(path.resolve(root))?.budget.off : services.get(root)?.budget.off) === true;
      if (off()) return { decision: 'pass' };
      const files: string[] = [];
      for (const p of event.call.paths) {
        const r = toApiRel(ctx.workspace, p);
        if (!r.ok || !TS_FILE.test(r.rel) || /\.d\.[cm]?ts$/.test(r.rel)) continue;
        const abs = path.join(root, r.rel);
        if (existsSync(abs) && !files.includes(abs)) files.push(abs);
      }
      if (files.length === 0) return { decision: 'pass' };
      let errors: string[] | null;
      if (inPlace) {
        const r = checkInPlace(root, files);
        errors = r === null ? null : [...firstTimeInRun(ctx.state, r.project), ...r.errors];
      } else {
        errors = checkFiles(root, files);
      }
      if (errors === null) return off() ? { decision: 'record', note: OFF_NOTE } : { decision: 'pass' };
      const note = formatNote(errors);
      return note === null ? { decision: 'pass' } : { decision: 'record', note };
    } catch {
      return { decision: 'pass' }; // feedback only: a failure to check never blocks or breaks a write
    }
  },
});
