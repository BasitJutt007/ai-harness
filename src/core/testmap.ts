/**
 * Static analysis of test files: the import graph between tests and source, and
 * the test cases inside a test file.
 *
 * Deterministic: parses with the TypeScript parser (no type checking), resolves
 * relative specifiers the way NodeNext + TS do for .ts sources, bare specifiers through
 * the API's own module resolution (tsconfig paths/baseUrl, package.json imports, the
 * runner's aliases; see target.ts), follows require() as well as import, and keeps targets
 * that do not exist yet as nodes (a test may import a module the agent has not
 * written; that is exactly the "observed red" case).
 *
 * ONE definition of a test file for the whole harness (per the TargetLayout, see target.ts):
 *   - a runnable test file is `*.test.ts` / `*.spec.ts` (also .mts/.cts/.tsx) anywhere, or a file
 *     the runner's globs collect inside a dedicated test dir;
 *   - test support code is any other file in a dedicated test dir (test/ for the template;
 *     tests/, __tests__/ … as the target's runner config says): writable without a red, never
 *     run as a test, never "covered" by a test.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { join, posix } from 'node:path';
import { activeLayout, isSourcePath, isTestPath, isTestSupportPath, underRoot } from './target.ts';
import type { TargetLayout } from './target.ts';
import type { TestMap, Workspace } from './types.ts';

const TS_RE = /\.[cm]?tsx?$/;

/** A runnable test file of the active layout (see the module comment; target.ts isTestPath takes an explicit one). */
export function isTestFile(rel: string): boolean {
  return isTestPath(rel, activeLayout());
}

/** Test support code of the active layout: any other file in a dedicated test dir (helpers, fixtures). Never a runnable test, never covered. */
export function isTestSupport(rel: string): boolean {
  return isTestSupportPath(rel, activeLayout());
}

/** Import graph over API-relative .ts files: file -> resolved relative import targets. */
export interface ImportGraph {
  existing: ReadonlySet<string>;
  edges: ReadonlyMap<string, string[]>;
}

export async function importGraph(files: string[], read: (rel: string) => Promise<string | null>, layout: TargetLayout = activeLayout()): Promise<ImportGraph> {
  const existing = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const text = (await read(file)) ?? '';
    const targets = new Set<string>();
    for (const spec of importSpecifiers(file, text)) {
      const target = resolveImport(file, spec, existing, layout);
      if (target !== null) targets.add(target);
    }
    edges.set(file, [...targets].sort());
  }
  return { existing, edges };
}

/** Every .ts file under the API root the graph is built over (no .d.ts, no build output). */
export function graphFiles(listed: string[]): string[] {
  return listed.filter((f) => !/\.d\.[cm]?tsx?$/.test(f) && !f.startsWith('dist/') && !f.includes('/dist/')).sort();
}

export async function buildTestMap(ws: Workspace, layout: TargetLayout = activeLayout()): Promise<TestMap> {
  // Every .ts file under the API root: governed files outside the source roots are covered through imports too.
  const files = graphFiles(await ws.list(['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx']));
  const graph = await importGraph(files, (f) => ws.read(f), layout);
  const coverage: Record<string, string[]> = {};
  for (const test of files.filter((f) => isTestPath(f, layout))) coverage[test] = closure(test, graph.edges, layout);
  return createTestMap(coverage, graph.existing);
}

/**
 * Build the TestMap view (testsFor) over a coverage table. The basename fallback
 * (test/x.test.ts for src/x.ts) applies only to a source that does not exist yet
 * (per `existing`; without it, to any source no test imports).
 */
export function createTestMap(coverage: Record<string, string[]>, existing?: ReadonlySet<string>): TestMap {
  const tests = Object.keys(coverage).sort();
  return {
    coverage,
    testsFor(source: string): string[] {
      const src = normalizeSource(source);
      const direct = tests.filter((t) => (coverage[t] ?? []).includes(src));
      if (direct.length > 0) return direct;
      if (existing?.has(src) === true) return [];
      const base = stem(src);
      return tests.filter((t) => stem(t) === base);
    },
  };
}

/** Every module specifier a file references: import/export-from, import x = require(), require(lit), dynamic import(lit), vi.mock(lit)/jest.mock(lit) & friends. */
export function importSpecifiers(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg) && isImportLikeCall(node)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isImportLikeCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (isRequireCall(call)) return true;
  return isViCall(call, ['mock', 'doMock', 'importActual', 'importMock', 'requireActual', 'requireMock']);
}

/** `require('x')` (CommonJS): an import edge like any other. */
function isRequireCall(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === 'require' && call.arguments.length === 1;
}

/** vi.<name>(...) or jest.<name>(...): the mocking APIs of vitest and jest. */
function isViCall(call: ts.CallExpression, names: string[]): boolean {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && (callee.expression.text === 'vi' || callee.expression.text === 'jest') && names.includes(callee.name.text);
}

/**
 * Resolve a relative specifier from `from` (API-relative) to an API-relative path.
 * `./x.js` → `./x.ts`; `./x` → `./x.ts` or `./x/index.ts` (whichever exists, else `./x.ts`).
 * Non-relative specifiers and paths escaping the API root → null.
 */
export function resolveSpecifier(from: string, spec: string, existing: ReadonlySet<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  return resolveJoined(posix.normalize(posix.join(posix.dirname(from), spec)), existing);
}

/** Extension resolution of an API-relative module path (shared by relative and aliased specifiers). */
function resolveJoined(joined: string, existing: ReadonlySet<string>): string | null {
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null;
  const jsMatch = /\.([cm]?)js(x?)$/.exec(joined);
  if (jsMatch !== null) {
    const stem = joined.slice(0, -jsMatch[0].length);
    const tsx = `${stem}.${jsMatch[1] ?? ''}tsx`;
    return jsMatch[2] === 'x' || existing.has(tsx) ? tsx : `${stem}.${jsMatch[1] ?? ''}ts`;
  }
  if (/\.[cm]?tsx?$/.test(joined)) return joined;
  if (/\.[a-z0-9]+$/i.test(joined) && !existing.has(`${joined}.ts`)) return joined; // e.g. ./data.json
  for (const c of [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`]) if (existing.has(c)) return c;
  return `${joined}.ts`;
}

/**
 * Resolve any specifier of `from` to an API-relative path, the way the API itself resolves it:
 * relative paths as above; bare specifiers through the runner's aliases (vite/vitest resolve.alias,
 * jest moduleNameMapper), tsconfig `paths`/`baseUrl`, then ts.resolveModuleName with the API's
 * compiler options (package.json `imports`, …). A bare specifier that resolves to nothing inside the
 * API root is a package → null. A not-yet-existing target is kept (the "observed red" case).
 */
export function resolveImport(from: string, spec: string, existing: ReadonlySet<string>, layout: TargetLayout = activeLayout()): string | null {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return resolveSpecifier(from, spec === '.' || spec === '..' ? `${spec}/index` : spec, existing);
  }
  const r = layout.resolution;
  for (const a of r.aliases) {
    if (spec === a.find || spec.startsWith(`${a.find}/`)) {
      return resolveJoined(posix.normalize(posix.join(a.replacement, spec.slice(a.find.length))), existing);
    }
  }
  const mapped = mapPaths(spec, r.paths, existing);
  if (mapped !== null) return mapped;
  if (r.baseUrl !== null) {
    const viaBase = resolveJoined(posix.normalize(posix.join(r.baseUrl, spec)), existing);
    if (viaBase !== null && (existing.has(viaBase) || existing.has(viaBase.replace(/\.ts$/, '/index.ts')))) return viaBase;
  }
  if (spec.startsWith('#') && r.tsconfig !== null) return resolveWithTs(from, spec, existing, layout);
  return null;
}

/** tsconfig `paths`: the first target of the longest matching pattern that exists, else its first target. */
function mapPaths(spec: string, paths: TargetLayout['resolution']['paths'], existing: ReadonlySet<string>): string | null {
  let best: { prefix: number; targets: string[]; star: string } | null = null;
  for (const p of paths) {
    const at = p.pattern.indexOf('*');
    const pre = at < 0 ? p.pattern : p.pattern.slice(0, at);
    const post = at < 0 ? '' : p.pattern.slice(at + 1);
    const hit = at < 0 ? spec === p.pattern : spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length;
    if (!hit || (best !== null && best.prefix >= pre.length)) continue;
    best = { prefix: pre.length, targets: p.targets, star: at < 0 ? '' : spec.slice(pre.length, spec.length - post.length) };
  }
  if (best === null) return null;
  const candidates = best.targets.flatMap((t) => {
    const r = resolveJoined(posix.normalize(t.replace('*', best?.star ?? '')), existing);
    return r === null ? [] : [r];
  });
  return candidates.find((c) => existing.has(c)) ?? candidates[0] ?? null;
}

/**
 * ts.resolveModuleName with the API's compiler options for what only the type checker knows
 * (package.json `imports` subpaths). Files are looked up in `existing` first, then on disk.
 */
function resolveWithTs(from: string, spec: string, existing: ReadonlySet<string>, layout: TargetLayout): string | null {
  const tsconfig = layout.resolution.tsconfig;
  if (tsconfig === null) return null;
  const apiRoot = posix.dirname(tsconfig.split('\\').join('/'));
  const toRel = (abs: string): string | null => {
    const rel = posix.relative(apiRoot, abs.split('\\').join('/'));
    return rel.startsWith('..') || posix.isAbsolute(rel) ? null : rel;
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => {
      const rel = toRel(f);
      return (rel !== null && existing.has(rel)) || ts.sys.fileExists(f);
    },
    readFile: (f) => ts.sys.readFile(f),
    directoryExists: (d) => ts.sys.directoryExists(d),
    realpath: (p) => p,
  };
  for (const mode of [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS] as const) {
    const out = ts.resolveModuleName(spec, join(apiRoot, from), layout.resolution.options, host, undefined, undefined, mode).resolvedModule;
    if (out === undefined || out.isExternalLibraryImport === true) continue;
    const rel = toRel(out.resolvedFileName);
    if (rel !== null && !rel.split('/').includes('node_modules')) return rel;
  }
  return null;
}

function reachable(start: string, edges: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const t of edges.get(next) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return seen;
}

/**
 * Whether `target` is governed source (TypeScript under a source root; not a test, test support or
 * tooling config) or its import closure reaches such a file.
 */
export function reachesSource(target: string, edges: ReadonlyMap<string, string[]>, layout: TargetLayout = activeLayout()): boolean {
  // Non-TypeScript modules (e.g. a JSON file) count when they sit under an explicit source root, as src/ always did.
  const governed = (f: string): boolean => isSourcePath(f, layout)
    || (!TS_RE.test(f) && layout.sourceRoots.some((r) => r !== '.' && underRoot(f, r)));
  return [...reachable(target, edges)].some(governed);
}

/** Governed files reachable from `start` (excluding `start`): .ts anywhere, anything under a source root; never tests or test support. */
function closure(start: string, edges: ReadonlyMap<string, string[]>, layout: TargetLayout): string[] {
  const seen = reachable(start, edges);
  seen.delete(start);
  return [...seen].filter((f) => !isTestPath(f, layout) && !isTestSupportPath(f, layout)
    && (TS_RE.test(f) || layout.sourceRoots.some((r) => r !== '.' && underRoot(f, r)))).sort();
}

function normalizeSource(p: string): string {
  const clean = posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  return clean.replace(/\.([cm]?)js$/, '.$1ts');
}

/** Basename without extension and without a trailing .test/.spec. */
function stem(p: string): string {
  return posix.basename(p).replace(/\.[cm]?[jt]s$/, '').replace(/\.(test|spec)$/, '');
}

// ───────────────────────────── test cases ─────────────────────────────

const CASE_FNS = new Set(['it', 'test']);
const SUITE_FNS = new Set(['describe', 'suite']);
const ALIASES = new Map([['xit', 'it'], ['xtest', 'test'], ['fit', 'it'], ['xdescribe', 'describe'], ['fdescribe', 'describe']]);
const TABLE_MODS = new Set(['each', 'for']);

/** One test case found statically in a test file. */
export interface StaticTestCase {
  /** "describe > ... > title" ('<dynamic>' for a non-literal title), as the test-preservation hook keys cases. */
  name: string;
  /** How to recognise the case's runtime results: an exact key, or a pattern (table/dynamic titles). */
  match: { exact: string } | { pattern: RegExp };
  /** sha256 of the callback body's tokens (comments and whitespace dropped); undefined without a callback. */
  bodyHash?: string;
  /**
   * Some expect() subject of the case (or a same-file assertion helper it calls) uses the value of a binding
   * imported from a module that reaches src/, or of a variable derived from one (in the case, or assigned at
   * file level, e.g. in a beforeEach). `void x` / `typeof x` do not count.
   */
  exercisesSource: boolean;
  /** No expect(...) at all, or every expect(subject) has a constant subject. */
  constantOnly: boolean;
}

/** How the case analysis resolves the file's relative imports. */
export interface CaseResolver {
  /** API-relative target of a relative specifier, or null (package, escape). */
  resolve(spec: string): string | null;
  /** The target is under src/ or its import closure reaches src/. */
  reachesSource(target: string): boolean;
}

interface Chain {
  root: string | null;
  mods: string[];
}

/** Root identifier and modifier names of a callee like `it.skip`, `describe.each([...])`, `test.skipIf(x)`. */
function calleeChain(expr: ts.Expression): Chain {
  const mods: string[] = [];
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      mods.push(cur.name.text);
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isIdentifier(cur)) {
      return { root: ALIASES.get(cur.text) ?? cur.text, mods };
    } else {
      return { root: null, mods };
    }
  }
}

function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  return call.arguments.slice(1).find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One key segment as a regex source: '<dynamic>' matches anything; a table title's placeholders match anything. */
function segmentSource(title: string | null, table: boolean): string {
  if (title === null) return '.*';
  if (!table) return escapeRe(title);
  return title.split(/%[sdifjoOc#]|\$[A-Za-z_][\w.]*/).map(escapeRe).join('.*');
}

/** Identifiers bound by a declaration name (`a`, `{ a, b: c }`, `[d, ...e]`). */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) out.push(...bindingNames(el.name));
  return out;
}

/** Whether an identifier is a value reference (not a property name / declaration name / label). */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
    || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)
    || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

/** Names declared anywhere inside `node` (parameters, variables, functions, classes, catch bindings). */
function declaredNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
      for (const x of bindingNames(n.name)) out.add(x);
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name !== undefined) {
      out.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * Whether `node` references one of `names` (minus `shadowed`) or dynamically imports / require()s a module that reaches source.
 * With `valueOnly`, operands of `void` and `typeof` do not count (they never use the value).
 */
function usesSource(node: ts.Node, names: ReadonlySet<string>, shadowed: ReadonlySet<string>, r: CaseResolver, valueOnly = false): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (valueOnly && (ts.isVoidExpression(n) || ts.isTypeOfExpression(n))) return;
    if (ts.isIdentifier(n) && names.has(n.text) && !shadowed.has(n.text) && isReference(n)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireCall(n))) {
      const arg = n.arguments[0];
      const target = arg !== undefined && ts.isStringLiteralLike(arg) ? r.resolve(arg.text) : null;
      if (target !== null && r.reachesSource(target)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `x = e` / `x ??= e` (identifier targets only): [name, value]. */
function assignmentOf(n: ts.Node): [string, ts.Expression] | null {
  if (!ts.isBinaryExpression(n) || !ts.isIdentifier(n.left)) return null;
  const k = n.operatorToken.kind;
  if (k < ts.SyntaxKind.FirstAssignment || k > ts.SyntaxKind.LastAssignment) return null;
  return [n.left.text, n.right];
}

/** Grow `tainted` with names in `scope` declared or assigned from a value that uses a tainted name (fixpoint). */
function propagate(scope: ts.Node, tainted: Set<string>, eligible: (name: string) => boolean, r: CaseResolver): void {
  const flows: Array<{ names: string[]; value: ts.Node }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer !== undefined) flows.push({ names: bindingNames(n.name), value: n.initializer });
    const a = assignmentOf(n);
    if (a !== null && eligible(a[0])) flows.push({ names: [a[0]], value: a[1] });
    ts.forEachChild(n, visit);
  };
  visit(scope);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of flows) {
      const names = f.names.filter((x) => eligible(x) && !tainted.has(x));
      if (names.length === 0 || !usesSource(f.value, tainted, new Set(), r)) continue;
      for (const x of names) tainted.add(x);
      grew = true;
    }
  }
}

/** The source tokens of `node` (comments and whitespace dropped; literals keep their exact text). */
function bodyTokens(node: ts.Node, sf: ts.SourceFile, out: string[] = []): string[] {
  if (ts.isJSDoc(node)) return out;
  const kids = node.getChildren(sf);
  if (kids.length === 0) out.push(node.getText(sf));
  for (const k of kids) bodyTokens(k, sf, out);
  return out;
}

/** A literal, true/false/null/undefined, a template without substitutions, or array/object literals of constants. */
export function isConstantExpression(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return isConstantExpression(e.expression);
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isBigIntLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
    || ts.isRegularExpressionLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e)) return ['undefined', 'NaN', 'Infinity'].includes(e.text);
  if (ts.isVoidExpression(e)) return isConstantExpression(e.expression);
  if (ts.isPrefixUnaryExpression(e)) return isConstantExpression(e.operand);
  if (ts.isBinaryExpression(e)) return isConstantExpression(e.left) && isConstantExpression(e.right);
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => !ts.isSpreadElement(x) && !ts.isOmittedExpression(x) && isConstantExpression(x));
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isConstantExpression(p.initializer));
  }
  return false;
}

/**
 * expect(x) / expect.soft(x): the subject. A chained assertion method `<chain>.expect(...)` (supertest:
 * `request(app).post(...).expect(201)`) asserts on its receiver chain, so the chain is the subject.
 * Anything else (expect.assertions(n), assert(...)): undefined.
 */
function expectSubject(call: ts.CallExpression): ts.Expression | undefined {
  const c = call.expression;
  const isExpect = (ts.isIdentifier(c) && c.text === 'expect')
    || (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'expect' && c.name.text === 'soft');
  if (isExpect) return call.arguments[0];
  const chained = ts.isPropertyAccessExpression(c) && c.name.text === 'expect'
    && !(ts.isIdentifier(c.expression) && c.expression.text === 'expect') && call.arguments.length > 0;
  return chained ? c.expression : undefined;
}

/**
 * The test cases of a vitest file, with the evidence the observed-red rule needs:
 * a hash of each callback body, whether the case uses code imported from (a module
 * that reaches) src/, and whether its assertions only compare constants.
 */
export function staticTestCases(fileName: string, content: string, r: CaseResolver): StaticTestCase[] {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Modules the file vi.mock()s: bindings imported from them are mocks, not source.
  const mocked = new Set<string>();
  const findMocks = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isViCall(n, ['mock', 'doMock'])) {
      const arg = n.arguments[0];
      const target = arg !== undefined && ts.isStringLiteralLike(arg) ? r.resolve(arg.text) : null;
      if (target !== null) mocked.add(target);
    }
    ts.forEachChild(n, findMocks);
  };
  findMocks(sf);

  // Bindings imported from a relative module that reaches src/ (a side-effect-only import binds nothing).
  const tainted = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const target = r.resolve(st.moduleSpecifier.text);
    if (target === null || mocked.has(target) || !r.reachesSource(target)) continue;
    if (clause.name !== undefined) tainted.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamespaceImport(nb)) tainted.add(nb.name.text);
    if (nb !== undefined && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) tainted.add(el.name.text);
  }

  // File-level declarations: names they bind and the node that defines them. Taint flows through them
  // (`const app = createApp()`, `async function createUser() { … app … }`).
  const decls: Array<{ names: string[]; node: ts.Node }> = [];
  const helpers = new Map<string, ts.Node>();
  const fileVars = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        for (const x of bindingNames(d.name)) fileVars.add(x);
        if (d.initializer === undefined) continue;
        decls.push({ names: bindingNames(d.name), node: d.initializer });
        if (ts.isIdentifier(d.name) && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          helpers.set(d.name.text, d.initializer);
        }
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined) {
      decls.push({ names: [st.name.text], node: st });
      if (ts.isFunctionDeclaration(st)) helpers.set(st.name.text, st);
    }
  }
  // Suite scopes: declarations directly in a describe(...) callback body (outside any case) are shared by
  // the cases and hooks of that suite, exactly like file-level ones.
  const suiteScopes = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const { root } = calleeChain(n.expression);
      if (root !== null && CASE_FNS.has(root)) return; // never descend into a case: its locals are case-scoped
      if (root !== null && SUITE_FNS.has(root)) {
        for (const arg of n.arguments) {
          if (!(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) || !ts.isBlock(arg.body)) continue;
          for (const st of arg.body.statements) {
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
              for (const x of bindingNames(d.name)) fileVars.add(x);
              if (d.initializer !== undefined) decls.push({ names: bindingNames(d.name), node: d.initializer });
            }
          }
        }
      }
    }
    ts.forEachChild(n, suiteScopes);
  };
  suiteScopes(sf);
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decls) {
      if (d.names.every((n) => tainted.has(n)) || !usesSource(d.node, tainted, new Set(), r)) continue;
      for (const n of d.names) tainted.add(n);
      grew = true;
    }
  }
  // A file-level variable assigned from source anywhere (`let app; beforeEach(() => { app = createApp(); })`).
  propagate(sf, tainted, (x) => fileVars.has(x), r);

  // expect() subjects in a callback, following calls to same-file helper functions.
  const subjects = (start: ts.Node): ts.Expression[] => {
    const out: ts.Expression[] = [];
    const seen = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const subject = expectSubject(n);
        if (subject !== undefined) out.push(subject);
        const helper = ts.isIdentifier(n.expression) ? helpers.get(n.expression.text) : undefined;
        if (helper !== undefined && !seen.has(helper)) {
          seen.add(helper);
          visit(helper);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(start);
    return out;
  };

  /**
   * Whether the case ASSERTS ON source: some expect() subject uses (the value of) a binding imported
   * from src/ or derived from one in the case or file, or a same-file assertion helper is handed such a
   * value (or asserts on one itself). `void x` / `typeof x` and unrelated statements do not count.
   */
  const assertsOnSource = (cb: ts.ArrowFunction | ts.FunctionExpression): boolean => {
    const shadowed = declaredNames(cb);
    const live = new Set([...tainted].filter((x) => !shadowed.has(x)));
    propagate(cb, live, (x) => shadowed.has(x), r);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const subject = expectSubject(n);
        if (subject !== undefined && usesSource(subject, live, new Set(), r, true)) {
          found = true;
          return;
        }
        const helper = ts.isIdentifier(n.expression) && !shadowed.has(n.expression.text) ? helpers.get(n.expression.text) : undefined;
        if (helper !== undefined && subjects(helper).length > 0
          && (n.arguments.some((a) => usesSource(a, live, new Set(), r, true))
            || subjects(helper).some((x) => usesSource(x, tainted, declaredNames(helper), r, true)))) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(cb.body);
    return found;
  };

  const out: StaticTestCase[] = [];
  // `patterned`: some segment of the key is a table title or a dynamic title, so match runtime titles by pattern.
  const visit = (node: ts.Node, titles: string[], sources: string[], patterned: boolean): void => {
    if (ts.isCallExpression(node)) {
      const { root, mods } = calleeChain(node.expression);
      const first = node.arguments[0];
      const literal = first !== undefined && ts.isStringLiteralLike(first) ? first.text : null;
      const table = mods.some((m) => TABLE_MODS.has(m));
      const title = literal ?? '<dynamic>';
      const source = segmentSource(literal, table);
      const pat = patterned || table || literal === null;
      if (root !== null && SUITE_FNS.has(root)) {
        for (const arg of node.arguments.slice(1)) visit(arg, [...titles, title], [...sources, source], pat);
        return;
      }
      if (root !== null && CASE_FNS.has(root)) {
        const name = [...titles, title].join(' > ');
        const cb = callbackOf(node);
        const tc: StaticTestCase = {
          name,
          match: pat ? { pattern: new RegExp(`^${[...sources, source].join(' > ')}$`, 's') } : { exact: name },
          exercisesSource: false,
          constantOnly: true,
        };
        if (cb !== undefined) {
          // The whole call: title, callback, options, timeout and any .each table decide the result.
          tc.bodyHash = createHash('sha256').update(bodyTokens(node, sf).join(' ')).digest('hex');
          const subs = subjects(cb.body);
          tc.constantOnly = subs.length === 0 || subs.every(isConstantExpression);
          tc.exercisesSource = assertsOnSource(cb);
        }
        out.push(tc);
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, titles, sources, patterned));
  };
  visit(sf, [], [], false);
  return out;
}
