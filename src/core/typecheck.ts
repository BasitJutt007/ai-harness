/**
 * The API's type check, shared by the check context (`ctx.program()`) and the tsc-strict rule.
 *
 * Whatever the API's tsconfig says, every TypeScript file of the API is checked under the strict set:
 * - options: every strict-family flag, noUncheckedIndexedAccess, noEmit and `noCheck: false` are forced
 *   one by one over the API's own (an explicit `"strictNullChecks": false` or `"noCheck": true` cannot win).
 *   `rootDir` (emit layout only; it rejects files outside it) is dropped, option deprecations of the
 *   harness's newer TypeScript are silenced, and an unset `types` keeps the pre-6.0 default (every
 *   visible @types package), so a config written for an older compiler is not failed for its age.
 * - projects: tsconfig.json, every project it references (recursively), then the other tsconfig.*.json
 *   at the API root. A file is checked by the first project that lists it; a file no project lists
 *   (tests outside `include`, config files, a solution-style root) is checked with the primary
 *   project's options.
 * - files: every .ts/.tsx/.mts/.cts and every own .d.ts under the API root (not node_modules, build
 *   output, or a .d.ts that describes a sibling file), plus any such file a program loads from inside
 *   the API, wherever it lives.
 * - no tsconfig.json: the first default (NodeNext, then Bundler) under which no error depends on
 *   module, lib or ambient-type settings; if none, those errors are UNPROVEN, never code errors.
 * - an unusable configuration (unparsable, a missing `extends` or reference, invalid options) and a
 *   dependency that package.json declares but the type checker cannot resolve are problems: the result
 *   is UNPROVEN, never a pass and never an error blamed on the code.
 * - reads: every program, module resolution and tsconfig parse goes through the read fence of
 *   ts-fence.ts (the API's tree, its node_modules, the TypeScript libs). A file outside it does not
 *   exist for the type check: an import of it does not resolve, an `extends`, reference or `files`
 *   entry naming it makes the configuration unusable, and its content never reaches a diagnostic.
 */
import { existsSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { globSync } from 'tinyglobby';
import ts from 'typescript';
import { createTsFence } from './ts-fence.ts';
import type { TsFence } from './ts-fence.ts';
import type { CheckContext } from './types.ts';

/** Strict-family flags forced on, each one explicitly: an explicit `false` in a tsconfig beats `strict: true`. */
export const FORCED_STRICT = {
  strict: true,
  noImplicitAny: true,
  strictNullChecks: true,
  strictFunctionTypes: true,
  strictBindCallApply: true,
  strictPropertyInitialization: true,
  strictBuiltinIteratorReturn: true,
  noImplicitThis: true,
  useUnknownInCatchVariables: true,
  alwaysStrict: true,
  noUncheckedIndexedAccess: true,
} as const satisfies ts.CompilerOptions;

/** The forced set as tsc flags (for docs and logs). */
export const FORCED_FLAGS = [...Object.keys(FORCED_STRICT), 'noEmit'].map((k) => `--${k}`).join(' ');

const TS_MAJOR = Number(ts.versionMajorMinor.split('.')[0]);
/** "No inputs were found in config file": every API file is checked anyway, so an empty `include` is not a problem. */
const NO_INPUTS = 18003;
const ROOT_CONFIG = 'tsconfig.json';
/** Why a configuration naming a file outside the read fence cannot be used. */
const OUTSIDE = "outside the API's tree, which the type check does not read (it reads the API, its node_modules and the TypeScript libs)";
/** File names listed per log line at most. */
const LOG_FILES = 20;
const SIBLING_CONFIG = /^tsconfig\..+\.json$/i;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const DISCOVER = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
/** Never source: dependencies and the usual build/coverage output folders (a file a program loads from one still counts). */
const SKIP_DIRS = ['node_modules', 'dist', 'build', 'coverage'];
/** Module could not be resolved (2307, 2792) / has no declaration file (7016): an environment gap when package.json declares it. */
const UNRESOLVED = new Set([2307, 2792, 7016]);
const NO_TYPES = 7016;
/** "Cannot find name" (2304) and its "install type definitions for node / a test runner" forms. */
const CANNOT_FIND_NAME = new Set([2304, 2580, 2582, 2591, 2593]);
const TYPES_SCOPE = '@types/';

type Classified = { kind: 'error' | 'types' | 'dependent' } | { kind: 'missing'; pkg: string };
/**
 * Errors that depend on module, lib or ambient-type settings rather than on the code. Only consulted
 * when the harness had to pick the options itself (no tsconfig.json).
 */
const SETTINGS_DEPENDENT = new Set([
  1202, 1203, 1259, 1323, 1343, 1378, 1432, 1470, 1479, // module format and interop
  2307, 2497, 2732, 2792, 2834, 2835, 5097, // module resolution
  2318, 2550, 2583, 2584, 2585, // lib
  2580, 2582, 2591, 2593, 7016, // ambient types
]);

const DEFAULT_BASE: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  lib: ['lib.esnext.d.ts'],
  esModuleInterop: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  forceConsistentCasingInFileNames: true,
};
/** The harness's options when the API has no tsconfig.json, tried in order. */
const DEFAULTS: ReadonlyArray<{ name: string; options: ts.CompilerOptions }> = [
  { name: 'NodeNext', options: { ...DEFAULT_BASE, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } },
  { name: 'Bundler', options: { ...DEFAULT_BASE, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler } },
];

/** The API's options with the strict set forced and emit-only constraints removed. */
export function forceStrict(options: ts.CompilerOptions): ts.CompilerOptions {
  const out: ts.CompilerOptions = {
    ...options,
    ...FORCED_STRICT,
    noEmit: true,
    noCheck: false,
    // Only the API's own files are diagnosed, so this checks its .d.ts files without checking node_modules.
    skipLibCheck: false,
    ignoreDeprecations: `${TS_MAJOR}.0`,
  };
  delete out.rootDir;
  if (out.types === undefined && TS_MAJOR >= 6) out.types = ['*'];
  return out;
}

export interface TsProject {
  /** API-relative tsconfig path ("../x.json" outside the API); null for the harness's defaults (no tsconfig.json). */
  config: string | null;
  /** Its options with the strict set forced. */
  options: ts.CompilerOptions;
  /** Absolute paths the config lists (its `files`/`include`), as TypeScript resolves them. */
  listed: readonly string[];
}

export interface TypeDiagnostic {
  /** API-relative file; null for a whole-program error. */
  file: string | null;
  /** "file:line:col", or "(project)". */
  location: string;
  /** "TS2322: first line of the message". */
  message: string;
}

export interface TypecheckResult {
  /** API-relative files type-checked and to be safety-scanned: found on disk plus loaded by a program (sorted). */
  files: string[];
  /** Errors in the code. Empty when `usable` is false. */
  errors: TypeDiagnostic[];
  /** Why the result is not proof (UNPROVEN); empty when it is. */
  problems: string[];
  /** False when the configuration itself is unusable: type errors and type information mean nothing then. */
  usable: boolean;
  /** The program and source file a checked file was diagnosed in. */
  sourceOf(rel: string): { program: ts.Program; sf: ts.SourceFile } | undefined;
  /** What was checked, and how, for the run log. */
  log: string[];
}

export interface Typecheck {
  readonly root: string;
  /** The read fence every program and tsconfig read of this type check goes through. */
  readonly fence: TsFence;
  /** Projects in ownership order (root, references, sibling configs); empty without a usable tsconfig.json. */
  readonly projects: readonly TsProject[];
  /** API-relative TypeScript files found on disk (sorted). */
  readonly files: readonly string[];
  /** The primary project's options; with no tsconfig.json, the default chosen for the API's imports. */
  options(): ts.CompilerOptions;
  /** Every API file under the primary options: the program the other checks read (cached). */
  primary(): ts.Program;
  /** Diagnose every checked file in its owner's program (cached). */
  result(): TypecheckResult;
}

const registry = new WeakMap<() => ts.Program, () => Typecheck>();

/** Remember the type check behind a context's `program()`, so tsc-strict diagnoses the very program the other checks read. */
export function registerTypecheck(program: () => ts.Program, typecheck: () => Typecheck): void {
  registry.set(program, typecheck);
}

/** The type check of a check context: the shared one behind `ctx.program()`, or a fresh one for `ctx.root`. */
export function typecheckOf(ctx: Pick<CheckContext, 'root' | 'program' | 'dependencies'>): Typecheck {
  return registry.get(ctx.program)?.() ?? createTypecheck(ctx.root, () => ctx.dependencies());
}

/**
 * Cheap options for checking single files of the API (no program is built): the root tsconfig.json's
 * options with the strict set forced, or, without a usable one, the first harness default (NodeNext).
 */
export function fileCheckOptions(root: string): ts.CompilerOptions {
  const absRoot = resolve(root);
  const config = join(absRoot, ROOT_CONFIG);
  const read = existsSync(config) ? readProject(config, (abs) => toPosix(relative(absRoot, abs)), createTsFence(absRoot)) : undefined;
  return read?.project !== undefined && read.problems.length === 0 ? read.project.options : forceStrict(DEFAULTS[0]?.options ?? DEFAULT_BASE);
}

export function createTypecheck(root: string, dependencies: () => Record<string, string> = () => ({})): Typecheck {
  const absRoot = resolve(root);
  const fence = createTsFence(absRoot);
  const rel = (abs: string): string => toPosix(relative(absRoot, abs));
  const inside = (abs: string): boolean => {
    const r = relative(absRoot, abs);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('node_modules');
  };

  // ── configuration ──
  const configProblems: string[] = [];
  const ignored: string[] = [];
  const projects: TsProject[] = [];
  const seen = new Set<string>();
  const visit = (configAbs: string, declared: boolean): void => {
    const key = resolve(configAbs);
    if (seen.has(key)) return;
    seen.add(key);
    const read = readProject(key, rel, fence);
    if (!declared && read.problems.length > 0) {
      ignored.push(...read.problems); // an unreferenced side config is not the API's build: skip it, never fail on it
      return;
    }
    configProblems.push(...read.problems);
    if (read.project !== undefined) projects.push(read.project);
    for (const ref of read.references) visit(ref, declared);
  };
  const hasConfig = existsSync(join(absRoot, ROOT_CONFIG));
  if (hasConfig) {
    visit(join(absRoot, ROOT_CONFIG), true);
    for (const name of siblingConfigs(absRoot)) visit(join(absRoot, name), false);
  }

  // ── files ──
  const outDirs = projects
    .flatMap((p) => [p.options.outDir, p.options.declarationDir])
    .filter((d): d is string => d !== undefined)
    .map((d) => rel(resolve(d)))
    .filter((d) => d !== '' && !d.startsWith('..') && !isAbsolute(d));
  const discovered = existsSync(absRoot)
    ? globSync(DISCOVER, { cwd: absRoot, ignore: [...SKIP_DIRS.map((d) => `**/${d}/**`), ...outDirs.map((d) => `${d}/**`)] })
      .map(toPosix)
      .filter((f) => isOwnTypeScript(join(absRoot, f)))
      .sort()
    : [];
  // A symlink under the API that leads out of its tree is not the API's file: never read, never checked.
  const files = discovered.filter((f) => fence.allows(join(absRoot, f)));
  const kept = new Set(files);
  const fenceProblems = discovered.filter((f) => !kept.has(f)).map((f) => `${f} links to a file ${OUTSIDE}`);
  const fileSet = new Set(files.map((f) => join(absRoot, f)));
  const listedBy = new Map<string, number>();
  projects.forEach((p, i) => {
    for (const f of p.listed) if (!listedBy.has(resolve(f))) listedBy.set(resolve(f), i);
  });
  const primaryIndex = Math.max(0, projects.findIndex((p) => p.listed.some((f) => fileSet.has(resolve(f)))));

  // ── classification ──
  // Declared @types packages the type checker cannot find: "cannot find name" errors are then the environment's.
  let missingTypes: string[] | undefined;
  const missingTypePackages = (): string[] => (missingTypes ??= Object.keys(dependencies())
    .filter((d) => d.startsWith(TYPES_SCOPE))
    .filter((d) => ts.resolveTypeReferenceDirective(d.slice(TYPES_SCOPE.length), join(absRoot, 'index.ts'), {}, fence.host).resolvedTypeReferenceDirective === undefined)
    .sort());
  const classify = (diag: ts.Diagnostic, harnessSettings: boolean): Classified => {
    const pkg = missingDependency(diag, dependencies);
    if (pkg !== null) return { kind: 'missing', pkg };
    if (CANNOT_FIND_NAME.has(diag.code) && missingTypePackages().length > 0) return { kind: 'types' };
    if (harnessSettings && SETTINGS_DEPENDENT.has(diag.code)) return { kind: 'dependent' };
    return { kind: 'error' };
  };

  // ── programs ──
  let chosen: { name: string; project: TsProject; program: ts.Program; dependent: TypeDiagnostic[] } | undefined;
  const chooseDefault = (): NonNullable<typeof chosen> => {
    if (chosen !== undefined) return chosen;
    const rootNames = [...fileSet];
    for (const d of DEFAULTS) {
      const project: TsProject = { config: null, options: forceStrict(d.options), listed: [] };
      const program = fence.createProgram(rootNames, project.options);
      const dependent: TypeDiagnostic[] = [];
      for (const f of rootNames) {
        const sf = program.getSourceFile(f);
        if (sf === undefined) continue;
        for (const diag of fileDiagnostics(program, sf)) {
          if (classify(diag, true).kind === 'dependent') dependent.push(toDiagnostic(diag, absRoot));
        }
      }
      if (chosen === undefined || dependent.length < chosen.dependent.length) chosen = { name: d.name, project, program, dependent };
      if (dependent.length === 0) break;
    }
    if (chosen === undefined) throw new Error('no default compiler options');
    return chosen;
  };
  const primaryProject = (): TsProject => projects[primaryIndex] ?? chooseDefault().project;
  let primary: ts.Program | undefined;
  const primaryProgram = (): ts.Program => {
    if (primary !== undefined) return primary;
    const project = projects[primaryIndex];
    if (project === undefined) {
      primary = chooseDefault().program;
    } else {
      const roots = new Set([...fileSet, ...project.listed.map((f) => resolve(f))]);
      primary = fence.createProgram([...roots], project.options);
    }
    return primary;
  };

  let cached: TypecheckResult | undefined;
  const result = (): TypecheckResult => {
    if (cached !== undefined) return cached;
    const log = [`TypeScript ${ts.version} (in-process), forced: ${FORCED_FLAGS}`];
    if (ignored.length > 0) log.push(`ignored side configs: ${ignored.join('; ')}`);
    if (configProblems.length > 0) {
      log.push(...describeRefused(fence.refused()));
      cached = { files, errors: [], problems: [...configProblems.map((p) => `unusable TypeScript configuration: ${p}`), ...fenceProblems], usable: false, sourceOf: () => undefined, log };
      return cached;
    }
    const programs = new Map<number, ts.Program>();
    const programOf = (i: number): ts.Program => {
      let p = programs.get(i);
      if (p === undefined) {
        const project = projects[i];
        p = i === primaryIndex || project === undefined ? primaryProgram() : fence.createProgram([...project.listed], project.options);
        programs.set(i, p);
      }
      return p;
    };
    const ownerOf = (abs: string): number => listedBy.get(abs) ?? primaryIndex;
    for (const f of fileSet) programOf(ownerOf(f));
    // Everything a program loads from inside the API is checked too, wherever it lives.
    const checked = new Set(files);
    for (const p of programs.values()) {
      for (const sf of p.getSourceFiles()) {
        if (inside(sf.fileName) && isOwnTypeScript(sf.fileName)) checked.add(rel(sf.fileName));
      }
    }

    const problems: string[] = [...fenceProblems];
    const errors: TypeDiagnostic[] = [];
    const dependent: TypeDiagnostic[] = [];
    const unjudgedNames: TypeDiagnostic[] = [];
    const missing = new Map<string, string[]>();
    const sort = (d: TypeDiagnostic, c: Classified): void => {
      if (c.kind === 'missing') missing.set(c.pkg, [...(missing.get(c.pkg) ?? []), d.location]);
      else if (c.kind === 'types') unjudgedNames.push(d);
      else if (c.kind === 'dependent') dependent.push(d);
      else errors.push(d);
    };
    const sources = new Map<string, { program: ts.Program; sf: ts.SourceFile }>();
    const usedPrograms = new Set<ts.Program>();
    const counts = new Map<number, number>();
    const settingsFromHarness = projects[primaryIndex] === undefined;
    for (const file of [...checked].sort()) {
      const abs = join(absRoot, file);
      let owner = ownerOf(abs);
      let program = programOf(owner);
      let sf = program.getSourceFile(abs);
      if (sf === undefined) {
        for (const [i, p] of programs) {
          sf = p.getSourceFile(abs);
          if (sf !== undefined) {
            owner = i;
            program = p;
            break;
          }
        }
      }
      if (sf === undefined) {
        problems.push(`${file} is not part of any program, so it was not type-checked`);
        continue;
      }
      sources.set(file, { program, sf });
      usedPrograms.add(program);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
      for (const diag of fileDiagnostics(program, sf)) sort(toDiagnostic(diag, absRoot), classify(diag, settingsFromHarness));
    }
    let usable = true;
    for (const p of usedPrograms) {
      const where = projectName(projects.find((_, i) => programs.get(i) === p) ?? primaryProject());
      for (const diag of p.getOptionsDiagnostics()) {
        if (diag.category !== ts.DiagnosticCategory.Error) continue;
        usable = false;
        problems.push(`unusable TypeScript configuration: ${where}: TS${diag.code} ${firstLine(diag)}`);
      }
      for (const diag of p.getGlobalDiagnostics()) {
        if (diag.category === ts.DiagnosticCategory.Error) sort(toDiagnostic(diag, absRoot), classify(diag, settingsFromHarness));
      }
    }
    for (const [pkg, where] of missing) {
      problems.push(`'${pkg}' is declared in package.json but the type checker cannot resolve it (${where[0] ?? ''}${more(where.length)}): install or link the API's dependencies`);
    }
    const firstName = unjudgedNames[0];
    if (firstName !== undefined) {
      problems.push(
        `${missingTypePackages().join(', ')} declared in package.json but not installed, so ${unjudgedNames.length} "cannot find name" errors are not judged`
        + ` (${firstName.location} ${firstName.message}${more(unjudgedNames.length)}): install or link the API's dependencies`,
      );
    }
    if (dependent.length > 0) {
      const first = dependent[0];
      problems.push(
        `no tsconfig.json, and under the harness's default options (${chooseDefault().name}) ${dependent.length} errors depend on module/lib settings`
        + `${first !== undefined ? ` (first: ${first.location} ${first.message})` : ''}: add a tsconfig.json to make the type check decidable`,
      );
    }
    const unlisted = [...checked].filter((f) => !listedBy.has(join(absRoot, f))).sort();
    log.push(
      ...describeProjects(projects, primaryIndex, counts, chosen?.name),
      `checked ${checked.size} files (${[...checked].filter((f) => DECLARATION.test(f)).length} declaration files)`,
      ...(projects.length > 0 && unlisted.length > 0
        ? [`listed by no tsconfig, checked with the primary project's options: ${unlisted.slice(0, LOG_FILES).join(', ')}${unlisted.length > LOG_FILES ? `, +${unlisted.length - LOG_FILES} more` : ''}`]
        : []),
      ...describeRefused(fence.refused()),
    );
    cached = {
      files: [...checked].sort(),
      errors: usable ? dedupe(errors) : [],
      problems,
      usable,
      sourceOf: (file) => sources.get(file),
      log,
    };
    return cached;
  };

  return {
    root: absRoot,
    fence,
    projects,
    files,
    options: () => primaryProject().options,
    primary: primaryProgram,
    result,
  };
}

// ───────────────────────────── helpers ─────────────────────────────

function readProject(configAbs: string, rel: (abs: string) => string, fence: TsFence): { project?: TsProject; problems: string[]; references: string[] } {
  const where = rel(configAbs);
  if (!fence.allows(configAbs)) return { problems: [`${where}: ${OUTSIDE}`], references: [] };
  if (!fence.host.fileExists(configAbs)) return { problems: [`${where}: not found`], references: [] };
  const problems: string[] = [];
  const host = fence.parseConfigHost((d) => problems.push(`${where}: TS${d.code} ${firstLine(d)}`));
  const refusedBefore = new Set(fence.refused());
  let parsed: ts.ParsedCommandLine | undefined;
  try {
    parsed = ts.getParsedCommandLineOfConfigFile(configAbs, undefined, host);
  } catch (e) {
    problems.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // An `extends` (or an `include` base) outside the fence reads as missing: say why.
  const refused = fence.refused().filter((p) => !refusedBefore.has(p));
  if (refused.length > 0) problems.push(`${where} refers to ${refused.map((p) => `'${p}'`).join(', ')}: ${OUTSIDE}`);
  if (parsed === undefined) return { problems: problems.length > 0 ? problems : [`${where}: could not be read`], references: [] };
  // parsed.errors misses JSON syntax errors ('{ "include": [' parses as an empty include); this has both.
  for (const d of ts.getConfigFileParsingDiagnostics(parsed)) {
    if (d.code !== NO_INPUTS && d.category === ts.DiagnosticCategory.Error) problems.push(`${where}: TS${d.code} ${firstLine(d)}`);
  }
  return {
    project: { config: where, options: forceStrict(parsed.options), listed: parsed.fileNames.map((f) => resolve(f)) },
    problems: [...new Set(problems)],
    references: (parsed.projectReferences ?? []).map((r) => ts.resolveProjectReferencePath(r)),
  };
}

/** Run-log lines for the paths the read fence refused. */
function describeRefused(refused: readonly string[]): string[] {
  if (refused.length === 0) return [];
  const shown = refused.slice(0, LOG_FILES).join(', ');
  return [`read fence: refused ${refused.length} path(s) outside the API's tree: ${shown}${refused.length > LOG_FILES ? `, +${refused.length - LOG_FILES} more` : ''}`];
}

function siblingConfigs(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => SIBLING_CONFIG.test(n)).sort();
  } catch {
    return [];
  }
}

/** A TypeScript file that is the API's own: not a .d.ts that describes a sibling file (build output, or declarations for vendored JS). */
function isOwnTypeScript(abs: string): boolean {
  if (!TS_FILE.test(abs)) return false;
  if (!DECLARATION.test(abs)) return true;
  const stem = abs.replace(DECLARATION, '');
  return !existsSync(stem) && !SOURCE_EXTS.some((ext) => existsSync(`${stem}${ext}`));
}

function fileDiagnostics(program: ts.Program, sf: ts.SourceFile): ts.Diagnostic[] {
  return ts.getPreEmitDiagnostics(program, sf).filter((d) => d.file === sf && d.category === ts.DiagnosticCategory.Error);
}

/** The package a "cannot resolve" diagnostic names, when package.json declares it (an environment gap, not a code error). */
function missingDependency(d: ts.Diagnostic, dependencies: () => Record<string, string>): string | null {
  if (!UNRESOLVED.has(d.code) || d.file === undefined || d.start === undefined || d.length === undefined) return null;
  const spec = d.file.text.slice(d.start, d.start + d.length).replace(/^['"`]|['"`]$/g, '');
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);
  const deps = dependencies();
  const builtin = spec.startsWith('node:') || builtinModules.includes(pkg);
  const typesName = `@types/${builtin ? 'node' : pkg.replace(/^@/, '').replace('/', '__')}`;
  if (deps[typesName] !== undefined) return typesName;
  // An installed package without types (7016) is the API's own gap unless it declares the @types package.
  return !builtin && d.code !== NO_TYPES && deps[pkg] !== undefined ? pkg : null;
}

function toDiagnostic(d: ts.Diagnostic, root: string): TypeDiagnostic {
  const message = `TS${d.code}: ${firstLine(d)}`;
  if (d.file === undefined || d.start === undefined) return { file: null, location: '(project)', message };
  const r = toPosix(relative(root, d.file.fileName));
  const lc = d.file.getLineAndCharacterOfPosition(d.start);
  const inApi = r !== '' && !r.startsWith('..') && !isAbsolute(r);
  return { file: inApi ? r : null, location: `${inApi ? r : d.file.fileName}:${lc.line + 1}:${lc.character + 1}`, message };
}

function dedupe(diags: TypeDiagnostic[]): TypeDiagnostic[] {
  const seen = new Set<string>();
  return diags.filter((d) => {
    const key = `${d.location}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeProjects(projects: readonly TsProject[], primaryIndex: number, counts: Map<number, number>, defaults: string | undefined): string[] {
  if (projects.length === 0) return [`no usable tsconfig.json: harness defaults (${defaults ?? 'none'}) for ${counts.get(primaryIndex) ?? 0} files`];
  return projects.map((p, i) => `project ${projectName(p)}${i === primaryIndex ? ' (primary: also checks files no tsconfig lists)' : ''}: ${counts.get(i) ?? 0} files checked`);
}

/** ", +N more" after the first of `n` items. */
function more(n: number): string {
  return n > 1 ? `, +${n - 1} more` : '';
}

function projectName(p: TsProject): string {
  return p.config ?? 'harness defaults';
}

function firstLine(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] ?? '';
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}
