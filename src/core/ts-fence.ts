/**
 * The read fence of the TypeScript programs the harness builds IN-PROCESS over agent-controlled code:
 * the strict type check behind ctx.program() and tsc-strict (typecheck.ts), Contract Lock's program
 * (plugins/lib/contract.ts) and the tsconfig reads around them. They run in the harness's own process,
 * outside the OS sandbox (sandbox.ts), yet the agent controls tsconfig.json (`paths`, `extends`,
 * `files`, `include`, `typeRoots`, `references`) and every import, so an unfenced program could be
 * made to read any file the harness can read and quote it in a diagnostic the model sees.
 *
 * Every file-system call a program, a module resolution or a tsconfig parse makes goes through the
 * fenced host: fileExists, readFile, directoryExists, getDirectories, readDirectory, realpath and
 * getSourceFile behave as if a path outside the allow-list did not exist. Allowed, as the OS fence
 * allows them (sandbox.ts readFence):
 *   - the tree the API lives in: the API root, or the run's worktree root (sandbox.ts enclosingRoot);
 *   - every node_modules found walking up from the API root, under both spellings (link and realpath),
 *     plus the packages symlinked into them from elsewhere (workspace packages);
 *   - the TypeScript lib directory.
 * A path is allowed only when it lies under an allowed root as written AND its realpath does too, so
 * a symlink cannot lead out. Refused paths that exist are remembered (refused()) for the run log; their
 * content is never read. The host never writes, never traces and reads no environment variable.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { enclosingRoot, linkedPackages, realpathLoose } from './sandbox.ts';

export interface TsFence {
  /** The API root the fence was derived from (absolute). */
  readonly root: string;
  /** Readable roots (absolute), every one under each of its spellings. */
  readonly roots: readonly string[];
  /** Whether a program may see `path` (a file or a directory; relative paths are taken from the API root). */
  allows(path: string): boolean;
  /** Existing paths a program asked for and was refused (absolute, sorted). */
  refused(): string[];
  /** Module resolution and tsconfig parse host (ts.sys, fenced). */
  readonly host: FencedSys;
  /** A tsconfig parse host (fenced) that reports unrecoverable config errors to `onDiagnostic`. */
  parseConfigHost(onDiagnostic: (d: ts.Diagnostic) => void): ts.ParseConfigFileHost;
  /** A compiler host for `options` whose every read is fenced. */
  compilerHost(options: ts.CompilerOptions): ts.CompilerHost;
  /** ts.createProgram over the fenced compiler host. */
  createProgram(rootNames: readonly string[], options: ts.CompilerOptions): ts.Program;
}

/** The fenced subset of ts.sys a module resolution or a tsconfig parse needs. */
export interface FencedSys extends ts.ParseConfigHost {
  directoryExists(path: string): boolean;
  getDirectories(path: string): string[];
  realpath(path: string): string;
  getCurrentDirectory(): string;
}

interface Entries {
  files: readonly string[];
  directories: readonly string[];
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => Entries,
  realpath: (path: string) => string,
) => string[];

/**
 * TypeScript's own include/exclude matcher. It is internal (looked up at run time), and it walks only
 * the directories getFileSystemEntries lists, so a pattern outside the fence walks nothing. Without
 * it, ts.sys.readDirectory is used and its results are filtered.
 */
const matchFiles: MatchFiles | undefined = (() => {
  const fn: unknown = (ts as unknown as Record<string, unknown>)['matchFiles'];
  return typeof fn === 'function' ? (fn as MatchFiles) : undefined;
})();

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** realpath with the platform's canonical spelling (case on macOS), of p or its nearest existing ancestor. */
function nativeRealpathLoose(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** Every spelling of p: as written, its realpath and its canonical realpath. */
function spellings(p: string): string[] {
  return [...new Set([resolve(p), realpathLoose(p), nativeRealpathLoose(p)])];
}

/** Every ancestor of p, nearest first, up to and including the filesystem root. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = dirname(p);
  for (;;) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/** Every existing node_modules directory in `dir` or one of its ancestors, nearest first. */
function nodeModulesUp(dir: string): string[] {
  const out: string[] = [];
  let cur = resolve(dir);
  for (;;) {
    const nm = join(cur, 'node_modules');
    try {
      if (statSync(nm).isDirectory()) out.push(nm);
    } catch {
      // none here
    }
    const up = dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/** The directory of TypeScript's own lib.*.d.ts files. */
export function typescriptLibDir(): string {
  return dirname(ts.getDefaultLibFilePath({}));
}

/** The read allow-list of programs over the API at `apiRoot` (see the file comment). */
export function fenceRoots(apiRoot: string): string[] {
  const roots: string[] = [];
  const nodeModules = new Set<string>();
  for (const s of spellings(apiRoot)) {
    roots.push(...spellings(enclosingRoot(s)));
    for (const nm of nodeModulesUp(s)) nodeModules.add(nm);
  }
  for (const nm of nodeModules) roots.push(...spellings(nm));
  for (const real of new Set([...nodeModules].map((nm) => realpathLoose(nm)))) {
    for (const pkg of linkedPackages(real)) roots.push(...spellings(pkg));
  }
  roots.push(...spellings(typescriptLibDir()));
  return [...new Set(roots)];
}

/** The fence for programs over the API at `apiRoot`. */
export function createTsFence(apiRoot: string): TsFence {
  const root = resolve(apiRoot);
  const roots = fenceRoots(root);
  const refusedPaths = new Set<string>();
  const verdicts = new Map<string, boolean>();
  const within = (p: string): boolean => roots.some((r) => inside(p, r));

  const allows = (path: string): boolean => {
    const abs = resolve(root, path);
    const known = verdicts.get(abs);
    if (known !== undefined) return known;
    // As written, then as it really is (a symlink inside the tree must not lead out of it).
    const ok = within(abs) && within(nativeRealpathLoose(abs));
    verdicts.set(abs, ok);
    if (!ok && exists(abs)) refusedPaths.add(abs);
    return ok;
  };

  // The ancestors of an allowed root may be tested for existence (as the OS fence lets them be stat()ed),
  // never listed: the compiler probes them when it looks for a missing file.
  const ancestorDirs = new Set(roots.flatMap(ancestors));
  const fileExists = (f: string): boolean => allows(f) && ts.sys.fileExists(f);
  const readFile = (f: string): string | undefined => (allows(f) ? ts.sys.readFile(f) : undefined);
  const directoryExists = (d: string): boolean => (ancestorDirs.has(resolve(root, d)) || allows(d)) && ts.sys.directoryExists(d);
  const getDirectories = (d: string): string[] => (allows(d) ? ts.sys.getDirectories(d).filter((n) => allows(join(d, n))) : []);
  const realpath = (p: string): string => (allows(p) && ts.sys.realpath !== undefined ? ts.sys.realpath(p) : p);

  const entries = (dir: string): Entries => {
    const files: string[] = [];
    const directories: string[] = [];
    if (!allows(dir)) return { files, directories };
    let list: Dirent[];
    try {
      list = readdirSync(resolve(root, dir), { withFileTypes: true });
    } catch {
      return { files, directories };
    }
    for (const d of list) {
      const p = join(resolve(root, dir), d.name);
      let isFile = d.isFile();
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        if (!allows(p)) continue;
        try {
          const st = statSync(p);
          isFile = st.isFile();
          isDir = st.isDirectory();
        } catch {
          continue; // dangling link
        }
      }
      if (isFile) files.push(d.name);
      else if (isDir) directories.push(d.name);
    }
    return { files, directories };
  };
  const readDirectory = (dir: string, extensions: readonly string[] | undefined, excludes: readonly string[] | undefined, includes: readonly string[] | undefined, depth?: number): string[] =>
    matchFiles !== undefined
      ? matchFiles(dir, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, root, depth, entries, realpath)
      : ts.sys.readDirectory(dir, extensions, excludes, includes, depth).filter(allows);

  const host: FencedSys = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists,
    readFile,
    directoryExists,
    getDirectories,
    realpath,
    readDirectory,
    getCurrentDirectory: () => root,
  };

  const compilerHost = (options: ts.CompilerOptions): ts.CompilerHost => {
    const h = ts.createCompilerHost(options);
    const getSourceFile = h.getSourceFile;
    // Replaced in place: the base host's own getSourceFile reads through h.readFile.
    h.getSourceFile = (fileName, language, onError, create) => (allows(fileName) ? getSourceFile(fileName, language, onError, create) : undefined);
    h.fileExists = fileExists;
    h.readFile = readFile;
    h.directoryExists = directoryExists;
    h.getDirectories = getDirectories;
    h.realpath = realpath;
    h.readDirectory = readDirectory;
    h.getCurrentDirectory = () => root;
    h.trace = () => undefined;
    h.getEnvironmentVariable = () => '';
    h.writeFile = () => {
      throw new Error('the fenced compiler host never writes');
    };
    return h;
  };

  return {
    root,
    roots,
    allows,
    refused: () => [...refusedPaths].sort(),
    host,
    parseConfigHost: (onDiagnostic) => ({ ...host, onUnRecoverableConfigFileDiagnostic: onDiagnostic }),
    compilerHost,
    createProgram: (rootNames, options) => ts.createProgram({ rootNames, options, host: compilerHost(options) }),
  };
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
