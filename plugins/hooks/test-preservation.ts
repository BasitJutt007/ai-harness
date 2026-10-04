/**
 * test-preservation (pre, write of a test file that existed when the run started):
 * pre-existing tests are APPEND-ONLY. Every test case (and setup hook) that existed at run
 * start keeps its title, stays enabled, and keeps its original statements verbatim and in
 * order; new statements may only be appended after them. No new setup hook may be added where
 * it would run before existing cases, and no new mock may be added to a file with existing
 * cases (a mock changes what every existing assertion runs against).
 *
 * "Original" means the content at run start: the run-start snapshot (state.initialHashes) is
 * the authority, and the hook recovers the matching text from the workspace the first time it
 * sees the file (cached in scratch) or, if the file was already changed by other means, from
 * the base commit (`git show <baseSha>:<path>`). If neither matches the snapshot the write is
 * refused (fail closed). Comparing with the run-start content, not the previous write, means a
 * chain of individually harmless edits can never walk an assertion away.
 *
 * Test support code (any other file under test/, e.g. helpers) that existed at run start is
 * read-only: existing cases depend on it, so editing it could gut them without touching them.
 *
 * A brownfield task with `allowBreaking: true` may change bodies and support code (behaviour
 * is allowed to change), but still may not remove, rename or disable an existing case.
 * Tests the agent wrote during the run are its own and stay freely editable.
 */
import { posix } from 'node:path';
import ts from 'typescript';
import { defineHook } from '../../src/core/plugin-api.ts';
import type { HookVerdict, RunContext, RunState, ToolCallInfo } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { postImage } from '../lib/post-image.ts';
import { isTestFile, isTestSupport, sha256 } from '../lib/red.ts';

const CASE_FNS = new Set(['it', 'test']);
const SUITE_FNS = new Set(['describe', 'suite']);
const HOOK_FNS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
const DISABLING = new Set(['skip', 'todo', 'only', 'skipIf', 'runIf', 'fails']);
const DISABLED_ALIASES = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']);
/** vi.mock is hoisted to the top of the file by vitest, wherever it is written. */
const MOCK_ANYWHERE = new Set(['mock']);
/** These change module/global behaviour when they run at collection time (outside a case or hook). */
const MOCK_AT_COLLECTION = new Set(['doMock', 'hoisted', 'spyOn', 'stubGlobal', 'stubEnv']);

export interface TestCase {
  /** "describe > ... > title" ("<dynamic>" for non-literal titles). */
  key: string;
  /** A modifier (skip/todo/only/skipIf/runIf/fails) applies to the case or an enclosing suite. */
  disabled: boolean;
  line: number;
}

/** A test case, setup hook or suite with its locked parts, normalised (comments and whitespace removed). */
export interface TestBlock extends TestCase {
  kind: 'case' | 'hook' | 'suite';
  /** Enclosing describe titles. */
  suites: string[];
  /** Callee and every argument except the callback: `it.each([..])`, title, options, timeout. */
  header: string;
  /** Top-level statements of the callback, one normalised string each (tokens joined by one space). */
  body: string[];
  /** Line of each body statement. */
  bodyLines: number[];
  /** Readable form of `header` and of each `body` statement, for messages. */
  display: { header: string; body: string[] };
}

interface MockCall {
  /** Comparison form (tokens). */
  text: string;
  display: string;
  line: number;
}

interface ImportInfo {
  spec: string;
  /** Local names bound with a runtime value (type-only bindings excluded). */
  names: string[];
  sideEffect: boolean;
  line: number;
}

/** A statement that runs at collection time (top level, or directly in a describe callback) and is not a case, hook, suite or mock. */
interface CollectionStatement {
  /** Enclosing suite key ('' = top level). */
  scope: string;
  text: string;
  display: string;
  line: number;
  node: ts.Statement;
}

interface ParsedFile {
  blocks: TestBlock[];
  mocks: MockCall[];
  imports: ImportInfo[];
  collection: CollectionStatement[];
  /** Call node and callback of each block. */
  nodes: Map<TestBlock, { call: ts.CallExpression; cb: Callback | undefined }>;
  /** Every identifier text in the file (what existing code may refer to). */
  identifiers: Set<string>;
}

const printer = ts.createPrinter({ removeComments: true });

/** Root identifier and modifier names of a callee like `it.skip`, `describe.each([...])`, `test.skipIf(x)`. */
function calleeChain(expr: ts.Expression): { root: string | null; mods: string[] } {
  const mods: string[] = [];
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      mods.push(cur.name.text);
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isIdentifier(cur)) {
      return { root: cur.text, mods };
    } else {
      return { root: null, mods };
    }
  }
}

function titleOf(call: ts.CallExpression): string {
  const a = call.arguments[0];
  return a !== undefined && ts.isStringLiteralLike(a) ? a.text : '<dynamic>';
}

/** `{ skip: true }` / `{ todo: x }` options objects disable a case or suite just like `.skip`. */
function optionsDisable(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some((p) => {
        const name = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '';
        if (!DISABLING.has(name)) return false;
        return !(ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword);
      }),
  );
}

type Callback = ts.ArrowFunction | ts.FunctionExpression;

function callbackOf(call: ts.CallExpression): Callback | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const a = call.arguments[i];
    if (a !== undefined && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) return a;
  }
  return undefined;
}

/** Parse a vitest file into its cases, hooks, suites and mock calls (static analysis). */
function parseTestFile(fileName: string, content: string): ParsedFile {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const print = (n: ts.Node): string => printer.printNode(ts.EmitHint.Unspecified, n, sf);
  /** Comparison form: the node's tokens joined by single spaces (comments and layout never count). */
  const norm = (n: ts.Node): string => {
    const out: string[] = [];
    const walk = (x: ts.Node): void => {
      if (x.kind >= ts.SyntaxKind.FirstJSDocNode && x.kind <= ts.SyntaxKind.LastJSDocNode) return;
      const kids = x.getChildren(sf);
      if (kids.length === 0) {
        const t = x.getText(sf);
        if (t !== '') out.push(t);
      } else {
        for (const k of kids) walk(k);
      }
    };
    walk(n);
    return out.join(' ');
  };
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const blocks: TestBlock[] = [];
  const mocks: MockCall[] = [];
  const nodes = new Map<TestBlock, { call: ts.CallExpression; cb: Callback | undefined }>();

  const block = (kind: TestBlock['kind'], call: ts.CallExpression, key: string, suites: string[], disabled: boolean): TestBlock => {
    const made = blockOf(kind, call, key, suites, disabled);
    nodes.set(made, { call, cb: callbackOf(call) });
    return made;
  };
  const blockOf = (kind: TestBlock['kind'], call: ts.CallExpression, key: string, suites: string[], disabled: boolean): TestBlock => {
    const cb = callbackOf(call);
    const headParts = [call.expression, ...call.arguments.filter((a) => a !== cb)];
    const body: string[] = [];
    const bodyLines: number[] = [];
    const bodyText: string[] = [];
    if (cb !== undefined && kind !== 'suite') {
      if (ts.isBlock(cb.body)) {
        for (const s of cb.body.statements) {
          body.push(norm(s).replace(/ ;$/, '')); // an optional trailing semicolon is layout
          bodyText.push(print(s));
          bodyLines.push(lineOf(s));
        }
      } else {
        // `() => expr` is the statement `expr;`, so turning it into `{ expr; more; }` is an append.
        body.push(norm(cb.body));
        bodyText.push(`${print(cb.body)};`);
        bodyLines.push(lineOf(cb.body));
      }
    }
    return {
      kind,
      key,
      suites,
      disabled,
      line: lineOf(call),
      header: headParts.map(norm).join(' , '),
      body,
      bodyLines,
      display: { header: headParts.map(print).join(', '), body: bodyText },
    };
  };

  /** `inFn`: inside a function that does not run at collection time (case, hook, helper). */
  const visit = (node: ts.Node, suites: string[], disabled: boolean, inFn: boolean): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi') {
        const m = callee.name.text;
        if (MOCK_ANYWHERE.has(m) || (!inFn && MOCK_AT_COLLECTION.has(m))) mocks.push({ text: norm(node), display: print(node), line: lineOf(node) });
      }
      const { root, mods } = calleeChain(callee);
      const aliased = root !== null && DISABLED_ALIASES.has(root);
      const isDisabled = disabled || aliased || mods.some((x) => DISABLING.has(x)) || optionsDisable(node);
      const base = aliased && root !== null ? root.slice(1) : root;
      if (base !== null && SUITE_FNS.has(base)) {
        const inner = [...suites, titleOf(node)];
        blocks.push(block('suite', node, inner.join(' > '), suites, isDisabled));
        // A describe callback runs at collection time: its statements are not "inside a function".
        for (const arg of node.arguments.slice(1)) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) visit(arg.body, inner, isDisabled, inFn);
          else visit(arg, inner, isDisabled, inFn);
        }
        return;
      }
      if (base !== null && CASE_FNS.has(base)) {
        blocks.push(block('case', node, [...suites, titleOf(node)].join(' > '), suites, isDisabled));
        for (const arg of node.arguments) visit(arg, suites, isDisabled, true);
        return;
      }
      if (root !== null && mods.length === 0 && HOOK_FNS.has(root)) {
        blocks.push(block('hook', node, [...suites, root].join(' > '), suites, disabled));
        for (const arg of node.arguments) visit(arg, suites, disabled, true);
        return;
      }
    }
    const fn = ts.isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, suites, disabled, inFn || fn));
  };
  visit(sf, [], false, false);

  const imports: ImportInfo[] = [];
  const collection: CollectionStatement[] = [];
  const blockKind = (st: ts.Statement): 'suite' | 'block' | 'mock' | null => {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return null;
    const callee = st.expression.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi') return 'mock';
    const { root } = calleeChain(callee);
    const base = root !== null && DISABLED_ALIASES.has(root) ? root.slice(1) : root;
    if (base !== null && SUITE_FNS.has(base)) return 'suite';
    return base !== null && (CASE_FNS.has(base) || HOOK_FNS.has(base)) ? 'block' : null;
  };
  const collect = (statements: readonly ts.Statement[], scope: string[]): void => {
    for (const st of statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const c = st.importClause;
        const names: string[] = [];
        if (c !== undefined && !c.isTypeOnly) {
          if (c.name !== undefined) names.push(c.name.text);
          const nb = c.namedBindings;
          if (nb !== undefined && ts.isNamespaceImport(nb)) names.push(nb.name.text);
          if (nb !== undefined && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) names.push(el.name.text);
        }
        imports.push({ spec: st.moduleSpecifier.text, names, sideEffect: c === undefined, line: lineOf(st) });
        continue;
      }
      const kind = blockKind(st);
      if (kind === 'suite' && ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
        const cb = callbackOf(st.expression);
        if (cb !== undefined && ts.isBlock(cb.body)) collect(cb.body.statements, [...scope, titleOf(st.expression)]);
        continue;
      }
      if (kind !== null) continue;
      if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEmptyStatement(st)) continue;
      collection.push({ scope: scope.join(' > '), text: norm(st).replace(/ ;$/, ''), display: print(st), line: lineOf(st), node: st });
    }
  };
  collect(sf.statements, []);
  const identifiers = new Set<string>();
  const ids = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) identifiers.add(n.text);
    ts.forEachChild(n, ids);
  };
  ids(sf);
  return { blocks, mocks, imports, collection, nodes, identifiers };
}

/** Test cases declared in a vitest file (static analysis; nested describes form the key path). */
export function testCases(fileName: string, content: string): TestCase[] {
  return testBlocks(fileName, content)
    .filter((b) => b.kind === 'case')
    .map(({ key, disabled, line }) => ({ key, disabled, line }));
}

/** Cases, setup hooks and suites of a vitest file with their normalised header and body statements. */
export function testBlocks(fileName: string, content: string): TestBlock[] {
  return parseTestFile(fileName, content).blocks;
}

export interface PreservationOptions {
  /** allowBreaking: bodies, headers, hooks and mocks may change; removal/rename/disabling still blocked. */
  allowBodyChanges?: boolean;
}

const snippet = (s: string): string => {
  const one = s.replace(/\s+/g, ' ');
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
};

/** Index of the first original statement that is not kept verbatim at the same position, or -1. */
function firstBrokenStatement(before: string[], after: string[]): number {
  for (let i = 0; i < before.length; i++) if (after[i] !== before[i]) return i;
  return -1;
}

/** Cases are append-only; setup hooks are locked verbatim (anything added there runs before existing cases). */
const bodyKept = (old: TestBlock, now: TestBlock): boolean =>
  firstBrokenStatement(old.body, now.body) === -1 && (old.kind !== 'hook' || now.body.length === old.body.length);

const conforms = (old: TestBlock, now: TestBlock): boolean =>
  now.header === old.header && bodyKept(old, now) && (old.disabled || !now.disabled);

function label(b: TestBlock): string {
  if (b.kind === 'case') return `existing test "${b.key}"`;
  const name = b.key.split(' > ').pop() ?? b.key;
  return b.suites.length === 0 ? `existing top-level ${name}` : `existing ${name} in "${b.suites.join(' > ')}"`;
}

function allowedFor(b: TestBlock): string {
  return b.kind === 'case'
    ? 'append new statements at the end of the case, or add a new test case'
    : `the ${b.key.split(' > ').pop() ?? 'hook'} is locked; put new setup in a new describe block together with the new cases`;
}

/**
 * Human-readable problems (each "file:line  ..."): cases of `before` missing from `after`, newly
 * disabled there, or not append-only; hooks not append-only; new hooks in the scope of existing
 * cases; new mocks in a file that has existing cases.
 */
export function weakenedCases(fileName: string, before: string, after: string, opts: PreservationOptions = {}): string[] {
  const old = parseTestFile(fileName, before);
  const now = parseTestFile(fileName, after);
  const pool = new Map<string, TestBlock[]>();
  for (const b of now.blocks) {
    const id = `${b.kind}\0${b.key}`;
    pool.set(id, [...(pool.get(id) ?? []), b]);
  }
  const problems: string[] = [];
  const oldCases = old.blocks.filter((b) => b.kind === 'case');
  const matched = new Map<TestBlock, TestBlock>();
  for (const o of old.blocks) {
    const candidates = pool.get(`${o.kind}\0${o.key}`) ?? [];
    if (o.kind === 'suite' && !oldCases.some((c) => c.key.startsWith(`${o.key} > `))) {
      candidates.splice(0, 1); // an old suite without cases: not new code, nothing to preserve
      continue;
    }
    if (candidates.length === 0) {
      if (o.kind === 'case') problems.push(`${fileName}:${o.line}  ${label(o)} would be removed or renamed`);
      else if (o.kind === 'hook') problems.push(`${fileName}:${o.line}  ${label(o)} would be removed; ${allowedFor(o)}`);
      continue; // a removed suite is reported through its cases
    }
    let pick = candidates.findIndex((c) => conforms(o, c));
    if (pick < 0) pick = candidates.findIndex((c) => c.disabled === o.disabled);
    if (pick < 0) pick = 0;
    const n = candidates[pick];
    candidates.splice(pick, 1);
    if (n === undefined) continue;
    matched.set(o, n);
    if (n.disabled && !o.disabled) {
      problems.push(`${fileName}:${n.line}  ${label(o)} would be disabled (skip/todo/only/skipIf/runIf/fails)`);
      continue;
    }
    if (opts.allowBodyChanges === true) continue;
    if (n.header !== o.header) {
      const what = o.kind === 'suite' ? `the describe call of "${o.key}"` : `${label(o)}: its call`;
      problems.push(`${fileName}:${n.line}  ${what} changed from \`${snippet(o.display.header)}\` to \`${snippet(n.display.header)}\`; keep it as it was`);
      continue;
    }
    const broken = bodyKept(o, n) ? -1 : Math.max(0, firstBrokenStatement(o.body, n.body));
    if (broken >= 0 && o.kind === 'hook') {
      problems.push(`${fileName}:${n.line}  ${label(o)} was changed; ${allowedFor(o)}`);
    } else if (broken >= 0) {
      const line = n.bodyLines[broken] ?? n.line;
      problems.push(
        `${fileName}:${line}  ${label(o)}: original statement ${broken + 1} of ${o.body.length} \`${snippet(o.display.body[broken] ?? '')}\` ` +
          `was changed, removed or moved (statements may only be appended after the last original one); ${allowedFor(o)}`,
      );
    }
  }
  if (opts.allowBodyChanges === true || oldCases.length === 0) return problems;

  // New hooks whose scope contains existing cases would run before (or between) them.
  for (const rest of pool.values()) {
    for (const b of rest) {
      if (b.kind !== 'hook') continue;
      const scope = b.suites.join(' > ');
      const covers = oldCases.some((c) => b.suites.length === 0 || c.key.startsWith(`${scope} > `));
      if (!covers) continue;
      const name = b.key.split(' > ').pop() ?? 'hook';
      const where = b.suites.length === 0 ? 'at the top level' : `in "${scope}"`;
      problems.push(`${fileName}:${b.line}  new ${name} ${where} would run around existing cases; put it inside a new describe block together with the new cases`);
    }
  }
  // New mocks: a mock changes what every existing case runs against.
  const known = new Map<string, number>();
  for (const m of old.mocks) known.set(m.text, (known.get(m.text) ?? 0) + 1);
  for (const m of now.mocks) {
    const left = known.get(m.text) ?? 0;
    if (left > 0) {
      known.set(m.text, left - 1);
      continue;
    }
    problems.push(
      `${fileName}:${m.line}  new \`${snippet(m.display)}\` in a file with existing cases would change what they run against; ` +
        'put the mock and the cases that need it in a new test file',
    );
  }
  problems.push(...sharedStateChanges(fileName, old, now, matched, pool));
  return problems;
}

// ───────────────────────── shared state: new code must not reach existing cases ─────────────────────────

const SAFE_VI = new Set(['fn', 'waitFor', 'waitUntil', 'isMockFunction', 'mocked', 'mock']); // vi.mock: reported by the mock rule
const GLOBAL_EXPECT = new Set(['extend', 'addSnapshotSerializer', 'addEqualityTesters']);
const PATCHERS: Record<string, ReadonlySet<string> | 'all'> = {
  Object: new Set(['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf']),
  Reflect: 'all',
};

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Names declared anywhere inside `node` (variables, parameters, functions, classes). */
function declaredIn(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) bindingNames(n.name, out);
    else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name !== undefined) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The variable an assignment target ultimately writes to (`a.b[c].d` -> a), or null. */
function targetRoot(e: ts.Expression): ts.Identifier | null {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isParenthesizedExpression(cur)
      || ts.isNonNullExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return ts.isIdentifier(cur) ? cur : null;
  }
}

/**
 * What in `node` (new code in a file with existing cases) could change what existing cases run
 * against: global matcher/serializer registration, vi.* other than vi.fn & co, Object.defineProperty
 * & co, Reflect, dynamic import()/require(), and assignments to variables the new code did not declare.
 */
function sharedEffect(node: ts.Node, locals: ReadonlySet<string>): string | null {
  const own = new Set([...locals, ...declaredIn(node)]);
  let why: string | null = null;
  const visit = (n: ts.Node): void => {
    if (why !== null) return;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (c.kind === ts.SyntaxKind.ImportKeyword) why = 'a dynamic import()';
      else if (ts.isIdentifier(c) && c.text === 'require') why = 'require()';
      else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
        const obj = c.expression.text;
        const m = c.name.text;
        const patch = PATCHERS[obj];
        if (obj === 'vi' && !SAFE_VI.has(m)) why = `vi.${m}()`;
        else if (obj === 'expect' && GLOBAL_EXPECT.has(m)) why = `expect.${m}()`;
        else if (patch !== undefined && (patch === 'all' || patch.has(m))) why = `${obj}.${m}()`;
      }
    }
    const target = ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? n.left
      : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ? n.operand
        : ts.isDeleteExpression(n) ? n.expression : undefined;
    if (target !== undefined && why === null) {
      const root = targetRoot(target);
      if (root === null || !own.has(root.text)) why = `an assignment to \`${snippet(target.getText())}\` (not a variable it declares)`;
    }
    if (why === null) ts.forEachChild(n, visit);
  };
  visit(node);
  return why;
}

/** A function or `var` declaration in appended statements is hoisted above the case's original statements. */
function hoisted(st: ts.Statement): string | null {
  let why: string | null = null;
  const visit = (n: ts.Node): void => {
    if (why !== null) return;
    if (ts.isFunctionDeclaration(n)) why = `function ${n.name?.text ?? ''}`;
    else if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0) why = 'a `var` declaration';
    else if (!ts.isFunctionLike(n) && !ts.isClassLike(n)) ts.forEachChild(n, visit);
  };
  visit(st);
  return why;
}

/** API-relative target of a relative specifier from `from` (`./x.js` -> x.ts). */
function relTarget(from: string, spec: string): string {
  return posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.([cm]?)js$/, '.$1ts');
}

/**
 * Problems with new code in a file that has existing cases (not under allowBreaking): existing imports
 * and collection-time statements (top-level helpers, constants) stay as they were; new imports bind
 * new names and load no new test code; new collection-time statements are declarations of new names;
 * appended statements hoist nothing; and no new code changes state existing cases share.
 */
function sharedStateChanges(
  fileName: string, old: ParsedFile, now: ParsedFile, matched: ReadonlyMap<TestBlock, TestBlock>, leftover: ReadonlyMap<string, TestBlock[]>,
): string[] {
  const problems: string[] = [];
  const at = (line: number, msg: string): void => {
    problems.push(`${fileName}:${line}  ${msg}`);
  };
  const NEW_FILE = 'put the new cases (and what they need) in a new test file';

  // Imports: every old binding stays; new ones bind new names from packages or source, never new test code.
  for (const o of old.imports) {
    const kept = now.imports.filter((i) => i.spec === o.spec);
    const names = new Set(kept.flatMap((i) => i.names));
    const lost = o.names.filter((x) => !names.has(x));
    if (kept.length === 0 || lost.length > 0) at(o.line, `existing import of "${o.spec}"${lost.length > 0 ? ` (${lost.join(', ')})` : ''} would be removed; existing cases depend on it`);
  }
  const newNames = new Set<string>();
  for (const i of now.imports) {
    const before = new Set(old.imports.filter((o) => o.spec === i.spec).flatMap((o) => o.names));
    const loadsNew = !old.imports.some((o) => o.spec === i.spec);
    if (loadsNew && i.sideEffect) {
      at(i.line, `new side-effect import "${i.spec}" runs code before existing cases; ${NEW_FILE}`);
      continue;
    }
    if (loadsNew && (i.spec.startsWith('./') || i.spec.startsWith('../'))) {
      const target = relTarget(fileName, i.spec);
      if (isTestFile(target) || isTestSupport(target)) {
        at(i.line, `new import of test code "${i.spec}" could change what existing cases run against (mocks, matchers); ${NEW_FILE}`);
        continue;
      }
    }
    for (const x of i.names) {
      if (before.has(x)) continue;
      if (old.identifiers.has(x)) at(i.line, `new import binding \`${x}\` would shadow a name existing code uses`);
      else newNames.add(x);
    }
  }

  // Collection-time statements: old ones stay verbatim; new ones are declarations of new names.
  const isNewSuite = (scope: string): boolean => {
    const parts = scope === '' ? [] : scope.split(' > ');
    for (let k = 1; k <= parts.length; k++) {
      const key = parts.slice(0, k).join(' > ');
      if ((leftover.get(`suite\0${key}`) ?? []).length > 0 && !old.blocks.some((b) => b.kind === 'suite' && b.key === key)) return true;
    }
    return false;
  };
  const known = new Map<string, number>();
  for (const c of now.collection) known.set(`${c.scope}\0${c.text}`, (known.get(`${c.scope}\0${c.text}`) ?? 0) + 1);
  for (const c of old.collection) {
    const k = `${c.scope}\0${c.text}`;
    const left = known.get(k) ?? 0;
    if (left > 0) known.set(k, left - 1);
    else at(c.line, `existing ${c.scope === '' ? 'top-level' : `"${c.scope}"`} statement \`${snippet(c.display)}\` would be changed or removed; existing cases depend on it`);
  }
  const fresh: CollectionStatement[] = [];
  const remaining = new Map(known);
  for (const c of [...now.collection].reverse()) {
    const k = `${c.scope}\0${c.text}`;
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      fresh.push(c);
    }
  }
  for (const c of fresh.reverse()) {
    if (isNewSuite(c.scope)) continue; // checked with its new describe below
    const st = c.node;
    if (!ts.isVariableStatement(st) && !ts.isFunctionDeclaration(st) && !ts.isClassDeclaration(st)) {
      at(c.line, `new statement \`${snippet(c.display)}\` runs at collection time, before existing cases; put it inside a new test case`);
      continue;
    }
    const names = new Set<string>();
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bindingNames(d.name, names);
    else if (st.name !== undefined) names.add(st.name.text);
    const shadow = [...names].filter((x) => old.identifiers.has(x));
    if (shadow.length > 0) {
      at(c.line, `new declaration of \`${shadow.join(', ')}\` would shadow a name existing code uses`);
      continue;
    }
    for (const x of names) newNames.add(x);
  }
  for (const c of fresh) {
    const st = c.node;
    if (isNewSuite(c.scope) || !(ts.isVariableStatement(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st))) continue;
    const why = sharedEffect(st, newNames);
    if (why !== null) at(c.line, `new code uses ${why}, which could change what existing cases run against; ${NEW_FILE}`);
  }

  // Appended statements of existing cases: no hoisting, no shared effects.
  for (const [o, n] of matched) {
    if (o.kind !== 'case') continue;
    const cb = now.nodes.get(n)?.cb;
    if (cb === undefined || !ts.isBlock(cb.body)) continue;
    const locals = new Set([...newNames, ...declaredIn(cb)]);
    for (const st of cb.body.statements.slice(o.body.length)) {
      const line = n.bodyLines[cb.body.statements.indexOf(st)] ?? n.line;
      const h = hoisted(st);
      if (h !== null) at(line, `${label(o)}: an appended ${h} is hoisted above the original statements; declare it with const/let or move it into a new case`);
      const why = h === null ? sharedEffect(st, locals) : null;
      if (why !== null) at(line, `${label(o)}: appended code uses ${why}; ${NEW_FILE}`);
    }
  }

  // New cases, hooks and describes (outermost only: a new describe is checked as a whole).
  const outermost = [...leftover.values()].flat().filter((b) => !isNewSuite(b.suites.join(' > ')));
  for (const b of outermost) {
    const call = now.nodes.get(b)?.call;
    if (call === undefined) continue;
    const why = sharedEffect(call, newNames);
    if (why !== null) at(b.line, `new ${b.kind === 'case' ? `test "${b.key}"` : b.kind === 'suite' ? `describe "${b.key}"` : b.key.split(' > ').pop() ?? 'hook'} uses ${why}, which could change what existing cases run against; ${NEW_FILE}`);
  }
  return problems;
}

// ───────────────────────── run-start content ─────────────────────────

const BASE_KEY = 'test-preservation.base';

function baseCache(state: RunState): Map<string, string> {
  const v = state.scratch.get(BASE_KEY);
  if (v instanceof Map) {
    const out = new Map<string, string>();
    for (const [k, x] of v.entries()) if (typeof k === 'string' && typeof x === 'string') out.set(k, x);
    return out;
  }
  return new Map();
}

/**
 * The file's content at run start, verified against the run-start snapshot hash: the cached copy,
 * else the current file (still unchanged), else the base commit. null = cannot be established.
 */
export async function runStartContent(ctx: RunContext, rel: string, current: string | null): Promise<string | null> {
  const want = ctx.state.initialHashes.get(rel);
  if (want === undefined) return null;
  const cache = baseCache(ctx.state);
  const cached = cache.get(rel);
  if (cached !== undefined && sha256(cached) === want) return cached;
  let found: string | null = current !== null && sha256(current) === want ? current : null;
  if (found === null) {
    const repoPath = ctx.workspace.rootRel === '' ? rel : `${ctx.workspace.rootRel}/${rel}`;
    const r = await ctx.exec('git', ['-C', ctx.workspace.repoRoot, 'show', `${ctx.run.baseSha}:${repoPath}`], { cwd: ctx.workspace.repoRoot });
    if (r.code === 0 && sha256(r.stdout) === want) found = r.stdout;
  }
  if (found !== null) {
    cache.set(rel, found);
    ctx.state.scratch.set(BASE_KEY, cache);
  }
  return found;
}

export default defineHook({
  name: 'test-preservation',
  description: 'Pre-existing test cases are append-only (no removing, renaming, disabling, rewriting or mocking them out); pre-existing test helpers are read-only.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    for (const target of event.call.paths) {
      const v = await judge(event.call, target, ctx);
      if (v.decision === 'block') return v;
    }
    return { decision: 'pass' };
  },
});

/** The verdict for one declared path of a write call. */
async function judge(call: ToolCallInfo, target: string, ctx: RunContext): Promise<HookVerdict> {
  const r = toApiRel(ctx.workspace, target);
  if (!r.ok || !ctx.state.initialHashes.has(r.rel)) return { decision: 'pass' };
  const breaking = ctx.task.kind === 'brownfield' && ctx.task.allowBreaking;
  if (isTestSupport(r.rel) && !breaking) {
    return {
      decision: 'block',
      reason:
        `test-preservation: ${r.rel} is test support code that existed before this run; existing tests depend on it, so it is read-only. ` +
        'Put new helpers in a new file (or in the test file that needs them).',
    };
  }
  if (!isTestFile(r.rel)) return { decision: 'pass' };
  // Judged on the post-image the loop computed from the tool's preview(); none = fail closed.
  const img = postImage(call, target);
  if (!img.ok) return { decision: 'block', reason: `test-preservation: ${img.reason}` };
  const current = await ctx.workspace.read(r.rel);
  if (img.after === null) {
    if (current === null) return { decision: 'pass' }; // already gone: nothing to delete
    return { decision: 'block', reason: `test-preservation: ${r.rel} existed before this run; existing test files cannot be deleted.` };
  }
  const after = img.after;
  const before = await runStartContent(ctx, r.rel, current);
  if (before === null) {
    return {
      decision: 'block',
      reason:
        `test-preservation: ${r.rel} existed before this run, but its run-start content cannot be recovered ` +
        '(the file no longer matches the run-start snapshot and the base commit does not have it). ' +
        'Writes to it are refused; add new cases in a new test file instead.',
    };
  }
  const problems = weakenedCases(r.rel, before, after, { allowBodyChanges: breaking });
  if (problems.length === 0) return { decision: 'pass' };
  return {
    decision: 'block',
    reason: [
      `test-preservation: ${r.rel} existed before this run; its test cases are append-only:`,
      ...problems.slice(0, 20).map((p) => `  ${p}`),
      breaking
        ? 'This task sets allowBreaking, so bodies of existing cases may change, but no existing case may be removed, renamed or disabled.'
        : 'Keep every original statement of an existing case verbatim and in order: append new statements at the end of the case, or add a new test case (or a new describe block) — the simplest safe way is append_file with a new describe block, instead of rewriting the file with write_file. ' +
          'If existing behaviour must change, the task has to set allowBreaking.',
    ].join('\n'),
  };
}
