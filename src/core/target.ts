/**
 * TargetProfile: what the harness learns about the governed API before the first model turn,
 * so every component adapts to the target instead of assuming the express-zod template.
 *
 *   layout        source roots, test roots, dedicated test dirs and the runner's test globs, read
 *                 from tsconfig (include/rootDir/references), package.json and the runner's own
 *                 config (vitest include / jest testMatch,roots / node --test arguments);
 *   resolution    the module resolution the API uses (tsconfig paths/baseUrl, package imports,
 *                 vite/vitest resolve.alias, jest moduleNameMapper) for the static import graph;
 *   runner        vitest | jest | node:test, and which binary runs it (the target's own first);
 *   dependencies  where express, zod, vitest and typescript resolve from (target vs harness);
 *   zod           the installed major and which JSON Schema converter applies.
 *
 * Honesty: anything the profile cannot determine is a note, and anything the harness cannot
 * support is listed in `unsupported` (reported UNPROVEN at preflight), never silently assumed.
 *
 * Without a computed profile every predicate falls back to LEGACY_LAYOUT (src/ + test/), the
 * behaviour of the harness's own template.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import ts from 'typescript';

// ───────────────────────────── types ─────────────────────────────

/** Where a package resolves from: the target repository, the harness (fallback), somewhere above both, or nowhere. */
export type DepOrigin = 'target' | 'harness' | 'outside' | 'missing';

export interface ResolvedPackage {
  name: string;
  /** Installed version (its package.json), null when missing. */
  version: string | null;
  origin: DepOrigin;
  /** Absolute package directory (as found, symlinks not resolved), null when missing. */
  dir: string | null;
  /** Version range the API's package.json declares, null when undeclared. */
  declared: string | null;
}

/** How bare specifiers map to files (all paths API-relative POSIX). */
export interface ResolutionConfig {
  /** Absolute tsconfig path, null without one. */
  tsconfig: string | null;
  /** Compiler options for ts.resolveModuleName (paths, baseUrl, moduleResolution, ...). */
  options: ts.CompilerOptions;
  /** tsconfig `paths` (targets relative to the API root). */
  paths: Array<{ pattern: string; targets: string[] }>;
  /** tsconfig baseUrl relative to the API root, null when unset. */
  baseUrl: string | null;
  /** Prefix aliases from vite/vitest resolve.alias or jest moduleNameMapper. */
  aliases: Array<{ find: string; replacement: string }>;
}

export interface TargetLayout {
  /** Directories holding governed source ('.' = the whole API root minus test dirs). */
  sourceRoots: string[];
  /** Directories the runner collects tests from ('.' = anywhere). */
  testRoots: string[];
  /** Dedicated test directories: a non-test file there is test support (helpers, fixtures). */
  testSupportRoots: string[];
  /** The runner's test file globs (API-relative). */
  testGlobs: string[];
  /** Jest testRegex patterns (matched against '/' + the API-relative path). */
  testRegex: string[];
  resolution: ResolutionConfig;
}

export type RunnerKind = 'vitest' | 'jest' | 'node-test';

export interface TestRunnerInfo {
  /** The runner the API declares; 'unknown' = none recognised (an unsupported one is named in `name`). */
  kind: RunnerKind | 'unknown';
  /** Human name, e.g. "vitest 5.0.3", "jest (not installed)", "mocha". */
  name: string;
  supported: boolean;
  /** Why the runner cannot be used (unsupported runs are UNPROVEN). */
  reason?: string;
  /** Absolute path of the runner's JS entry (vitest/jest bin script); node:test runs on node itself. */
  bin?: string;
  version?: string | null;
  /** Whether the binary is the target's own install or the harness's fallback. */
  origin?: DepOrigin;
  /** Evidence for the choice (script, config file, dependency). */
  evidence: string;
  /** node:test: loader flags to pass before --test (from the project's test script, or tsx for .ts on an old node). */
  nodeArgs?: string[];
  /** node:test: the file patterns the project's test script passes (none = node's defaults). */
  patterns?: string[];
}

export interface TargetProfile extends TargetLayout {
  apiRoot: string;
  framework: { name: string; version: string | null; supported: boolean };
  runner: TestRunnerInfo;
  /** Likely app entry files (package.json main/exports/bin/scripts, then common names). */
  entryCandidates: string[];
  dependencies: Record<string, ResolvedPackage>;
  zod: { version: string | null; major: number | null; origin: DepOrigin; converter: 'toJSONSchema' | 'zod-to-json-schema' | 'unavailable' };
  /** What could not be determined (UNPROVEN, never guessed silently). */
  notes: string[];
  /** Preflight refusals: each is an UNPROVEN line before the first model turn. */
  unsupported: string[];
}

// ───────────────────────────── paths ─────────────────────────────

const TS_SOURCE_RE = /\.[cm]?tsx?$/;
const DECL_RE = /\.d\.[cm]?tsx?$/;
/** The harness's own test file shape; runner globs only add to it inside dedicated test dirs. */
const TEST_NAME_RE = /\.(test|spec)\.[cm]?tsx?$/;
/** Directory names that conventionally hold only tests (and their helpers). */
const TEST_DIR_RE = /^(tests?|__tests__|specs?|e2e|integration|__integration__|__mocks__)$/i;
/** Tooling config files: never governed source, never "the code a test exercises". */
const TOOLING_RE = /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(vitest|vite|jest)\.(workspace|setup)\.[cm]?[jt]s$/;
const IGNORE_DIRS = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.harness/**'];

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** API-relative POSIX form of a directory (or '.' for the root); null when it leaves the root. */
function relDir(apiRoot: string, abs: string): string | null {
  const rel = toPosix(relative(apiRoot, abs));
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel.replace(/\/+$/, '');
}

function cleanRel(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return n === '' ? '.' : n;
}

/** Whether API-relative `rel` lies under root `dir` ('.' contains everything). */
export function underRoot(rel: string, dir: string): boolean {
  return dir === '.' || rel === dir || rel.startsWith(`${dir}/`);
}

export function underAny(rel: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => underRoot(rel, d));
}

/** Drop roots nested in another root; sorted, unique. */
function outermost(dirs: string[]): string[] {
  const uniq = [...new Set(dirs.map(cleanRel))].sort();
  return uniq.filter((d) => !uniq.some((o) => o !== d && underRoot(d, o)));
}

export function isToolingConfig(rel: string): boolean {
  return TOOLING_RE.test(rel);
}

// ───────────────────────────── layout state ─────────────────────────────

function emptyResolution(): ResolutionConfig {
  return { tsconfig: null, options: {}, paths: [], baseUrl: null, aliases: [] };
}

/** The harness template's layout: the behaviour when no profile has been computed. */
export const LEGACY_LAYOUT: TargetLayout = Object.freeze({
  sourceRoots: ['src'],
  testRoots: ['test'],
  testSupportRoots: ['test'],
  testGlobs: ['**/*.{test,spec}.?(c|m)ts'],
  testRegex: [],
  resolution: emptyResolution(),
});

let active: TargetLayout = LEGACY_LAYOUT;

/**
 * Make `layout` the one the pure predicates (isTestFile, isTestSupport, reachesSource, the
 * observed-red helpers) use when they are not handed one. The core sets it when it builds the
 * services of a run; undefined restores LEGACY_LAYOUT.
 */
export function setActiveLayout(layout: TargetLayout | undefined): void {
  active = layout ?? LEGACY_LAYOUT;
}

export function activeLayout(): TargetLayout {
  return active;
}

const matchers = new WeakMap<TargetLayout, (rel: string) => boolean>();

/** Whether a path matches the runner's test globs / testRegex. */
export function matchesTestPattern(rel: string, layout: TargetLayout = active): boolean {
  let m = matchers.get(layout);
  if (m === undefined) {
    const globs = layout.testGlobs.length > 0 ? picomatch(layout.testGlobs, { dot: true }) : () => false;
    const regexes = layout.testRegex.flatMap((r) => {
      try {
        return [new RegExp(r)];
      } catch {
        return [];
      }
    });
    m = (rel: string): boolean => globs(rel) || regexes.some((r) => r.test(`/${rel}`));
    matchers.set(layout, m);
  }
  return m(rel);
}

/**
 * A runnable test file: `*.test|spec.(c|m)?ts(x)` anywhere, or a file the runner's globs collect
 * inside a dedicated test dir (e.g. jest's `__tests__/x.ts`). Globs never turn a file outside the
 * dedicated test dirs into a test, so a broad include cannot un-govern source.
 */
export function isTestPath(rel: string, layout: TargetLayout = active): boolean {
  if (TEST_NAME_RE.test(rel)) return true;
  return TS_SOURCE_RE.test(rel) && !DECL_RE.test(rel) && underAny(rel, layout.testSupportRoots) && matchesTestPattern(rel, layout);
}

/** Test support: any other file inside a dedicated test dir (helpers, fixtures). */
export function isTestSupportPath(rel: string, layout: TargetLayout = active): boolean {
  return underAny(rel, layout.testSupportRoots) && !isTestPath(rel, layout);
}

/** Governed source a test can exercise: TypeScript under a source root, not a test, test support, declaration or tooling config. */
export function isSourcePath(rel: string, layout: TargetLayout = active): boolean {
  return TS_SOURCE_RE.test(rel) && !DECL_RE.test(rel) && !isToolingConfig(rel) && underAny(rel, layout.sourceRoots)
    && !isTestPath(rel, layout) && !isTestSupportPath(rel, layout);
}

/** Short label of the source roots for messages, e.g. "src/" or "lib/, scripts/" or "the API root". */
export function sourceRootsLabel(layout: TargetLayout = active): string {
  if (layout.sourceRoots.includes('.')) return 'the API source';
  return layout.sourceRoots.map((r) => `${r}/`).join(', ');
}

/**
 * The runnable test file to suggest for a source file: a path the runner actually collects.
 * Dedicated test dirs first (`tests/<name>.test.ts`), then colocated (`<dir>/<name>.test.ts`),
 * each with .test and .spec; the first one the runner's globs match wins.
 */
export function suggestTestPath(source: string, layout: TargetLayout = active): string {
  const clean = cleanRel(source);
  const base = posix.basename(clean).replace(/\.[cm]?tsx?$/, '');
  const name = base === 'index' ? posix.basename(posix.dirname(clean)) || 'index' : base;
  const dir = posix.dirname(clean);
  const inDir = (d: string, file: string): string => (d === '.' ? file : `${d}/${file}`);
  const candidates: string[] = [];
  for (const root of layout.testSupportRoots) candidates.push(inDir(root, `${name}.test.ts`), inDir(root, `${name}.spec.ts`));
  candidates.push(inDir(dir, `${name}.test.ts`), inDir(dir, `${name}.spec.ts`), inDir(dir, `__tests__/${name}.test.ts`));
  for (const root of layout.testRoots) candidates.push(inDir(root, `${name}.test.ts`), inDir(root, `${name}.spec.ts`));
  return candidates.find((c) => matchesTestPattern(c, layout) && isTestPath(c, layout)) ?? `test/${name}.test.ts`;
}

/**
 * The brownfield write scope a task without an explicit `scope` gets: TypeScript under the source
 * roots and the dedicated test dirs, plus test files wherever the runner collects them.
 */
export function defaultScopeAllow(layout: TargetLayout = active): string[] {
  const ts = (d: string): string => (d === '.' ? '**/*.ts' : `${d}/**/*.ts`);
  const testFiles = layout.testRoots.map((d) => (d === '.' ? '**/*.{test,spec}.ts' : `${d}/**/*.{test,spec}.ts`));
  return [...new Set([...layout.sourceRoots.map(ts), ...layout.testSupportRoots.map(ts), ...testFiles])];
}

// ───────────────────────────── dependencies ─────────────────────────────

/**
 * Link every node_modules directory on the path from `srcTop` down to `srcTop/<apiRel>` into the
 * same place under `destTop` (levels '.', 'packages', 'packages/api', …), so a worktree, scratch
 * copy or snapshot resolves packages exactly like the target checkout: the API's own first, then
 * each ancestor's. Existing entries are kept. `fallback` (the harness's node_modules) is linked at
 * the top only when the target has none there and node resolution would not reach it anyway.
 * Returns the links created (absolute).
 */
export function linkDependencies(srcTop: string, apiRel: string, destTop: string, fallback?: string): string[] {
  const rel = cleanRel(apiRel);
  const levels = ['.'];
  if (rel !== '.') {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i += 1) levels.push(parts.slice(0, i).join('/'));
  }
  const made: string[] = [];
  for (const level of levels) {
    const src = join(srcTop, level, 'node_modules');
    if (!isDir(src)) continue;
    const dest = join(destTop, level, 'node_modules');
    if (exists(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(realpathSync(src), dest, 'dir');
    made.push(dest);
  }
  const top = join(destTop, 'node_modules');
  if (fallback !== undefined && isDir(fallback) && !exists(top)) {
    mkdirSync(destTop, { recursive: true });
    symlinkSync(realpathSync(fallback), top, 'dir');
    made.push(top);
  }
  return made;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export interface PackageJson {
  raw: Record<string, unknown>;
  deps: Record<string, string>;
  scripts: Record<string, string>;
}

export function readPackageJson(apiRoot: string): PackageJson | null {
  const raw = readJson(join(apiRoot, 'package.json'));
  if (!isRecord(raw)) return null;
  const deps: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = raw[key];
    if (!isRecord(section)) continue;
    for (const [n, v] of Object.entries(section)) if (typeof v === 'string' && deps[n] === undefined) deps[n] = v;
  }
  const scripts: Record<string, string> = {};
  if (isRecord(raw['scripts'])) for (const [n, v] of Object.entries(raw['scripts'])) if (typeof v === 'string') scripts[n] = v;
  return { raw, deps, scripts };
}

/**
 * Resolve a package the way Node does from `apiRoot` (walk up node_modules) and classify where it
 * was found: inside `repoRoot` (the target's own, possibly linked), inside `harnessRoot` (fallback),
 * or elsewhere above.
 */
export function resolvePackage(name: string, apiRoot: string, ctx: { repoRoot?: string; harnessRoot?: string; declared?: Record<string, string> }): ResolvedPackage {
  const declared = ctx.declared?.[name] ?? null;
  for (let dir = resolve(apiRoot); ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', name);
    const manifest = readJson(join(pkgDir, 'package.json'));
    if (isRecord(manifest)) {
      const origin: DepOrigin = ctx.repoRoot !== undefined && isInside(ctx.repoRoot, dir) ? 'target'
        : ctx.harnessRoot !== undefined && isInside(ctx.harnessRoot, dir) ? 'harness'
          : 'outside';
      return { name, version: str(manifest['version']) ?? null, origin, dir: pkgDir, declared };
    }
    if (dirname(dir) === dir) break;
  }
  return { name, version: null, origin: 'missing', dir: null, declared };
}

/** The JS entry of a package's bin (`bin` string, or the named entry of a bin map). */
export function packageBin(pkg: ResolvedPackage, binName: string): string | null {
  if (pkg.dir === null) return null;
  const manifest = readJson(join(pkg.dir, 'package.json'));
  if (!isRecord(manifest)) return null;
  const bin = manifest['bin'];
  const rel = typeof bin === 'string' ? bin : isRecord(bin) ? str(bin[binName]) : undefined;
  if (rel === undefined) return null;
  const abs = join(pkg.dir, rel);
  return existsSync(abs) ? abs : null;
}

/** The ESM entry of a package (`exports['.']` string/import/default, else `module`/`main`), null when missing. */
export function packageEntry(pkg: ResolvedPackage): string | null {
  if (pkg.dir === null) return null;
  const manifest = readJson(join(pkg.dir, 'package.json'));
  if (!isRecord(manifest)) return null;
  const exp = manifest['exports'];
  const dot = isRecord(exp) ? exp['.'] : exp;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' ? v : isRecord(v) ? pick(v['import']) ?? pick(v['default']) : undefined);
  const rel = pick(dot) ?? str(manifest['module']) ?? str(manifest['main']) ?? 'index.js';
  const abs = join(pkg.dir, rel);
  return existsSync(abs) ? abs : null;
}

function major(version: string | null): number | null {
  const m = version === null ? null : /^(\d+)\./.exec(version);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** Whether `version` is at least major.minor. */
export function versionAtLeast(version: string | null | undefined, maj: number, min = 0): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > maj || (a === maj && b >= min);
}

// ───────────────────────────── tsconfig ─────────────────────────────

interface TsconfigInfo {
  path: string;
  options: ts.CompilerOptions;
  /** API-relative directories the include patterns cover. */
  includeDirs: string[];
  /** API-relative explicit files. */
  files: string[];
  errors: string[];
}

function readTsconfig(apiRoot: string): TsconfigInfo | null {
  const path = join(apiRoot, 'tsconfig.json');
  if (!existsSync(path)) return null;
  const info: TsconfigInfo = { path, options: {}, includeDirs: [], files: [], errors: [] };
  const seen = new Set<string>();
  const visit = (file: string, depth: number, primary: boolean): void => {
    if (seen.has(file) || depth > 3) return;
    seen.add(file);
    const read = ts.readConfigFile(file, (p) => ts.sys.readFile(p));
    if (read.error !== undefined) {
      info.errors.push(`${toPosix(relative(apiRoot, file))}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
      return;
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file), undefined, file);
    if (primary) info.options = parsed.options;
    for (const dir of Object.keys(parsed.wildcardDirectories ?? {})) {
      const rel = relDir(apiRoot, dir);
      if (rel !== null) info.includeDirs.push(rel);
    }
    for (const f of parsed.fileNames) {
      const rel = relDir(apiRoot, f);
      // Explicit files outside the include dirs (a root-level vitest.config.ts is tooling, not a source root).
      if (rel !== null && !isToolingConfig(rel) && !info.includeDirs.some((d) => underRoot(rel, d))) info.files.push(rel);
    }
    // Solution-style configs (`files: []` + references): the referenced projects hold the sources.
    for (const ref of parsed.projectReferences ?? []) {
      const target = ref.path.endsWith('.json') ? ref.path : join(ref.path, 'tsconfig.json');
      if (existsSync(target)) visit(target, depth + 1, false);
    }
  };
  visit(path, 0, true);
  return info;
}

// ───────────────────────────── static config reading ─────────────────────────────

function parseScript(file: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return null;
  }
}

/** The exported config object of a config module (`export default {…}`, `defineConfig({…})`, `module.exports = …`). */
function configObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const vars = new Map<string, ts.Expression>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer !== undefined) vars.set(d.name.text, d.initializer);
  }
  const unwrap = (e: ts.Expression | undefined, depth = 0): ts.ObjectLiteralExpression | null => {
    if (e === undefined || depth > 5) return null;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return unwrap(e.expression, depth + 1);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isCallExpression(e)) {
      for (const a of e.arguments) {
        const o = unwrap(a, depth + 1);
        if (o !== null) return o;
      }
      return null;
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      if (!ts.isBlock(e.body)) return unwrap(e.body, depth + 1);
      const ret = e.body.statements.find(ts.isReturnStatement);
      return unwrap(ret?.expression, depth + 1);
    }
    if (ts.isIdentifier(e)) return unwrap(vars.get(e.text), depth + 1);
    return null;
  };
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) return unwrap(st.expression);
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && st.expression.left.getText(sf) === 'module.exports') return unwrap(st.expression.right);
  }
  return null;
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (key === name) return p.initializer;
  }
  return undefined;
}

function stringList(e: ts.Expression | undefined): string[] | null {
  if (e === undefined) return null;
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: string[] = [];
  for (const el of e.elements) {
    if (!ts.isStringLiteralLike(el)) return null;
    out.push(el.text);
  }
  return out;
}

/** A path expression we can read without running it: './src', fileURLToPath(new URL('./src', import.meta.url)), path.resolve(__dirname, 'src'). */
function staticPath(e: ts.Expression): string | null {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'URL') {
    const a = e.arguments?.[0];
    return a !== undefined && ts.isStringLiteralLike(a) ? a.text : null;
  }
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'pathname') return staticPath(e.expression);
  if (ts.isCallExpression(e)) {
    const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name.text : ts.isIdentifier(e.expression) ? e.expression.text : '';
    if (callee === 'fileURLToPath') {
      const a = e.arguments[0];
      return a === undefined ? null : staticPath(a);
    }
    if (callee === 'resolve' || callee === 'join') {
      const parts: string[] = [];
      for (const a of e.arguments) {
        if (ts.isStringLiteralLike(a)) parts.push(a.text);
        else if (!/^(__dirname|import\.meta\.dirname|process\.cwd\(\))$/.test(a.getText())) return null;
      }
      return parts.length > 0 ? posix.join(...parts) : null;
    }
  }
  return null;
}

/** API-relative replacement of an alias target (absolute paths inside the root, relative ones as given). */
function aliasTarget(apiRoot: string, configDir: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(configDir, p);
  return relDir(apiRoot, abs);
}

interface RunnerConfig {
  file: string | null;
  globs: string[] | null;
  regex: string[];
  aliases: Array<{ find: string; replacement: string }>;
  notes: string[];
}

const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const JEST_DEFAULT_MATCH = ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'];
const NODE_TEST_DEFAULTS = ['**/*.test.?(c|m)[jt]s', '**/*-test.?(c|m)[jt]s', '**/*_test.?(c|m)[jt]s', '**/test-*.?(c|m)[jt]s', '**/test.?(c|m)[jt]s', '**/test/**/*.?(c|m)[jt]s'];

function firstExisting(apiRoot: string, names: string[]): string | null {
  for (const n of names) if (existsSync(join(apiRoot, n))) return join(apiRoot, n);
  return null;
}

const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];
const JEST_CONFIGS = ['jest.config.ts', 'jest.config.mts', 'jest.config.cts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'];

function readAliases(apiRoot: string, file: string, resolveObj: ts.ObjectLiteralExpression | null, notes: string[]): Array<{ find: string; replacement: string }> {
  const out: Array<{ find: string; replacement: string }> = [];
  const alias = resolveObj === null ? undefined : prop(resolveObj, 'alias');
  if (alias === undefined) return out;
  const add = (find: string, target: ts.Expression): void => {
    const p = staticPath(target);
    const rel = p === null ? null : aliasTarget(apiRoot, dirname(file), p);
    if (rel === null) notes.push(`resolve.alias "${find}" in ${posix.basename(file)} is not a static path: imports through it are not followed`);
    else out.push({ find, replacement: rel });
  };
  if (ts.isObjectLiteralExpression(alias)) {
    for (const p of alias.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
      if (key !== null) add(key, p.initializer);
    }
  } else if (ts.isArrayLiteralExpression(alias)) {
    for (const el of alias.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      const find = prop(el, 'find');
      const rep = prop(el, 'replacement');
      if (find !== undefined && ts.isStringLiteralLike(find) && rep !== undefined) add(find.text, rep);
      else notes.push(`a resolve.alias entry in ${posix.basename(file)} is not static: imports through it are not followed`);
    }
  }
  return out;
}

function readVitestConfig(apiRoot: string): RunnerConfig {
  const file = firstExisting(apiRoot, VITEST_CONFIGS);
  const cfg: RunnerConfig = { file, globs: null, regex: [], aliases: [], notes: [] };
  if (file === null) return cfg;
  const sf = parseScript(file);
  const obj = sf === null ? null : configObject(sf);
  if (obj === null) {
    cfg.notes.push(`${posix.basename(file)}: config object is not static; using vitest's default include`);
    return cfg;
  }
  const test = prop(obj, 'test');
  const testObj = test !== undefined && ts.isObjectLiteralExpression(test) ? test : null;
  const include = testObj === null ? undefined : prop(testObj, 'include');
  const globs = stringList(include);
  if (include !== undefined && globs === null) cfg.notes.push(`${posix.basename(file)}: test.include is not a literal list; using vitest's default include`);
  cfg.globs = globs;
  for (const key of ['root', 'dir', 'projects', 'workspace']) {
    if (testObj !== null && prop(testObj, key) !== undefined) cfg.notes.push(`${posix.basename(file)}: test.${key} is not modelled; the test layout may be incomplete`);
  }
  const resolveProp = prop(obj, 'resolve');
  cfg.aliases = readAliases(apiRoot, file, resolveProp !== undefined && ts.isObjectLiteralExpression(resolveProp) ? resolveProp : null, cfg.notes);
  return cfg;
}

/** Jest options as plain data: package.json "jest", jest.config.json, or a static jest.config.* object. */
function jestOptions(apiRoot: string, pkg: PackageJson | null): { file: string | null; get: (k: string) => unknown } | null {
  if (pkg !== null && isRecord(pkg.raw['jest'])) {
    const o = pkg.raw['jest'];
    return { file: join(apiRoot, 'package.json'), get: (k) => o[k] };
  }
  const file = firstExisting(apiRoot, JEST_CONFIGS);
  if (file === null) return null;
  if (file.endsWith('.json')) {
    const o = readJson(file);
    return isRecord(o) ? { file, get: (k) => o[k] } : { file, get: () => undefined };
  }
  const sf = parseScript(file);
  const obj = sf === null ? null : configObject(sf);
  return {
    file,
    get: (k) => {
      const e = obj === null ? undefined : prop(obj, k);
      if (e === undefined) return undefined;
      if (ts.isStringLiteralLike(e)) return e.text;
      const list = stringList(e);
      if (list !== null) return list;
      if (ts.isObjectLiteralExpression(e)) {
        const out: Record<string, unknown> = {};
        for (const p of e.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
          const value = ts.isStringLiteralLike(p.initializer) ? p.initializer.text : stringList(p.initializer);
          if (key !== null && value !== null) out[key] = value;
        }
        return out;
      }
      return null;
    },
  };
}

function readJestConfig(apiRoot: string, pkg: PackageJson | null): RunnerConfig {
  const opts = jestOptions(apiRoot, pkg);
  const cfg: RunnerConfig = { file: opts?.file ?? null, globs: null, regex: [], aliases: [], notes: [] };
  if (opts === null) return cfg;
  const rootDirRaw = opts.get('rootDir');
  const rootDir = typeof rootDirRaw === 'string' ? relDir(apiRoot, resolve(apiRoot, rootDirRaw)) ?? '.' : '.';
  const withRoot = (p: string): string => cleanRel(p.replace(/^<rootDir>\/?/, rootDir === '.' ? '' : `${rootDir}/`));
  const strings = (v: unknown): string[] | null => (typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.map(String) : null);
  const roots = strings(opts.get('roots'))?.map(withRoot) ?? [rootDir];
  const match = strings(opts.get('testMatch'));
  const regex = strings(opts.get('testRegex'));
  if (opts.get('testMatch') === null || opts.get('roots') === null || opts.get('testRegex') === null) {
    cfg.notes.push(`${posix.basename(cfg.file ?? 'jest config')}: testMatch/roots/testRegex are not literal; the test layout may be incomplete`);
  }
  if (regex !== null) {
    cfg.regex = regex;
    cfg.globs = [];
  } else {
    const patterns = (match ?? JEST_DEFAULT_MATCH).map((g) => g.replace(/^<rootDir>\/?/, ''));
    // Jest matches testMatch against absolute paths below each root.
    cfg.globs = roots.flatMap((r) => patterns.map((g) => (g.startsWith('**/') && r !== '.' ? `${r}/${g}` : g)));
  }
  const mapper = opts.get('moduleNameMapper');
  if (isRecord(mapper)) {
    for (const [re, target] of Object.entries(mapper)) {
      const m = /^\^?(.+?)\(\.\*\)\$?$/.exec(re);
      const to = typeof target === 'string' ? /^(.*?)\$1$/.exec(target)?.[1] : undefined;
      const find = m?.[1]?.replace(/\\(.)/g, '$1').replace(/\/$/, '');
      if (find === undefined || to === undefined) {
        cfg.notes.push(`jest moduleNameMapper "${re}" is not a simple prefix map: imports through it are not followed`);
        continue;
      }
      cfg.aliases.push({ find, replacement: withRoot(to.replace(/\/$/, '')) });
    }
  }
  return cfg;
}

const VALUE_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--test-reporter', '--test-reporter-destination',
  '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--env-file', '--conditions', '-C', '--test-shard']);
const LOADER_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);

/** node:test from a script: its file patterns and the loader flags it passes before --test. */
export function parseNodeTestScript(script: string): { globs: string[]; nodeArgs: string[]; tsx: boolean } | null {
  for (const part of script.split(/&&|\|\||;/)) {
    const tokens = part.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, '')).filter((t) => t !== '');
    const at = tokens.indexOf('--test');
    if (at < 0) continue;
    const head = tokens[0] ?? '';
    if (!/(^|\/)(node|tsx)$/.test(head) && !(head === 'npx' && /(^|\/)(node|tsx)$/.test(tokens[1] ?? ''))) continue;
    const tsx = head.endsWith('tsx') || tokens[1] === 'tsx';
    const globs: string[] = [];
    const nodeArgs: string[] = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const t = tokens[i] ?? '';
      if (t === '--test' || t === 'node' || t === 'tsx') continue;
      const [flag, inline] = t.split('=', 2);
      if (flag !== undefined && LOADER_FLAGS.has(flag)) {
        const value = inline ?? tokens[i + 1];
        if (inline === undefined) i += 1;
        if (value !== undefined) nodeArgs.push(`${flag}=${value}`);
        continue;
      }
      if (t.startsWith('-')) {
        if (flag !== undefined && VALUE_FLAGS.has(flag) && inline === undefined) i += 1;
        continue;
      }
      // A bare directory (node 20 walked it; node 22+ globs only): its test files, as a glob node expands.
      const p = cleanRel(t);
      globs.push(/[*?{[]/.test(p) || /\.[cm]?[jt]sx?$/.test(p) ? p : `${p === '.' ? '' : `${p}/`}**/*.test.?(c|m)[jt]s`);
    }
    return { globs, nodeArgs, tsx };
  }
  return null;
}

// ───────────────────────────── runner detection ─────────────────────────────

const OTHER_RUNNERS = ['mocha', 'ava', 'tap', 'jasmine', 'uvu', 'karma', 'playwright test', 'cypress'];

interface RunnerChoice {
  kind: RunnerKind | 'unknown';
  name: string;
  evidence: string;
}

function chooseRunner(apiRoot: string, pkg: PackageJson | null, testFiles: string[]): RunnerChoice {
  const script = pkg?.scripts['test'] ?? '';
  if (/\bvitest\b/.test(script)) return { kind: 'vitest', name: 'vitest', evidence: `package.json scripts.test: ${script}` };
  if (/\bjest\b/.test(script)) return { kind: 'jest', name: 'jest', evidence: `package.json scripts.test: ${script}` };
  if (parseNodeTestScript(script) !== null) return { kind: 'node-test', name: 'node:test', evidence: `package.json scripts.test: ${script}` };
  const other = OTHER_RUNNERS.find((r) => new RegExp(`(^|[\\s/])${r}\\b`).test(script));
  if (other !== undefined) return { kind: 'unknown', name: other, evidence: `package.json scripts.test: ${script}` };
  const vitestCfg = firstExisting(apiRoot, VITEST_CONFIGS.filter((f) => f.startsWith('vitest')));
  if (vitestCfg !== null) return { kind: 'vitest', name: 'vitest', evidence: posix.basename(vitestCfg) };
  const jestCfg = firstExisting(apiRoot, JEST_CONFIGS);
  if (jestCfg !== null || (pkg !== null && isRecord(pkg.raw['jest']))) return { kind: 'jest', name: 'jest', evidence: jestCfg !== null ? posix.basename(jestCfg) : 'package.json "jest"' };
  const deps = pkg?.deps ?? {};
  if (deps['vitest'] !== undefined) return { kind: 'vitest', name: 'vitest', evidence: 'vitest dependency' };
  if (deps['jest'] !== undefined || deps['ts-jest'] !== undefined) return { kind: 'jest', name: 'jest', evidence: 'jest dependency' };
  const otherDep = OTHER_RUNNERS.find((r) => deps[r] !== undefined);
  if (otherDep !== undefined) return { kind: 'unknown', name: otherDep, evidence: `${otherDep} dependency` };
  // Last resort: what the existing test files import.
  const seen = { vitest: 0, jest: 0, node: 0 };
  for (const f of testFiles.slice(0, 50)) {
    let text = '';
    try {
      text = readFileSync(join(apiRoot, f), 'utf8');
    } catch {
      continue;
    }
    if (/from\s+['"]vitest['"]/.test(text)) seen.vitest += 1;
    else if (/from\s+['"]node:test['"]|require\(['"]node:test['"]\)/.test(text)) seen.node += 1;
    else if (/from\s+['"]@jest\/globals['"]|\bjest\.(fn|mock|spyOn)\(/.test(text)) seen.jest += 1;
  }
  if (seen.node > seen.vitest && seen.node >= seen.jest) return { kind: 'node-test', name: 'node:test', evidence: 'test files import node:test' };
  if (seen.jest > seen.vitest) return { kind: 'jest', name: 'jest', evidence: 'test files use jest APIs' };
  return { kind: 'vitest', name: 'vitest', evidence: seen.vitest > 0 ? 'test files import vitest' : 'no runner declared (harness default)' };
}

function runnerInfo(choice: RunnerChoice, apiRoot: string, pkg: PackageJson | null, ctx: { repoRoot?: string; harnessRoot: string }, testFiles: string[]): TestRunnerInfo {
  const declared = pkg?.deps ?? {};
  if (choice.kind === 'unknown') {
    return { kind: 'unknown', name: choice.name, supported: false, reason: `unsupported test runner ${choice.name} (supported: vitest, jest, node:test)`, evidence: choice.evidence };
  }
  if (choice.kind === 'node-test') {
    const parsed = parseNodeTestScript(pkg?.scripts['test'] ?? '');
    const nodeArgs = [...(parsed?.nodeArgs ?? [])];
    const needsTs = testFiles.some((f) => TS_SOURCE_RE.test(f)) || (parsed?.globs ?? []).some((g) => /ts/.test(g));
    const native = Boolean((process.features as { typescript?: unknown }).typescript);
    if ((parsed?.tsx === true || (needsTs && !native)) && !nodeArgs.some((a) => a.includes('tsx'))) {
      const loader = packageEntry(resolvePackage('tsx', apiRoot, { ...ctx, declared }));
      if (loader === null) {
        return { kind: 'node-test', name: 'node:test', supported: false, reason: 'node:test with TypeScript needs tsx (or a node with type stripping); neither is available', evidence: choice.evidence };
      }
      nodeArgs.push(`--import=${pathToFileHref(loader)}`);
    }
    return {
      kind: 'node-test', name: `node:test (node ${process.versions.node})`, supported: true, version: process.versions.node,
      evidence: choice.evidence, nodeArgs, patterns: parsed?.globs ?? [],
    };
  }
  const pkgName = choice.kind;
  const resolved = resolvePackage(pkgName, apiRoot, { ...ctx, declared });
  const bin = packageBin(resolved, pkgName);
  if (choice.kind === 'jest') {
    if (bin === null) {
      return { kind: 'jest', name: 'jest (not installed)', supported: false, reason: 'unsupported test runner jest: jest is not installed in the target\'s node_modules (the harness does not ship it)', evidence: choice.evidence };
    }
    // Before 29 jest cannot be kept from running tests in band, i.e. in the process that writes the report.
    if (!versionAtLeast(resolved.version, 29)) {
      return {
        kind: 'jest', name: `jest ${resolved.version ?? '?'}`, supported: false, evidence: choice.evidence,
        reason: `unsupported test runner jest ${resolved.version ?? '?'}: jest < 29 may run tests inside the reporting process, so its report could be forged`,
      };
    }
    return { kind: 'jest', name: `jest ${resolved.version ?? '?'}`, supported: true, bin, version: resolved.version, origin: resolved.origin, evidence: choice.evidence };
  }
  if (bin !== null) {
    return { kind: 'vitest', name: `vitest ${resolved.version ?? '?'}`, supported: true, bin, version: resolved.version, origin: resolved.origin, evidence: choice.evidence };
  }
  const own = resolvePackage('vitest', ctx.harnessRoot, { harnessRoot: ctx.harnessRoot });
  const ownBin = packageBin(own, 'vitest');
  if (ownBin === null) return { kind: 'vitest', name: 'vitest (missing)', supported: false, reason: 'vitest is installed neither in the target nor in the harness', evidence: choice.evidence };
  return { kind: 'vitest', name: `vitest ${own.version ?? '?'}`, supported: true, bin: ownBin, version: own.version, origin: 'harness', evidence: choice.evidence };
}

function pathToFileHref(p: string): string {
  return `file://${toPosix(resolve(p)).replace(/^([A-Za-z]):/, '/$1:')}`;
}

// ───────────────────────────── layout computation ─────────────────────────────

/** Relative and alias imports of a file (no type information needed). */
function rawImports(text: string): string[] {
  try {
    return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  } catch {
    return [];
  }
}

/** The target of a package.json exports/imports entry: a string, or the first of import/node/default/require. */
function pickCondition(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (!isRecord(v)) return undefined;
  for (const k of ['import', 'node', 'default', 'require']) {
    const out = pickCondition(v[k]);
    if (out !== undefined) return out;
  }
  return undefined;
}

/** Package name of a bare specifier ('@scope/pkg/sub' → '@scope/pkg', 'pkg/sub' → 'pkg', 'node:fs' → 'node:fs'). */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? spec;
}

function aliasResolve(spec: string, aliases: ResolutionConfig['aliases'], paths: ResolutionConfig['paths']): string | null {
  for (const a of aliases) {
    if (spec === a.find) return a.replacement;
    if (spec.startsWith(`${a.find}/`)) return cleanRel(`${a.replacement}/${spec.slice(a.find.length + 1)}`);
  }
  for (const p of paths) {
    const star = p.pattern.indexOf('*');
    const first = p.targets[0];
    if (first === undefined) continue;
    if (star < 0) {
      if (spec === p.pattern) return cleanRel(first);
      continue;
    }
    const pre = p.pattern.slice(0, star);
    const post = p.pattern.slice(star + 1);
    if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
      return cleanRel(first.replace('*', spec.slice(pre.length, spec.length - post.length)));
    }
  }
  return null;
}

function entryCandidates(apiRoot: string, pkg: PackageJson | null, tsInfo: TsconfigInfo | null): string[] {
  const out: string[] = [];
  const outDir = tsInfo?.options.outDir !== undefined ? relDir(apiRoot, tsInfo.options.outDir) : null;
  const rootDir = tsInfo?.options.rootDir !== undefined ? relDir(apiRoot, tsInfo.options.rootDir) : null;
  const add = (raw: string): void => {
    let rel = cleanRel(raw);
    if (outDir !== null && outDir !== '.' && underRoot(rel, outDir)) {
      rel = cleanRel(`${rootDir ?? '.'}/${rel.slice(outDir.length + 1)}`);
    }
    const stem = rel.replace(/\.[cm]?[jt]sx?$/, '');
    for (const c of [rel, `${stem}.ts`, `${stem}.mts`, `${stem}.cts`, `${stem}/index.ts`]) {
      if (TS_SOURCE_RE.test(c) && existsSync(join(apiRoot, c)) && !out.includes(c)) {
        out.push(c);
        return;
      }
    }
  };
  if (pkg !== null) {
    for (const key of ['main', 'module']) {
      const v = str(pkg.raw[key]);
      if (v !== undefined) add(v);
    }
    const exp = pkg.raw['exports'];
    if (typeof exp === 'string') add(exp);
    const bin = pkg.raw['bin'];
    if (typeof bin === 'string') add(bin);
    else if (isRecord(bin)) for (const v of Object.values(bin)) if (typeof v === 'string') add(v);
    for (const name of ['start', 'dev', 'serve']) {
      const script = pkg.scripts[name];
      if (script === undefined) continue;
      for (const t of script.split(/\s+/)) if (/\.[cm]?[jt]sx?$/.test(t) && !t.startsWith('-')) add(t.replace(/^['"]|['"]$/g, ''));
    }
  }
  for (const dir of ['src', 'lib', 'app', 'server', '.']) {
    for (const name of ['app', 'server', 'index', 'main']) add(dir === '.' ? `${name}.ts` : `${dir}/${name}.ts`);
  }
  return out;
}

export interface LayoutResult {
  layout: TargetLayout;
  runner: RunnerChoice;
  runnerConfig: RunnerConfig;
  entries: string[];
  pkg: PackageJson | null;
  tsInfo: TsconfigInfo | null;
  testFiles: string[];
  /** Packages the non-test files import (framework detection when package.json declares none). */
  bareImports: string[];
  notes: string[];
}

/**
 * Work out where the API keeps its source and tests (see the module comment). Deterministic and
 * static: config modules are parsed, never executed.
 */
export async function analyzeLayout(apiRoot: string): Promise<LayoutResult> {
  const root = resolve(apiRoot);
  const notes: string[] = [];
  const pkg = readPackageJson(root);
  const tsInfo = readTsconfig(root);
  if (tsInfo !== null) notes.push(...tsInfo.errors.map((e) => `tsconfig: ${e}`));
  const all = existsSync(root)
    ? (await glob(['**/*.{ts,mts,cts,tsx,js,mjs,cjs}'], { cwd: root, ignore: IGNORE_DIRS, dot: false, followSymbolicLinks: false }).catch(() => [])).map(toPosix).sort()
    : [];
  const tsFiles = all.filter((f) => TS_SOURCE_RE.test(f) && !DECL_RE.test(f));

  // Resolution: tsconfig paths/baseUrl, then the runner config's aliases.
  const resolution = emptyResolution();
  if (tsInfo !== null) {
    resolution.tsconfig = tsInfo.path;
    resolution.options = tsInfo.options;
    const base = tsInfo.options.baseUrl ?? dirname(tsInfo.path);
    resolution.baseUrl = tsInfo.options.baseUrl !== undefined ? relDir(root, tsInfo.options.baseUrl) : null;
    for (const [pattern, targets] of Object.entries(tsInfo.options.paths ?? {})) {
      const rel = targets.flatMap((t) => {
        const r = relDir(root, resolve(base, t));
        return r === null ? [] : [r];
      });
      if (rel.length > 0) resolution.paths.push({ pattern, targets: rel });
    }
  }
  // package.json "imports" (#subpath patterns) behave like paths; conditions are picked the way Node's ESM loader would.
  const imports = pkg?.raw['imports'];
  if (isRecord(imports)) {
    for (const [pattern, target] of Object.entries(imports)) {
      const t = pickCondition(target);
      const rel = t === undefined || !t.startsWith('./') ? null : relDir(root, resolve(root, t));
      if (rel !== null) resolution.paths.push({ pattern, targets: [rel] });
    }
  }

  const testFilesByName = tsFiles.filter((f) => TEST_NAME_RE.test(f));
  const runner = chooseRunner(root, pkg, testFilesByName);
  let runnerConfig: RunnerConfig;
  let globs: string[];
  let regex: string[] = [];
  if (runner.kind === 'jest') {
    runnerConfig = readJestConfig(root, pkg);
    globs = runnerConfig.globs ?? JEST_DEFAULT_MATCH;
    regex = runnerConfig.regex;
  } else if (runner.kind === 'node-test') {
    runnerConfig = { file: null, globs: null, regex: [], aliases: [], notes: [] };
    const parsed = parseNodeTestScript(pkg?.scripts['test'] ?? '');
    globs = parsed !== null && parsed.globs.length > 0 ? parsed.globs : NODE_TEST_DEFAULTS;
  } else {
    runnerConfig = readVitestConfig(root);
    globs = runnerConfig.globs ?? VITEST_DEFAULT_INCLUDE;
  }
  notes.push(...runnerConfig.notes);
  resolution.aliases = runnerConfig.aliases;

  const globMatch = picomatch(globs, { dot: true });
  const regexes = regex.flatMap((r) => {
    try {
      return [new RegExp(r)];
    } catch {
      notes.push(`testRegex ${r} is not a valid regular expression`);
      return [];
    }
  });
  const testMatch = (rel: string): boolean => TEST_NAME_RE.test(rel) || globMatch(rel) || regexes.some((r) => r.test(`/${rel}`));
  const testFiles = tsFiles.filter(testMatch);

  // Candidate test dirs: the static base of each glob, plus the outermost conventionally named dir of each test file.
  const candidates = new Set<string>();
  for (const g of globs) {
    const base = cleanRel(picomatch.scan(g).base);
    if (base !== '.') candidates.add(base);
  }
  for (const f of testFiles) {
    const parts = f.split('/').slice(0, -1);
    const at = parts.findIndex((p) => TEST_DIR_RE.test(p));
    if (at >= 0) candidates.add(parts.slice(0, at + 1).join('/'));
  }

  // Which files import into which (relative + alias imports): source must never depend on a test dir.
  const importsOf = new Map<string, string[]>();
  const bareImports = new Set<string>();
  for (const f of tsFiles) {
    let text = '';
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    const targets: string[] = [];
    for (const spec of rawImports(text)) {
      const t = spec.startsWith('.') ? cleanRel(posix.join(posix.dirname(f), spec)) : aliasResolve(spec, resolution.aliases, resolution.paths);
      if (t !== null && !t.startsWith('..')) targets.push(t);
      else if (t === null && !spec.startsWith('.') && !testMatch(f)) bareImports.add(packageName(spec));
    }
    importsOf.set(f, targets);
  }
  const entries = entryCandidates(root, pkg, tsInfo);
  // tsconfig roots: include dirs, plus explicit files as exact paths (underRoot matches a file root exactly).
  const tsRoots = tsInfo === null ? null : [...tsInfo.includeDirs, ...tsInfo.files];
  const rootDir = tsInfo?.options.rootDir !== undefined ? relDir(root, tsInfo.options.rootDir) : null;
  const dedicated: string[] = [];
  for (const d of [...candidates].sort()) {
    const conventional = d.split('/').some((p) => TEST_DIR_RE.test(p));
    const outsideBuild = (rootDir !== null && rootDir !== '.' && !underRoot(d, rootDir))
      || (tsRoots !== null && tsRoots.length > 0 && !tsRoots.some((r) => underRoot(d, r)));
    if (!conventional && !outsideBuild) continue;
    if (entries.some((e) => underRoot(e, d))) continue;
    const reachedFromSource = [...importsOf].some(([from, targets]) => !underRoot(from, d) && !testMatch(from)
      && targets.some((t) => underRoot(t, d)));
    if (reachedFromSource) {
      notes.push(`${d}/ looks like a test dir but source outside it imports from it: treated as source`);
      continue;
    }
    dedicated.push(d);
  }
  const testSupportRoots = outermost(dedicated);

  // Source roots: tsconfig rootDir, else its include dirs / explicit files, else the whole root; minus test dirs.
  let sourceRoots: string[];
  if (rootDir !== null && rootDir !== '.') {
    sourceRoots = [rootDir];
  } else if (tsRoots !== null && tsRoots.length > 0) {
    sourceRoots = tsRoots.filter((r) => !testSupportRoots.some((t) => underRoot(r, t)));
  } else {
    if (tsInfo === null) notes.push('no tsconfig.json: every non-test TypeScript file outside the test dirs is treated as source');
    sourceRoots = ['.'];
  }
  if (sourceRoots.length === 0) {
    notes.push('tsconfig covers only test dirs: treating the whole API root as source');
    sourceRoots = ['.'];
  }
  const testRoots = outermost(globs.map((g) => cleanRel(picomatch.scan(g).base)));
  const layout: TargetLayout = {
    sourceRoots: outermost(sourceRoots),
    testRoots: testRoots.length > 0 ? testRoots : ['.'],
    testSupportRoots,
    testGlobs: globs,
    testRegex: regex,
    resolution,
  };
  return { layout, runner, runnerConfig, entries, pkg, tsInfo, testFiles, bareImports: [...bareImports].sort(), notes };
}

/** Just the layout (checks, contract extraction and `harness check` without a run profile). */
export async function targetLayout(apiRoot: string): Promise<TargetLayout> {
  return (await analyzeLayout(apiRoot)).layout;
}

// ───────────────────────────── profile ─────────────────────────────

const FRAMEWORKS = ['express', 'fastify', '@nestjs/core', 'hono', 'koa', '@hapi/hapi', 'restify', 'polka', 'elysia', 'h3'];
/** Dependencies whose resolution run.json records. */
export const TRACKED_DEPENDENCIES = ['express', 'zod', 'vitest', 'typescript', 'tsx', 'supertest'];

/**
 * Compute the profile of the API at `apiRoot`. `repoRoot` is the checkout the API lives in (the
 * worktree top), which decides whether a package resolves from the target or the harness.
 */
export async function computeTargetProfile(opts: { apiRoot: string; repoRoot?: string; harnessRoot: string }): Promise<TargetProfile> {
  const apiRoot = resolve(opts.apiRoot);
  const analysis = await analyzeLayout(apiRoot);
  const { layout, pkg } = analysis;
  const notes = [...analysis.notes];
  const unsupported: string[] = [];
  const ctx = { ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}), harnessRoot: opts.harnessRoot, declared: pkg?.deps ?? {} };
  const dependencies: Record<string, ResolvedPackage> = {};
  for (const name of TRACKED_DEPENDENCIES) dependencies[name] = resolvePackage(name, apiRoot, ctx);
  for (const d of Object.values(dependencies)) {
    if (d.declared === null || d.origin === 'target') continue;
    const wanted = /(\d+)/.exec(d.declared)?.[1];
    if (d.origin === 'missing') notes.push(`${d.name} ${d.declared} is declared but not installed`);
    else if (wanted !== undefined && String(major(d.version)) !== wanted) notes.push(`${d.name} ${d.declared} is declared but ${d.version ?? '?'} resolves from the ${d.origin}`);
  }

  // Declared frameworks first (Express wins when several are), else what the source imports.
  const declaredFw = FRAMEWORKS.filter((f) => pkg?.deps[f] !== undefined);
  const importedFw = FRAMEWORKS.filter((f) => analysis.bareImports.includes(f));
  const pick = (list: string[]): string | undefined => (list.includes('express') ? 'express' : list[0]);
  const fwName = pick(declaredFw) ?? pick(importedFw) ?? 'unknown';
  const fwPkg = fwName === 'unknown' ? null : resolvePackage(fwName, apiRoot, ctx);
  const framework = { name: fwName, version: fwPkg?.version ?? null, supported: fwName === 'express' };
  if (!framework.supported) {
    unsupported.push(`framework ${fwName === 'unknown' ? '(none declared)' : fwName}: route extraction, zod-boundary, rest-conventions, problem+json probes and the contract lock understand Express only and will report UNPROVEN`);
  }

  const runner = runnerInfo(analysis.runner, apiRoot, pkg, ctx, analysis.testFiles);
  if (!runner.supported) unsupported.push(`${runner.reason ?? `unsupported test runner ${runner.name}`}: tests-green and observed red are UNPROVEN`);

  const zodPkg = dependencies['zod'] ?? resolvePackage('zod', apiRoot, ctx);
  const zodMajor = major(zodPkg.version);
  const zjs = resolvePackage('zod-to-json-schema', apiRoot, ctx);
  const converter = zodMajor === null ? 'unavailable' : zodMajor >= 4 ? 'toJSONSchema' : zjs.origin !== 'missing' ? 'zod-to-json-schema' : 'unavailable';
  if (zodMajor !== null && zodMajor < 4 && converter === 'unavailable') notes.push('zod 3 schemas need zod-to-json-schema: contract schemas fall back to source text (UNPROVEN on change)');

  return {
    apiRoot,
    ...layout,
    framework,
    runner,
    entryCandidates: analysis.entries,
    dependencies,
    zod: { version: zodPkg.version, major: zodMajor, origin: zodPkg.origin, converter },
    notes,
    unsupported,
  };
}

/** The 4-6 line preflight summary printed before the first model turn. */
export function formatProfile(p: TargetProfile): string[] {
  const dep = (n: string): string => {
    const d = p.dependencies[n];
    return d === undefined ? `${n} ?` : `${n} ${d.version ?? '-'} (${d.origin})`;
  };
  const roots = (r: string[]): string => (r.length === 0 ? '(none)' : r.map((x) => (x === '.' ? './' : `${x}/`)).join(' '));
  const lines = [
    `target     framework ${p.framework.name}${p.framework.version !== null ? ` ${p.framework.version}` : ''}${p.framework.supported ? '' : ' (UNSUPPORTED)'}  runner ${p.runner.name}${p.runner.origin !== undefined ? ` (${p.runner.origin})` : ''}${p.runner.supported ? '' : ' (UNSUPPORTED)'}`,
    `           source ${roots(p.sourceRoots)}  tests ${roots(p.testRoots)} [${p.testGlobs.join(', ')}${p.testRegex.length > 0 ? `; regex ${p.testRegex.join(', ')}` : ''}]  test dirs ${roots(p.testSupportRoots)}`,
    `           entry ${p.entryCandidates.slice(0, 3).join(', ') || '(none found)'}  zod ${p.zod.version ?? '-'} → ${p.zod.converter}`,
    `           deps ${TRACKED_DEPENDENCIES.slice(0, 4).map(dep).join(', ')}`,
  ];
  for (const u of p.unsupported) lines.push(`           UNPROVEN: ${u}`);
  if (p.notes.length > 0) lines.push(`           notes: ${p.notes.slice(0, 3).join('; ')}${p.notes.length > 3 ? ` (+${p.notes.length - 3} more in run.json)` : ''}`);
  return lines;
}

/** JSON-safe record of the profile for run.json (no compiler options blob). */
export function profileRecord(p: TargetProfile): Record<string, unknown> {
  return {
    framework: p.framework,
    runner: { kind: p.runner.kind, name: p.runner.name, supported: p.runner.supported, origin: p.runner.origin ?? null, bin: p.runner.bin ?? null, evidence: p.runner.evidence, ...(p.runner.reason !== undefined ? { reason: p.runner.reason } : {}) },
    sourceRoots: p.sourceRoots,
    testRoots: p.testRoots,
    testSupportRoots: p.testSupportRoots,
    testGlobs: p.testGlobs,
    testRegex: p.testRegex,
    resolution: { tsconfig: p.resolution.tsconfig, baseUrl: p.resolution.baseUrl, paths: p.resolution.paths, aliases: p.resolution.aliases },
    entryCandidates: p.entryCandidates,
    dependencies: Object.fromEntries(Object.entries(p.dependencies).map(([k, d]) => [k, { version: d.version, origin: d.origin, declared: d.declared }])),
    zod: p.zod,
    notes: p.notes,
    unsupported: p.unsupported,
  };
}
