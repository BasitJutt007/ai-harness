/**
 * typecheck-feedback (post, write): after a successful write, a fast in-process syntax + type check
 * of just the written TypeScript file(s) with the TypeScript language service, under the options the
 * tsc-strict check forces (fileCheckOptions: the API's tsconfig.json with every strict flag on). Its
 * errors are RECORDED on the tool result the model sees, at most 3 lines:
 *   tsc: <n> error(s): src/a.ts:3:7 TS2322 Type 'string' is not assignable to type 'number'.
 *
 * It only ever passes or records: it never blocks (errors are normal in the middle of a change; the
 * gates decide at finish) and never writes a file (the language service only reads). The service is
 * kept per API root, so after the first check only changed files are re-parsed. A check still running
 * after BUDGET_MS is cancelled and skipped, so it never slows a run down by more than that; after
 * MAX_OVERRUNS cancelled checks in a row the hook stays off for that API root (noted once).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createTsFence, defineHook, fileCheckOptions } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';

/** Time budget of one check: a check still running at the deadline is cancelled and its result skipped. */
export const BUDGET_MS = 1500;
/** Cancelled checks in a row after which the hook stays off for the API root. */
export const MAX_OVERRUNS = 2;
/** API roots whose language service is kept warm (the least recently used is dropped). */
const MAX_SERVICES = 3;
const MAX_LINES = 3;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;

/** What the language service host reports, per check. */
interface CheckState {
  /** Root names of the current check: the written files. */
  roots: string[];
  /** Script versions memoised for one check: the content hash of each file inside the API root. */
  versions: Map<string, string>;
  /** performance.now() after which the current check is cancelled; null between checks. */
  deadline: number | null;
  overruns: number;
  off: boolean;
}

interface Service {
  ls: ts.LanguageService;
  state: CheckState;
}

const documents = ts.createDocumentRegistry();
const services = new Map<string, Service>();

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules');
}

function serviceFor(root: string): Service {
  const known = services.get(root);
  if (known !== undefined) {
    services.delete(root); // re-insert: most recently used last
    services.set(root, known);
    return known;
  }
  const options = fileCheckOptions(root);
  // Agent code steers what this program reads (imports, tsconfig paths): every read goes through the same
  // fence as the other in-process programs, so a file outside the API's tree reads as absent.
  const fence = createTsFence(root);
  const read = (f: string): string | undefined => (fence.allows(f) ? fence.host.readFile(f) : undefined);
  const state: CheckState = { roots: [], versions: new Map(), deadline: null, overruns: 0, off: false };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => state.roots,
    getScriptVersion: (f) => {
      if (!inside(root, f)) return '0'; // libraries and node_modules do not change during a run
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
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    getCancellationToken: () => ({ isCancellationRequested: () => state.deadline !== null && performance.now() > state.deadline }),
    fileExists: (f) => fence.host.fileExists(f),
    readFile: (f) => read(f),
    readDirectory: (dir, extensions, exclude, include, depth) => [...fence.host.readDirectory(dir, extensions ?? [], exclude, include ?? [], depth)],
    directoryExists: (d) => fence.host.directoryExists(d),
    getDirectories: (d) => fence.host.getDirectories(d),
    realpath: (p) => fence.host.realpath(p),
  };
  const svc: Service = { ls: ts.createLanguageService(host, documents), state };
  services.set(root, svc);
  for (const [k, old] of services) {
    if (services.size <= MAX_SERVICES) break;
    old.ls.dispose();
    services.delete(k);
  }
  return svc;
}

/** Errors of `files` (absolute, inside `root`) as `rel:line:col TSxxxx message` lines; null when the check ran out of time. */
export function checkFiles(root: string, files: string[], budgetMs = BUDGET_MS): string[] | null {
  const svc = serviceFor(root);
  const { state } = svc;
  state.roots = files;
  state.versions.clear();
  state.deadline = performance.now() + budgetMs;
  const out: string[] = [];
  try {
    for (const f of files) {
      for (const d of [...svc.ls.getSyntacticDiagnostics(f), ...svc.ls.getSemanticDiagnostics(f)]) {
        if (d.category !== ts.DiagnosticCategory.Error) continue;
        const where = d.file !== undefined && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const rel = path.relative(root, d.file?.fileName ?? f).split(path.sep).join('/');
        const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').replace(/\s+/g, ' ');
        out.push(`${rel}${where !== undefined ? `:${where.line + 1}:${where.character + 1}` : ''} TS${d.code} ${msg.length > 160 ? `${msg.slice(0, 159)}…` : msg}`);
      }
    }
  } catch (e) {
    if (e instanceof ts.OperationCanceledException) {
      state.overruns += 1;
      if (state.overruns >= MAX_OVERRUNS) state.off = true;
      return null;
    }
    throw e;
  } finally {
    state.deadline = null;
  }
  state.overruns = 0;
  return out;
}

/** The record note for a list of error lines (at most MAX_LINES lines), or null when there are none. */
export function formatNote(errors: string[]): string | null {
  if (errors.length === 0) return null;
  const shown = errors.slice(0, MAX_LINES);
  const lines = shown.map((e, i) => (i === 0 ? `tsc: ${errors.length} error(s): ${e}` : `  ${e}`));
  if (errors.length > shown.length) lines[lines.length - 1] += ` (+${errors.length - shown.length} more)`;
  return lines.join('\n');
}

export default defineHook({
  name: 'typecheck-feedback',
  description: 'Records type errors of the files a write produced (post-tool, in-process, time-boxed; never blocks).',
  events: ['post_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'post_tool' || !event.result.ok) return { decision: 'pass' };
    try {
      const root = ctx.workspace.root;
      if (services.get(root)?.state.off === true) return { decision: 'pass' };
      const files: string[] = [];
      for (const p of event.call.paths) {
        const r = toApiRel(ctx.workspace, p);
        if (!r.ok || !TS_FILE.test(r.rel) || /\.d\.[cm]?ts$/.test(r.rel)) continue;
        const abs = path.join(root, r.rel);
        if (existsSync(abs) && !files.includes(abs)) files.push(abs);
      }
      if (files.length === 0) return { decision: 'pass' };
      const errors = checkFiles(root, files);
      if (errors === null) {
        return services.get(root)?.state.off === true
          ? { decision: 'record', note: `typecheck feedback is off for this run: checks took longer than ${BUDGET_MS} ms` }
          : { decision: 'pass' };
      }
      const note = formatNote(errors);
      return note === null ? { decision: 'pass' } : { decision: 'record', note };
    } catch {
      return { decision: 'pass' }; // feedback only: a failure to check never blocks or breaks a write
    }
  },
});
