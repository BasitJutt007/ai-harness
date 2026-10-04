/**
 * Static analysis of test files: the import graph between tests and source, and
 * the test cases inside a test file.
 *
 * Deterministic: parses with the TypeScript parser (no type checking), resolves
 * relative specifiers the way NodeNext + TS do for .ts sources, and keeps targets
 * that do not exist yet as nodes (a test may import a module the agent has not
 * written; that is exactly the "observed red" case).
 *
 * ONE definition of a test file for the whole harness:
 *   - a runnable test file is `*.test.ts` / `*.spec.ts` (also .mts/.cts) anywhere;
 *   - test support code is any other file under test/ (helpers, fixtures): writable
 *     without a red, never run as a test, never "covered" by a test.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { posix } from 'node:path';
import type { TestMap, Workspace } from './types.ts';

const TEST_RE = /\.(test|spec)\.[cm]?ts$/;
const TS_RE = /\.[cm]?ts$/;

/** A runnable test file: `*.test|spec.(c|m)?ts` anywhere under the API root. */
export function isTestFile(rel: string): boolean {
  return TEST_RE.test(rel);
}

/** Test support code: any other file under test/ (helpers, fixtures). Never a runnable test, never covered. */
export function isTestSupport(rel: string): boolean {
  return rel.startsWith('test/') && !isTestFile(rel);
}

/** Import graph over API-relative .ts files: file -> resolved relative import targets. */
export interface ImportGraph {
  existing: ReadonlySet<string>;
  edges: ReadonlyMap<string, string[]>;
}

export async function importGraph(files: string[], read: (rel: string) => Promise<string | null>): Promise<ImportGraph> {
  const existing = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const text = (await read(file)) ?? '';
    const targets = new Set<string>();
    for (const spec of importSpecifiers(file, text)) {
      const target = resolveSpecifier(file, spec, existing);
      if (target !== null) targets.add(target);
    }
    edges.set(file, [...targets].sort());
  }
  return { existing, edges };
}

/** Every .ts file under the API root the graph is built over (no .d.ts, no build output). */
export function graphFiles(listed: string[]): string[] {
  return listed.filter((f) => !/\.d\.[cm]?ts$/.test(f) && !f.startsWith('dist/') && !f.includes('/dist/')).sort();
}

export async function buildTestMap(ws: Workspace): Promise<TestMap> {
  // Every .ts file under the API root: governed files outside src/ are covered through imports too.
  const files = graphFiles(await ws.list(['**/*.ts', '**/*.mts', '**/*.cts']));
  const graph = await importGraph(files, (f) => ws.read(f));
  const coverage: Record<string, string[]> = {};
  for (const test of files.filter(isTestFile)) coverage[test] = closure(test, graph.edges);
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

/** Every module specifier a file references: import/export-from, dynamic import(lit), vi.mock(lit) & friends. */
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
  return isViCall(call, ['mock', 'doMock', 'importActual', 'importMock']);
}

function isViCall(call: ts.CallExpression, names: string[]): boolean {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi'
    && names.includes(callee.name.text);
}

/**
 * Resolve a relative specifier from `from` (API-relative) to an API-relative path.
 * `./x.js` → `./x.ts`; `./x` → `./x.ts` or `./x/index.ts` (whichever exists, else `./x.ts`).
 * Non-relative specifiers and paths escaping the API root → null.
 */
export function resolveSpecifier(from: string, spec: string, existing: ReadonlySet<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  if (joined.startsWith('../') || joined === '..') return null;
  const jsMatch = /\.([cm]?)js$/.exec(joined);
  if (jsMatch !== null) return `${joined.slice(0, -jsMatch[0].length)}.${jsMatch[1] ?? ''}ts`;
  if (/\.[cm]?ts$/.test(joined)) return joined;
  if (/\.[a-z0-9]+$/i.test(joined) && !existing.has(`${joined}.ts`)) return joined; // e.g. ./data.json
  if (existing.has(`${joined}.ts`)) return `${joined}.ts`;
  if (existing.has(`${joined}/index.ts`)) return `${joined}/index.ts`;
  return `${joined}.ts`;
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

/** Whether `target` is under src/ or its import closure reaches a file under src/. */
export function reachesSource(target: string, edges: ReadonlyMap<string, string[]>): boolean {
  return [...reachable(target, edges)].some((f) => f.startsWith('src/'));
}

/** Governed files reachable from `start` (excluding `start`): .ts anywhere, anything under src/; never tests or test support. */
function closure(start: string, edges: ReadonlyMap<string, string[]>): string[] {
  const seen = reachable(start, edges);
  seen.delete(start);
  return [...seen].filter((f) => !isTestFile(f) && !isTestSupport(f) && (TS_RE.test(f) || f.startsWith('src/'))).sort();
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
const HOOK_FNS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
const ALIASES = new Map([['xit', 'it'], ['xtest', 'test'], ['fit', 'it'], ['xdescribe', 'describe'], ['fdescribe', 'describe']]);
const TABLE_MODS = new Set(['each', 'for']);
/** Callee roots that are test structure, never an assertion of their own (expect chains are recognised separately). */
const STRUCTURE = new Set([...CASE_FNS, ...SUITE_FNS, ...HOOK_FNS, ...ALIASES.keys(), 'vi', 'expect']);

/** The statement a runner failure points at, judged in the scope it runs in. */
export interface FailedStatement {
  /** It (or a condition guarding it) uses a value imported from src/ or derived from one. */
  usesSource: boolean;
  /** It names no value at all besides callees and literals (`expect(1).toBe(2)`, `assert.fail('x')`, `throw new Error('x')`). */
  constant: boolean;
}

/** One test case found statically in a test file. */
export interface StaticTestCase {
  /** "describe > ... > title" ('<dynamic>' for a non-literal title), as the test-preservation hook keys cases. */
  name: string;
  /** How to recognise the case's runtime results: an exact key, or a pattern (table/dynamic titles). */
  match: { exact: string } | { pattern: RegExp };
  /** sha256 of the callback body's tokens (comments and whitespace dropped); undefined without a callback. */
  bodyHash?: string;
  /**
   * Some assertion of the case (or of a same-file helper it calls) uses the value of a binding imported from a
   * module that reaches src/, or of a variable derived from one (in the case, or assigned at file level, e.g. in
   * a beforeEach). An assertion is an expect() subject, a supertest-style `.expect()` receiver, or the arguments
   * of a call made only for its effect on a function the file imports or declares (`assert.equal(a, b)`,
   * `assert(ok)`, `expectCreated(res)`): any assertion library. `void x` / `typeof x` do not count.
   */
  exercisesSource: boolean;
  /** No assertion at all, or every assertion has only constant subjects. */
  constantOnly: boolean;
  /**
   * The statement at a character offset of the file (a stack frame of a runner failure), when the offset lies
   * in this case's callback or in a same-file function it may call (setup hooks excluded); else undefined.
   */
  statementAt?: (offset: number) => FailedStatement | undefined;
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
 * Whether `node` references one of `names` (minus `shadowed`) or dynamically imports a module that reaches src/.
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
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
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

/** Runner globals that are assertion APIs (vitest's `globals: true` exposes chai's `assert`). */
const GLOBAL_ASSERTIONS = ['assert'];

/**
 * The call of a statement made only for its effect (`f(…);`, `await f(…);`) whose callee is rooted at one of
 * `callees` (assertion APIs: bindings imported from an assertion library or from test code), other than test
 * structure and expect chains: what an assertion of any library looks like (`assert.equal(a, b)`,
 * `assert(ok)`, `expectCreated(res)`). Its arguments are its subjects. Calls on data (`ids.push(x)`), on
 * globals (`console.log(x)`) and into the code under test are not.
 */
function effectCall(n: ts.Node, callees: ReadonlySet<string>): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(n)) return undefined;
  let e: ts.Expression = n.expression;
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e) || expectSubject(e) !== undefined) return undefined;
  const { root } = calleeChain(e.expression);
  return root !== null && !STRUCTURE.has(root) && callees.has(root) ? e : undefined;
}

/**
 * Names an assertion can be made through: value bindings imported from a package (an assertion library,
 * node:assert) or from test code (a helper module), and the runner's global `assert`. Never a binding
 * imported from the code under test: calling it exercises it, it does not assert.
 */
function assertionCallees(sf: ts.SourceFile, r: CaseResolver): Set<string> {
  const out = new Set(GLOBAL_ASSERTIONS);
  const testSide = (spec: string): boolean => {
    const target = r.resolve(spec);
    return target === null ? !spec.startsWith('.') && !spec.startsWith('/') : isTestFile(target) || isTestSupport(target);
  };
  for (const st of sf.statements) {
    if (ts.isImportEqualsDeclaration(st) && !st.isTypeOnly && ts.isExternalModuleReference(st.moduleReference)
      && ts.isStringLiteral(st.moduleReference.expression) && testSide(st.moduleReference.expression.text)) out.add(st.name.text);
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !testSide(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) out.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamespaceImport(nb)) out.add(nb.name.text);
    if (nb !== undefined && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) out.add(el.name.text);
  }
  return out;
}

/** A statement, a block or a declaration: a frame inside a nested one is judged by that one. */
function isStatementNode(n: ts.Node): boolean {
  return ts.isBlock(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
    || (n.kind >= ts.SyntaxKind.FirstStatement && n.kind <= ts.SyntaxKind.LastStatement);
}

/** An identifier in callee position (`f` in `f(x)`, `a` and `b` in `a.b(x)`, `E` in `new E(x)`). */
function isCallee(id: ts.Identifier): boolean {
  let n: ts.Node = id;
  while (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) n = n.parent;
  const p = n.parent;
  return (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n;
}

/** Judge one statement without its nested statements: does it use `names` (values only), and is it constant-only? */
function judgeStatement(st: ts.Node, names: ReadonlySet<string>, r: CaseResolver): FailedStatement {
  let usesSource = false;
  let constant = true;
  const visit = (n: ts.Node): void => {
    if (n !== st && isStatementNode(n)) return;
    if (ts.isVoidExpression(n) || ts.isTypeOfExpression(n)) return;
    if (ts.isIdentifier(n) && isReference(n)) {
      if (names.has(n.text)) usesSource = true;
      if (!isCallee(n) && !['undefined', 'NaN', 'Infinity'].includes(n.text)) constant = false;
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      const target = arg !== undefined && ts.isStringLiteralLike(arg) ? r.resolve(arg.text) : null;
      if (target !== null && r.reachesSource(target)) usesSource = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(st);
  return { usesSource, constant: constant && !usesSource };
}

/** Conditions and iterated values of the statements that control whether `n` runs (`if (c) …`, `for (x of xs) …`), up to `stop`. */
function guards(n: ts.Node, stop: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (let cur: ts.Node = n; cur !== stop && cur.parent !== undefined; cur = cur.parent) {
    const p = cur.parent;
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p))
      && p.expression !== cur) out.push(p.expression);
    else if (ts.isForStatement(p) && p.condition !== undefined && p.condition !== cur) out.push(p.condition);
  }
  return out;
}

/** The innermost statement of `region` (a function body) containing `offset`, if any. */
function statementIn(region: ts.Node, offset: number, sf: ts.SourceFile): ts.Node | undefined {
  if (offset < region.getStart(sf) || offset >= region.getEnd()) return undefined;
  let found: ts.Node = region;
  const visit = (n: ts.Node): void => {
    if (offset < n.getStart(sf) || offset >= n.getEnd()) return;
    if (isStatementNode(n)) found = n;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(region, visit);
  return found;
}

/** Name (first line, before `:` or ` [`) of an error a runner reports, as in "AssertionError [ERR_ASSERTION]: …". */
function errorName(message: string): string {
  const first = (message.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return /^([\w$.]+)(?:\s*\[[^\]]*\])?:/.exec(first)?.[1] ?? '';
}

/**
 * A runner failure raised by an assertion (any library: vitest/chai `AssertionError`, node:assert
 * `AssertionError [ERR_ASSERTION]`, jest `JestAssertionError` / `expect(received)…`), not a crash or a
 * hand-thrown Error.
 */
export function isAssertionFailure(message: string): boolean {
  const first = (message.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return /assert/i.test(errorName(message)) || /^(?:Error: )?expect\(/.test(first);
}

/**
 * Character offsets into `content` of the stack frames of a runner failure message that point into
 * `file` (API-relative; frames carry absolute paths or file:// URLs), innermost first.
 */
export function failureOffsets(message: string, file: string, content: string): number[] {
  const starts = [0];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
  const out: number[] = [];
  for (const line of message.split('\n')) {
    const m = /^\s*at (?:.*?\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (m === null) continue;
    let p = (m[1] ?? '').replace(/\\/g, '/');
    if (p.startsWith('file://')) {
      try {
        p = decodeURIComponent(p.slice('file://'.length));
      } catch {
        continue;
      }
    }
    if (p !== file && !p.endsWith(`/${file}`)) continue;
    const start = starts[Number(m[2]) - 1];
    if (start !== undefined) out.push(start + Number(m[3]) - 1);
  }
  return out;
}

/**
 * The red verdict for a failing case from where it failed: the innermost frame in the case (or a same-file
 * function it called) must not be a constant-only statement, some frame's statement (or a condition guarding
 * it) must use a value from src/, and the failure must be an assertion error, or else the case must also
 * qualify statically (a crash inside an assertion on src/, a supertest `.expect()` error). null when no frame
 * of the messages points into the case: the static verdict stands.
 */
export function locatedRed(s: StaticTestCase, messages: string[], file: string, content: string): { exercisesSource: boolean; constantOnly: boolean } | null {
  for (const m of messages) {
    const judged = failureOffsets(m, file, content).flatMap((o) => s.statementAt?.(o) ?? []);
    const innermost = judged[0];
    if (innermost === undefined) continue;
    const counts = !innermost.constant && judged.some((j) => j.usesSource)
      && (isAssertionFailure(m) || (s.exercisesSource && !s.constantOnly));
    return counts ? { exercisesSource: true, constantOnly: false } : { exercisesSource: false, constantOnly: innermost.constant || s.constantOnly };
  }
  return null;
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

  const callees = assertionCallees(sf, r);

  // Assertion subjects in a callback (expect() subjects, supertest-style `.expect()` receivers, arguments
  // of an assertion API call), following calls to same-file helper functions.
  const subjects = (start: ts.Node): ts.Expression[] => {
    const out: ts.Expression[] = [];
    const seen = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      const effect = effectCall(n, callees);
      if (effect !== undefined) out.push(...effect.arguments);
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

  /** Names that hold a value from source inside a function: the file's, minus its own declarations, plus what it derives from them. */
  const liveIn = (fn: ts.Node): Set<string> => {
    const shadowed = declaredNames(fn);
    const live = new Set([...tainted].filter((x) => !shadowed.has(x)));
    propagate(fn, live, (x) => shadowed.has(x), r);
    return live;
  };

  /**
   * Whether the case ASSERTS ON source: some assertion subject (expect(), a supertest `.expect()` chain, the
   * arguments of any assertion API call) uses (the value of) a binding imported from src/ or derived from one
   * in the case or file, or a same-file assertion helper is handed such a value (or asserts on one itself).
   * `void x` / `typeof x` and unrelated statements do not count.
   */
  const assertsOnSource = (cb: ts.ArrowFunction | ts.FunctionExpression, live: ReadonlySet<string>): boolean => {
    const shadowed = declaredNames(cb);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      const effect = effectCall(n, callees);
      if (effect !== undefined && !shadowed.has(calleeChain(effect.expression).root ?? '')
        && effect.arguments.some((a) => usesSource(a, live, new Set(), r, true))) {
        found = true;
        return;
      }
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

  // Same-file helper bodies a failure frame may point into, with the names live in each (computed once).
  let helperRegions: Array<{ body: ts.Node; live: ReadonlySet<string> }> | undefined;
  const regionsOf = (cb: ts.ArrowFunction | ts.FunctionExpression, live: ReadonlySet<string>): Array<{ body: ts.Node; live: ReadonlySet<string> }> => {
    helperRegions ??= [...new Set(helpers.values())].map((h) => ({ body: h, live: liveIn(h) }));
    return [{ body: cb.body, live }, ...helperRegions];
  };
  /** The statement at `offset` in the case callback or a same-file helper, judged in the scope it runs in. */
  const statementAt = (cb: ts.ArrowFunction | ts.FunctionExpression, live: ReadonlySet<string>) => (offset: number): FailedStatement | undefined => {
    for (const region of regionsOf(cb, live)) {
      const st = statementIn(region.body, offset, sf);
      if (st === undefined) continue;
      const judged = judgeStatement(st, region.live, r);
      const guarded = guards(st, region.body).some((g) => usesSource(g, region.live, new Set(), r, true));
      return { usesSource: judged.usesSource || guarded, constant: judged.constant };
    }
    return undefined;
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
          const live = liveIn(cb);
          tc.constantOnly = subs.length === 0 || subs.every(isConstantExpression);
          tc.exercisesSource = assertsOnSource(cb, live);
          tc.statementAt = statementAt(cb, live);
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
