/**
 * App entry discovery, harness side: reads files only, runs nothing. Produces the ordered list of
 * modules the probe runtime (probe-runtime.ts) imports to find the API's HTTP app:
 *   1. an explicit entry (passed in, e.g. from the task, then the `entry` of harness.template.json);
 *   2. the usual entry files: src/{app,index,server,main}.ts, the same under tsconfig rootDir, then
 *      {app,index,server,main}.ts at the API root;
 *   3. what package.json names: "main", "exports" ("."), and the file run by scripts start/dev/serve,
 *      each mapped from built JavaScript (dist/x.js) back to its TypeScript source (src/x.ts).
 * The runtime then tries each module's exports (factory, app instance, default export) and, as a
 * last resort, captures a server the module starts itself with listen().
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { programFile } from './api-ast.ts';

/** An app entry: a module (API-relative) and optionally the export that builds or holds the app. */
export interface AppEntry {
  module: string;
  export?: string;
}

export interface EntryCandidate extends AppEntry {
  /** Why this module is a candidate (shown in findings). */
  why: string;
  /** Exported functions whose declared return type has listen() (called with no arguments). */
  typedExports?: string[];
}

export interface EntryDiscovery {
  candidates: EntryCandidate[];
  /** The conventional entry files looked for (for the UNPROVEN reason). */
  searched: string[];
  /** Declared entries (explicit, manifest, package.json) without a TypeScript source. */
  missing: string[];
}

/** Template / API manifest that may declare `entry`. */
export const ENTRY_MANIFEST = 'harness.template.json';

const ENTRY_NAMES = ['app', 'index', 'server', 'main'];
const TS_EXTS = ['.ts', '.mts', '.cts'];
const JS_TO_TS: Record<string, string> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };
/** Usual build output folders, mapped back to the source root when tsconfig names none. */
const OUT_DIRS = ['dist', 'build', 'out'];
const RUN_SCRIPTS = ['start', 'dev', 'serve'];

const EntrySchema = z.union([
  z.string().min(1),
  z.object({ module: z.string().min(1), export: z.string().min(1).optional() }),
]);

/** `{module, export?}` or "module#export" → AppEntry; anything else → undefined. */
export function parseEntry(raw: unknown): AppEntry | undefined {
  const r = EntrySchema.safeParse(raw);
  if (!r.success) return undefined;
  if (typeof r.data !== 'string') return r.data.export === undefined ? { module: r.data.module } : { module: r.data.module, export: r.data.export };
  const [module = '', exp] = r.data.split('#');
  if (module === '') return undefined;
  return exp === undefined || exp === '' ? { module } : { module, export: exp };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `entry` declared by <root>/harness.template.json (copied in by the scaffold), if any. */
export function manifestEntry(root: string): AppEntry | undefined {
  const file = join(root, ENTRY_MANIFEST);
  if (!existsSync(file)) return undefined;
  const json = readJson(file);
  return isRecord(json) ? parseEntry(json['entry']) : undefined;
}

/** API-relative posix path inside the root, or undefined for absolute paths and `..` escapes. */
function insideRoot(p: string): string | undefined {
  if (p.trim() === '' || isAbsolute(p)) return undefined;
  const rel = posix.normalize(p.replaceAll('\\', '/')).replace(/^\.\//, '').replace(/\/$/, '');
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../')) return undefined;
  return rel;
}

interface Layout {
  /** Source root from tsconfig (rootDir), '' when unset. */
  rootDir: string;
  /** Build output folder from tsconfig (outDir), '' when unset. */
  outDir: string;
}

function tsLayout(root: string): Layout {
  const file = join(root, 'tsconfig.json');
  if (!existsSync(file)) return { rootDir: '', outDir: '' };
  const read = ts.readConfigFile(file, (p) => ts.sys.readFile(p));
  const opts: unknown = isRecord(read.config) ? read.config['compilerOptions'] : undefined;
  const pick = (k: string): string => {
    const v = isRecord(opts) ? opts[k] : undefined;
    return typeof v === 'string' ? (insideRoot(v) ?? '') : '';
  };
  return { rootDir: pick('rootDir'), outDir: pick('outDir') };
}

function isFile(root: string, rel: string): boolean {
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * The TypeScript source behind a path package.json or a script names: `x.ts` as is, `x.js` → `x.ts`,
 * `x` → `x.ts` / `x/index.ts`, and a build-output prefix (tsconfig outDir, else dist/build/out)
 * swapped for the source root (tsconfig rootDir, else src). Declaration files never count.
 */
export function tsSourceOf(root: string, path: string, layout: Layout = tsLayout(root)): string | undefined {
  const rel = insideRoot(path);
  if (rel === undefined || rel.endsWith('.d.ts')) return undefined;
  const ext = posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  const js = JS_TO_TS[ext];
  const direct = TS_EXTS.includes(ext) ? [rel] : js !== undefined ? [stem + js] : ext === '' ? [`${rel}.ts`, `${rel}/index.ts`] : [];
  const srcRoot = layout.rootDir !== '' ? layout.rootDir : 'src';
  const outs = layout.outDir !== '' ? [layout.outDir] : OUT_DIRS;
  const mapped = direct.flatMap((p) => outs.filter((o) => p.startsWith(`${o}/`)).map((o) => `${srcRoot}/${p.slice(o.length + 1)}`));
  return [...direct, ...mapped].find((p) => isFile(root, p));
}

/** Files a shell command runs: tokens that look like script paths (`tsx watch src/index.ts`, `node dist/server.js`). */
export function scriptFiles(command: string): string[] {
  return command
    .split(/[\s;&|]+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter((t) => !t.startsWith('-') && /\.[cm]?[jt]s$/.test(t) && !t.endsWith('.d.ts'));
}

/** Targets of package.json "exports" for the package root (".", or a bare string / condition map). */
function exportTargets(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(exportTargets);
  if (!isRecord(v)) return [];
  const keys = Object.keys(v);
  if (keys.some((k) => k.startsWith('.'))) return exportTargets(v['.']);
  return keys.filter((k) => k !== 'types').flatMap((k) => exportTargets(v[k]));
}

/** Ordered, de-duplicated candidate modules (see the file comment). */
export function discoverEntries(root: string, explicit?: AppEntry): EntryDiscovery {
  const layout = tsLayout(root);
  const candidates: EntryCandidate[] = [];
  const missing: string[] = [];
  const add = (path: string, why: string, exp?: string): void => {
    const module = tsSourceOf(root, path, layout);
    if (module === undefined) {
      missing.push(`${path} (${why})`);
      return;
    }
    const prior = candidates.find((c) => c.module === module);
    if (prior !== undefined) {
      if (prior.export === undefined && exp !== undefined) prior.export = exp;
      return;
    }
    candidates.push(exp === undefined ? { module, why } : { module, why, export: exp });
  };
  if (explicit !== undefined) add(explicit.module, 'explicit entry', explicit.export);
  const declared = manifestEntry(root);
  if (declared !== undefined) add(declared.module, `entry in ${ENTRY_MANIFEST}`, declared.export);
  const searched: string[] = [];
  for (const dir of new Set(['src', layout.rootDir, ''])) {
    for (const name of ENTRY_NAMES) {
      const stem = dir === '' ? name : `${dir}/${name}`;
      searched.push(`${stem}.ts`);
      for (const ext of TS_EXTS) if (isFile(root, stem + ext)) add(stem + ext, 'conventional entry file');
    }
  }
  const pkg = readJson(join(root, 'package.json'));
  if (isRecord(pkg)) {
    if (typeof pkg['main'] === 'string') add(pkg['main'], 'package.json "main"');
    for (const t of exportTargets(pkg['exports'])) add(t, 'package.json "exports"');
    const scripts = pkg['scripts'];
    for (const name of RUN_SCRIPTS) {
      const cmd = isRecord(scripts) ? scripts[name] : undefined;
      if (typeof cmd === 'string') for (const f of scriptFiles(cmd)) add(f, `package.json scripts.${name}`);
    }
  }
  return { candidates, searched, missing };
}

/** Whether `type` (or what it resolves to when awaited) has a callable listen member. */
function listensType(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): boolean {
  const t = checker.getAwaitedType(type) ?? type;
  const sym = checker.getApparentType(t).getProperty('listen');
  return sym !== undefined && checker.getTypeOfSymbolAtLocation(sym, at).getCallSignatures().length > 0;
}

/**
 * Per candidate module in `program`, the exported functions whose declared return type has listen()
 * (an Express app, an http.Server, …): "any exported function returning an app", by type, so the
 * runtime does not have to call unrelated exports to find out.
 */
export function annotateTypedExports(program: ts.Program, root: string, candidates: EntryCandidate[]): void {
  const checker = program.getTypeChecker();
  for (const c of candidates) {
    const sf = programFile(program, root, c.module);
    const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
    if (sf === undefined || mod === undefined) continue;
    const names: string[] = [];
    for (const exp of checker.getExportsOfModule(mod)) {
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      const sigs = checker.getTypeOfSymbolAtLocation(sym, sf).getCallSignatures();
      if (sigs.some((s) => listensType(checker, s.getReturnType(), sf))) names.push(exp.getName());
    }
    if (names.length > 0) c.typedExports = names;
  }
}

/** One line naming everything discovery looked at (for an UNPROVEN reason). */
export function describeSearch(d: EntryDiscovery): string {
  const extra = d.missing.length > 0 ? `; declared but without a TypeScript source: ${d.missing.join(', ')}` : '';
  return `none of ${d.searched.join(', ')} exists and package.json names no main/exports/start script file${extra}`;
}
