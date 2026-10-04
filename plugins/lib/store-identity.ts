/**
 * Object identity for the idempotency analysis (api-ast.ts keyFlow): which object an expression names, how
 * long that object lives relative to one request, and whether any code can replace, empty or leak it.
 *
 * Values are ABSTRACT OBJECTS, never names:
 *  - an allocation site (`new …`, `{ … }`, `[ … ]`) evaluated in a frame (one activation of the function it is
 *    in; a frame's key spells the call path, so two calls of one helper make two objects);
 *  - an opaque origin: a parameter nothing binds, a call that is not followed, `this` of an unknown receiver,
 *    a library value, an absent property. Opaque values are never proof of anything.
 * Every expression resolves to a set of them (with the objects whose properties were read on the way: the
 * access path). Resolution is flow-insensitive: a variable or property holds the union of everything ever
 * assigned to it (wherever that assignment runs), so a store replaced through ANY alias resolves to two
 * objects, and two objects are never "the" store.
 *
 * Where an object goes is followed FORWARD from its allocation (flowOf): through variables, properties of
 * objects (literal members, class fields, assignments), call arguments into program functions, returns into
 * call sites and `this` into methods. Every place it may reach that the analysis cannot see (an argument of a
 * library or unknown function, an array element, a spread copy, a throw, …) is an ESCAPE. When an object does
 * not escape, its references are all known, so every replacement of a property it holds and every `.clear()`
 * of it is in sight: that is what makes the flow-insensitive union sound.
 *
 * Time. The request function (and the functions that hand `req` to it) runs per request, as does any function
 * nested in it; a function that lexically encloses it (a middleware factory, a router factory) runs once, at
 * registration, as does module scope. Any other function runs whenever its call sites run (the latest of their
 * times); one passed around as a value, or never called from the API's code, runs at an unknown time.
 */
import ts from 'typescript';
import type { ApiModel, Env } from './api-ast.ts';
import { isProgramNode, propName, resolveFunction, resolveSymbol, returnedExpressions, walk } from './api-ast.ts';

export type Time = 'once' | 'request' | 'unknown';
const TIME_RANK: Readonly<Record<Time, number>> = { once: 0, request: 1, unknown: 2 };
function later(a: Time, b: Time): Time {
  return TIME_RANK[b] > TIME_RANK[a] ? b : a;
}

export interface Alloc {
  kind: 'alloc';
  /** Allocation node + the key of the frame it was evaluated in: equal keys are one object. */
  key: string;
  node: ts.Expression;
  /** When the allocation runs: 'once' (module / registration), 'request', or 'unknown'. */
  life: Time;
  /** Where it was evaluated (its members' initialisers are resolved there). */
  ctx: Ctx;
}
export interface Opaque {
  kind: 'opaque';
  key: string;
  why: string;
}
export type AbsObj = Alloc | Opaque;

/** One possible value of an expression: the object, and the objects whose properties led to it. */
export interface Val {
  obj: AbsObj;
  owners: readonly AbsObj[];
}

/** One function activation: its parameters and `this` when a call was followed, else unknown. */
interface Frame {
  /** The function (or, for class field initialisers, the class); undefined for module scope. */
  owner: ts.Node | undefined;
  key: string;
  time: Time;
  params?: ReadonlyMap<ts.Symbol, readonly Val[]>;
  self?: readonly Val[];
}

/** Where an expression is evaluated: the frames of its lexical chain (innermost first) and the api-ast bindings. */
export interface Ctx {
  readonly frames: readonly Frame[];
  readonly env: Env;
  readonly depth: number;
}

/** Why a store is (not) persistent; `store` is set when it is one object created once that nothing can replace, empty or leak. */
export interface StoreVerdict {
  store?: string;
  why?: string;
}

export interface StoreModel {
  /** Context of the request function's body. */
  readonly top: Ctx;
  /** `ctx` moved to `node` (frames of the functions between are added; shared enclosing frames are kept). */
  at(ctx: Ctx, node: ts.Node): Ctx;
  /** The frame of a followed call of `fn` (parameters bound to the abstract values of the arguments). */
  enter(ctx: Ctx, call: ts.CallExpression, fn: ts.FunctionLikeDeclaration): Ctx;
  resolve(expr: ts.Expression, ctx: Ctx): Val[];
  /**
   * Whether `vals` (the receiver of a keyed write or lookup) is a persistent store: exactly one object, created
   * once; every object on its access path created once; no code replaces any of them (all assignments, deletes,
   * Object.assign/defineProperty/Reflect writes of a path property through any alias are part of the value
   * sets), no `.clear()` or bulk delete of the store outside run-once code (`isKeyed(arg)`: a delete of the
   * request's own key is cleanup, not clearing), and none of them escapes.
   */
  judge(vals: readonly Val[], isKeyed: (arg: ts.Expression) => boolean): StoreVerdict;
}

/** How deep resolution follows calls (returned values, argument bindings). */
const MAX_RESOLVE_DEPTH = 4;
/** Map/Set methods that read or write single entries: a receiver use that is not a leak. */
const ENTRY_METHODS = new Set(['get', 'has', 'set', 'add', 'keys', 'values', 'entries', 'forEach']);
/** Methods that return their receiver. */
const SELF_RETURNING = new Set(['set', 'add']);
/** Library calls that only read their argument (no reference to it is kept, nothing is changed). */
const READ_ONLY_CALLS = new Set([
  'Object.keys', 'Object.isFrozen', 'Object.freeze', 'Object.getOwnPropertyNames', 'JSON.stringify', 'Array.isArray', 'Array.from',
  'String', 'Boolean', 'Number', 'console.log', 'console.error', 'console.warn', 'console.info', 'console.debug',
]);

let nextNodeId = 0;
const NODE_IDS = new WeakMap<ts.Node, number>();
function nodeId(n: ts.Node): number {
  let id = NODE_IDS.get(n);
  if (id === undefined) {
    id = ++nextNodeId;
    NODE_IDS.set(n, id);
  }
  return id;
}

let nextEnvId = 0;
const ENV_IDS = new WeakMap<Env, number>();
function envId(e: Env): number {
  let id = ENV_IDS.get(e);
  if (id === undefined) {
    id = ++nextEnvId;
    ENV_IDS.set(e, id);
  }
  return id;
}

function strip(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x) || ts.isAwaitExpression(x)) x = x.expression;
  return x;
}

/** A function body boundary: functions, methods, constructors, accessors. */
function isFrameFunction(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
}

function isStatic(n: ts.Node): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/** The frames' owners of `node`, innermost first: enclosing functions, and the class for an instance field initialiser. */
function ownersOf(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  let prev: ts.Node = node;
  for (let p = node.parent; p !== undefined; prev = p, p = p.parent) {
    if (isFrameFunction(p)) out.push(p);
    else if (ts.isPropertyDeclaration(p) && p.initializer === prev && !isStatic(p) && ts.isClassLike(p.parent)) out.push(p.parent);
  }
  return out;
}

/** What `this` means at `node`: the nearest non-arrow function, or the class of an instance field initialiser. */
function thisContainer(node: ts.Node): ts.Node | undefined {
  let prev: ts.Node = node;
  for (let p = node.parent; p !== undefined; prev = p, p = p.parent) {
    if (ts.isArrowFunction(p)) continue;
    if (isFrameFunction(p)) return p;
    if (ts.isPropertyDeclaration(p) && p.initializer === prev) return isStatic(p) ? undefined : p.parent;
    if (ts.isClassStaticBlockDeclaration(p)) return undefined;
  }
  return undefined;
}

function within(inner: ts.Node, outer: ts.Node): boolean {
  return inner.getSourceFile() === outer.getSourceFile() && inner.pos >= outer.pos && inner.end <= outer.end;
}

/** `{ a: x }`/`[x]` that is the target of a destructuring assignment (or a for-of/in initialiser). */
function isAssignmentPattern(lit: ts.Node): boolean {
  let cur = lit;
  for (;;) {
    const p = cur.parent;
    if (ts.isBinaryExpression(p) && p.left === cur && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur) return true;
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isSpreadElement(p) || ts.isParenthesizedExpression(p)) {
      cur = p.parent !== undefined && (ts.isObjectLiteralExpression(p.parent) || ts.isArrayLiteralExpression(p.parent)) ? p.parent : p;
      if (cur === p) return false;
      continue;
    }
    if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)) {
      cur = p;
      continue;
    }
    return false;
  }
}

const ASSIGN_VALUE_OPS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);

/** When `n` is written (assignment target, `++`, destructuring target): the assigned value, or null when it is not a plain value. */
function assignTarget(n: ts.Node): { value: ts.Expression | null } | undefined {
  let cur = n;
  while (ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent)) cur = cur.parent;
  const p = cur.parent;
  if (ts.isBinaryExpression(p) && p.left === cur) {
    const op = p.operatorToken.kind;
    if (ASSIGN_VALUE_OPS.has(op)) return { value: p.right };
    if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) return { value: null };
    return undefined;
  }
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return { value: null };
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur) return { value: null };
  const inPattern =
    ((ts.isPropertyAssignment(p) && p.initializer === cur) || (ts.isShorthandPropertyAssignment(p) && p.name === cur) || ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) ? isAssignmentPattern(p.parent)
    : ts.isArrayLiteralExpression(p) ? isAssignmentPattern(p)
    : false;
  return inPattern ? { value: null } : undefined;
}

/** A declaration's name (not a use of the symbol). */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (
    (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isParameter(p)
      || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
      || ts.isEnumDeclaration(p) || ts.isEnumMember(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isModuleDeclaration(p)
      || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isTypeParameterDeclaration(p))
    && p.name === id
  ) return true;
  if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id;
  return ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isExportSpecifier(p) || ts.isNamespaceExport(p)
    || ts.isBreakOrContinueStatement(p) || ts.isLabeledStatement(p);
}

function inTypePosition(id: ts.Node): boolean {
  for (let p = id.parent; p !== undefined; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isHeritageClause(p)) return true;
    if (ts.isStatement(p) || ts.isExpressionStatement(p) || isFrameFunction(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** Program-wide index of symbol uses (per ApiModel). */
interface Index {
  /** Reads of a symbol: identifiers, or property accesses whose member is the symbol (`ns.x`, `obj.method`). */
  refs: Map<ts.Symbol, ts.Node[]>;
  /** Writes of a variable: the assigned value (null: not a plain value). */
  varWrites: Map<ts.Symbol, Array<{ site: ts.Node; value: ts.Expression | null }>>;
  /** Program classes and the program classes that extend them directly. */
  subclasses: Map<ts.Node, ts.ClassLikeDeclaration[]>;
  /** Code that can reach any binding by name at runtime (`eval(…)`, `new Function(…)`): nothing local is provable. */
  dynamicCode?: ts.Node;
}

const INDEXES = new WeakMap<ApiModel, Index>();

function indexOf(m: ApiModel): Index {
  const hit = INDEXES.get(m);
  if (hit !== undefined) return hit;
  const { checker } = m;
  const idx: Index = { refs: new Map(), varWrites: new Map(), subclasses: new Map() };
  const add = <K, V>(map: Map<K, V[]>, k: K, v: V): void => {
    const list = map.get(k);
    if (list === undefined) map.set(k, [v]);
    else list.push(v);
  };
  for (const { sf } of m.sources) {
    walk(sf, (n) => {
      if (ts.isClassLike(n)) {
        const base = baseClassOf(checker, n);
        if (base !== undefined) add(idx.subclasses, base, n);
      }
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && idx.dynamicCode === undefined) {
        const name = builtinOf(checker, n.expression);
        if (name === 'eval' || name === 'Function') idx.dynamicCode = n;
      }
      if (!ts.isIdentifier(n) || isDeclarationName(n) || inTypePosition(n)) return;
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.name === n) {
        const sym = resolveSymbol(checker, n);
        if (sym !== undefined) add(idx.refs, sym, p);
        return;
      }
      if (ts.isQualifiedName(p)) return;
      const sym = ts.isShorthandPropertyAssignment(p) && p.name === n ? aliased(checker, checker.getShorthandAssignmentValueSymbol(p)) : resolveSymbol(checker, n);
      if (sym === undefined) return;
      const target = assignTarget(n);
      if (target !== undefined) add(idx.varWrites, sym, { site: n, value: target.value });
      else add(idx.refs, sym, n);
    });
  }
  INDEXES.set(m, idx);
  return idx;
}

function aliased(checker: ts.TypeChecker, s: ts.Symbol | undefined): ts.Symbol | undefined {
  if (s === undefined) return undefined;
  return s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
}

/** The program class `cls` extends, if any. */
function baseClassOf(checker: ts.TypeChecker, cls: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined {
  const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (ext === undefined) return undefined;
  const sym = resolveSymbol(checker, ext.expression);
  const decl = sym?.declarations?.find((d) => ts.isClassLike(d));
  return decl !== undefined && ts.isClassLike(decl) && isProgramNode(decl) ? decl : undefined;
}

/** The program class a `new` expression instantiates. */
function classOfNew(checker: ts.TypeChecker, n: ts.NewExpression): ts.ClassLikeDeclaration | undefined {
  const e = strip(n.expression);
  if (ts.isClassExpression(e)) return e;
  const sym = resolveSymbol(checker, ts.isPropertyAccessExpression(e) ? e.name : e);
  const decl = sym?.declarations?.find((d) => ts.isClassLike(d));
  return decl !== undefined && ts.isClassLike(decl) && isProgramNode(decl) ? decl : undefined;
}

/** `this` keywords that mean the instance in `fn` (arrow functions inside count; nested functions and classes do not). */
function thisNodesIn(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.ThisKeyword) out.push(n);
    if ((isFrameFunction(n) && !ts.isArrowFunction(n)) || ts.isClassLike(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(root, visit);
  return out;
}

/** `this` nodes of every instance member of a class (methods, accessors, constructor, field initialisers). */
function classThisNodes(cls: ts.ClassLikeDeclaration): ts.Node[] {
  const out: ts.Node[] = [];
  for (const mem of cls.members) {
    if (isStatic(mem)) continue;
    if (isFrameFunction(mem)) out.push(...thisNodesIn(mem));
    else if (ts.isPropertyDeclaration(mem) && mem.initializer !== undefined) out.push(...thisNodesIn(mem));
  }
  return out;
}

/** `this` nodes of an object literal's methods (`{ reset() { this.store = … } }`). */
function literalThisNodes(lit: ts.ObjectLiteralExpression): ts.Node[] {
  const out: ts.Node[] = [];
  for (const p of lit.properties) {
    if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) out.push(...thisNodesIn(p));
    else if (ts.isPropertyAssignment(p) && ts.isFunctionExpression(strip(p.initializer))) out.push(...thisNodesIn(strip(p.initializer)));
  }
  return out;
}

/** A literal property key, or '*' for a computed one. */
function constKey(e: ts.Expression): string {
  const x = strip(e);
  if (ts.isStringLiteralLike(x) || ts.isNumericLiteral(x)) return x.text;
  return '*';
}

function memberName(n: ts.PropertyAccessExpression): string {
  return n.name.text;
}

/** A library function the analysis knows by name (`Object.assign`), when the callee is not shadowed by program code. */
function builtinOf(checker: ts.TypeChecker, callee: ts.Expression): string | undefined {
  const e = strip(callee);
  const head = ts.isPropertyAccessExpression(e) ? e.expression : e;
  if (!ts.isIdentifier(head)) return undefined;
  const sym = checker.getSymbolAtLocation(head);
  if (sym?.declarations?.some((d) => isProgramNode(d)) === true) return undefined;
  return ts.isPropertyAccessExpression(e) ? `${head.text}.${e.name.text}` : head.text;
}

/** Where an object goes (see the module comment). */
interface Flow {
  refs: Set<ts.Node>;
  /** Sites where it flows out of sight. */
  escapes: ts.Node[];
  /** Writes of its properties: `ref.prop = value` ('*': unknown property; value null: unknown; 'absent': deleted). */
  writes: Array<{ ref: ts.Node; prop: string; value: ts.Expression | null | 'absent'; site: ts.Node }>;
  /** Reads of its properties; `into` continues the read value (an expression, or a variable it is bound to). */
  reads: Array<{ prop: string; into: { node: ts.Node } | { sym: ts.Symbol } }>;
  /** `.clear()` calls on it. */
  clears: ts.Node[];
  /** Single-entry deletes (`.delete(k)`, `delete o[k]`, `o[k] = …` is a write, not a delete). */
  deletes: Array<{ site: ts.Node; arg: ts.Expression | undefined }>;
}

export function storeModel(m: ApiModel, fn: ts.FunctionLikeDeclaration, env: Env, callers: readonly ts.FunctionLikeDeclaration[]): StoreModel {
  const { checker } = m;
  const idx = indexOf(m);
  const requestFns: ts.Node[] = [...callers, fn];
  const MODULE: Frame = { owner: undefined, key: 'M', time: 'once' };

  // ───────────── time ─────────────
  const insideRequest = (n: ts.Node): boolean => requestFns.some((r) => n === r || within(n, r));
  const enclosesRequest = (n: ts.Node): boolean => !insideRequest(n) && requestFns.some((r) => within(r, n));
  const functionTimes = new Map<ts.Node, Time | null>();
  /** The symbol a function is called through (undefined: an inline function expression). */
  const functionSymbol = (f: ts.Node): ts.Symbol | undefined => {
    if (ts.isFunctionDeclaration(f) || ts.isMethodDeclaration(f) || ts.isGetAccessorDeclaration(f) || ts.isSetAccessorDeclaration(f)) return f.name !== undefined ? checker.getSymbolAtLocation(f.name) : undefined;
    let cur: ts.Node = f;
    while (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isSatisfiesExpression(cur.parent)) cur = cur.parent;
    const p = cur.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.initializer === cur && !ts.isComputedPropertyName(p.name) && !ts.isObjectBindingPattern(p.name) && !ts.isArrayBindingPattern(p.name)) {
      return checker.getSymbolAtLocation(p.name);
    }
    return undefined;
  };
  /** References through which `f` is reached (an inline function: itself); uses that only look at it (`void f`, `typeof f`) are not. */
  const functionRefs = (f: ts.Node): ts.Node[] => {
    const sym = functionSymbol(f);
    if (sym === undefined) return [f];
    return (idx.refs.get(sym) ?? []).filter((r) => !(ts.isVoidExpression(r.parent) || ts.isTypeOfExpression(r.parent) || ts.isExpressionStatement(r.parent) || ts.isExportSpecifier(r.parent)));
  };
  const calleeOf = (ref: ts.Node): ts.CallExpression | ts.NewExpression | undefined => {
    let cur = ref;
    while (ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent)) cur = cur.parent;
    const p = cur.parent;
    return (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === cur ? p : undefined;
  };
  const newSites = (cls: ts.ClassLikeDeclaration): ts.NewExpression[] | undefined => {
    const out: ts.NewExpression[] = [];
    const all: ts.ClassLikeDeclaration[] = [cls];
    for (let i = 0; i < all.length; i++) for (const s of idx.subclasses.get(all[i] ?? cls) ?? []) if (!all.includes(s)) all.push(s);
    for (const c of all) {
      const sym = c.name !== undefined ? checker.getSymbolAtLocation(c.name) : undefined;
      for (const r of sym !== undefined ? (idx.refs.get(sym) ?? []) : []) {
        const call = calleeOf(r);
        if (call !== undefined && ts.isNewExpression(call)) out.push(call);
        else if (!(ts.isBinaryExpression(r.parent) && r.parent.right === r && r.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) return undefined; // the class used as a value
      }
    }
    return out;
  };
  const timeOfFunction = (f: ts.Node): Time => {
    const hit = functionTimes.get(f);
    if (hit !== undefined) return hit ?? 'unknown';
    functionTimes.set(f, null);
    let t: Time | undefined;
    if (ts.isConstructorDeclaration(f) || ts.isClassLike(f)) {
      const cls = ts.isClassLike(f) ? f : f.parent;
      const sites = ts.isClassLike(cls) ? newSites(cls) : undefined;
      if (sites === undefined || sites.length === 0) t = 'unknown';
      else for (const s of sites) t = later(t ?? 'once', timeOfSite(s));
    } else {
      const refs = functionRefs(f);
      for (const r of refs) {
        const call = calleeOf(r);
        const getter = ts.isGetAccessorDeclaration(f) && ts.isPropertyAccessExpression(r);
        t = later(t ?? 'once', call !== undefined ? timeOfSite(call) : getter ? timeOfSite(r) : 'unknown');
      }
      if (refs.length === 0) t = 'unknown';
    }
    const out = t ?? 'unknown';
    functionTimes.set(f, out);
    return out;
  };
  /**
   * When a function that encloses the request function runs: when its callers run (the route registration
   * chain: a middleware factory called by a router factory called by the app factory, …), up to one the API
   * never calls itself (an entry point: the app's starter calls it, once). A caller that runs per request (a
   * router built inside a handler) or a reference that hands the function around makes it per request / unknown.
   */
  const registrationTimes = new Map<ts.Node, Time | null>();
  const registrationTime = (f: ts.Node): Time => {
    const hit = registrationTimes.get(f);
    if (hit !== undefined) return hit ?? 'unknown';
    registrationTimes.set(f, null);
    let t: Time = 'once';
    for (const r of functionRefs(f)) {
      const call = calleeOf(r);
      if (call === undefined) {
        t = 'unknown';
        break;
      }
      const [owner] = ownersOf(call);
      t = later(t, owner === undefined ? 'once' : insideRequest(owner) ? 'request' : registrationTime(owner));
    }
    registrationTimes.set(f, t);
    return t;
  };
  const frameTime = (owner: ts.Node): Time => {
    if (insideRequest(owner)) return 'request';
    if (enclosesRequest(owner)) return registrationTime(owner);
    return timeOfFunction(owner);
  };
  /** When code at `node` runs. */
  const timeOfSite = (node: ts.Node): Time => {
    const [owner] = ownersOf(node);
    return owner === undefined ? 'once' : frameTime(owner);
  };

  // ───────────── contexts ─────────────
  const defaultFrame = (owner: ts.Node): Frame => {
    const prefix = requestFns.includes(owner) ? 'R' : insideRequest(owner) ? 'N' : enclosesRequest(owner) ? 'F' : 'G';
    return { owner, key: `${prefix}${nodeId(owner)}`, time: frameTime(owner) };
  };
  const at = (ctx: Ctx, node: ts.Node): Ctx => {
    const chain = ownersOf(node);
    for (let i = 0; i < chain.length; i++) {
      const j = ctx.frames.findIndex((f) => f.owner === chain[i]);
      if (j >= 0) return { ...ctx, frames: [...chain.slice(0, i).map(defaultFrame), ...ctx.frames.slice(j)] };
    }
    return { ...ctx, frames: [...chain.map(defaultFrame), MODULE] };
  };
  const top = at({ frames: [], env, depth: 0 }, fn.body ?? fn);
  const sig = (ctx: Ctx): string => `${ctx.frames.map((f) => f.key).join('|')}#${envId(ctx.env)}`;

  // ───────────── values ─────────────
  let opaqueSeq = 0;
  const opaque = (why: string, at0?: ts.Node): Val => ({ obj: { kind: 'opaque', key: `?${at0 !== undefined ? nodeId(at0) : ++opaqueSeq}:${why}`, why }, owners: [] });
  const alloc = (node: ts.Expression, ctx: Ctx): Val => {
    const frame = ctx.frames[0] ?? MODULE;
    return { obj: { kind: 'alloc', key: `${nodeId(node)}@${frame.key}`, node, life: frame.time, ctx }, owners: [] };
  };
  const valKey = (v: Val): string => `${v.obj.key}<${v.owners.map((o) => o.key).join(',')}`;
  const dedupe = (vals: Val[]): Val[] => {
    const seen = new Set<string>();
    return vals.filter((v) => {
      const k = valKey(v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  /**
   * Cycle-safe memoisation shared by resolve and propValues: a computation that reaches an entry still in
   * progress gets [] for it (a union adds nothing new around a cycle), and only results whose cycles closed
   * at themselves are memoised; an entry inside an open cycle is recomputed later (it may be missing values
   * that reach it through the cycle's head).
   */
  const memo = new Map<string, Val[]>();
  const stack: string[] = [];
  let low = Number.POSITIVE_INFINITY;
  const memoised = (k: string, compute: () => Val[]): Val[] => {
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    const at0 = stack.indexOf(k);
    if (at0 >= 0) {
      low = Math.min(low, at0);
      return [];
    }
    const depth = stack.length;
    const outer = low;
    low = Number.POSITIVE_INFINITY;
    stack.push(k);
    const out = dedupe(compute());
    stack.pop();
    const mine = low;
    low = mine >= depth ? outer : Math.min(outer, mine);
    if (mine >= depth) memo.set(k, out);
    return out;
  };
  const resolve = (e0: ts.Expression, ctx0: Ctx): Val[] => {
    const e = strip(e0);
    const ctx = at(ctx0, e);
    return memoised(`v${nodeId(e)}/${sig(ctx)}`, () => resolveRaw(e, ctx));
  };

  const resolveRaw = (e: ts.Expression, ctx: Ctx): Val[] => {
    if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) || ts.isNewExpression(e)) return [alloc(e, ctx)];
    if (ts.isIdentifier(e)) {
      if (e.text === 'undefined') return [opaque('undefined', e)];
      const sym = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? aliased(checker, checker.getShorthandAssignmentValueSymbol(e.parent)) : resolveSymbol(checker, e);
      return sym === undefined ? [opaque('unresolved name', e)] : resolveSymbolValue(sym, ctx, e);
    }
    if (e.kind === ts.SyntaxKind.ThisKeyword) {
      const container = thisContainer(e);
      const frame = container !== undefined ? ctx.frames.find((f) => f.owner === container) : undefined;
      return frame?.self !== undefined ? [...frame.self] : [opaque('this of an unknown receiver', e)];
    }
    if (ts.isPropertyAccessExpression(e)) return propRead(resolve(e.expression, ctx), memberName(e), e);
    if (ts.isElementAccessExpression(e)) {
      const key = constKey(e.argumentExpression);
      return key === '*' ? [opaque('computed member', e)] : propRead(resolve(e.expression, ctx), key, e);
    }
    if (ts.isConditionalExpression(e)) return [...resolve(e.whenTrue, ctx), ...resolve(e.whenFalse, ctx)];
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) return [...resolve(e.left, ctx), ...resolve(e.right, ctx)];
      if (op === ts.SyntaxKind.CommaToken || ASSIGN_VALUE_OPS.has(op)) return resolve(e.right, ctx);
      return [opaque('operator result', e)];
    }
    if (ts.isCallExpression(e)) {
      const callee = resolveFunction(checker, e.expression);
      if (callee?.body !== undefined && isProgramNode(callee) && ctx.depth < MAX_RESOLVE_DEPTH && !ctx.frames.some((f) => f.owner === callee && f.params !== undefined)) {
        const inner = enter(ctx, e, callee);
        return returnedExpressions(callee).flatMap((r) => resolve(r, inner));
      }
      return [opaque('result of a call that is not followed', e)];
    }
    return [opaque('value', e)];
  };

  /** Property `name` of each value (its access path grows by the object read). */
  const propRead = (vals: readonly Val[], name: string, site: ts.Node): Val[] => {
    const out: Val[] = [];
    for (const v of vals) {
      if (v.obj.kind === 'opaque') {
        out.push({ obj: { kind: 'opaque', key: `${v.obj.key}.${name}`, why: `a member of ${v.obj.why}` }, owners: [...v.owners, v.obj] });
        continue;
      }
      for (const w of propValues(v.obj, name)) out.push({ obj: w.obj, owners: [...v.owners, v.obj, ...w.owners] });
    }
    if (vals.length === 0) out.push(opaque('a member of nothing known', site));
    return out;
  };

  const resolveSymbolValue = (sym: ts.Symbol, ctx: Ctx, use: ts.Node): Val[] => {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (decl === undefined || !isProgramNode(decl)) return [opaque('a library value', use)];
    // Destructured names: the root declaration plus the property path to the name.
    const path: string[] = [];
    let root: ts.Node = decl;
    while (ts.isBindingElement(root)) {
      const el: ts.BindingElement = root;
      const pattern = el.parent;
      if (!ts.isObjectBindingPattern(pattern) || el.dotDotDotToken !== undefined) return [opaque('array or rest destructuring', use)];
      const key = el.propertyName !== undefined ? propName(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : undefined;
      if (key === undefined) return [opaque('computed destructuring', use)];
      path.unshift(key);
      root = pattern.parent;
    }
    const readPath = (vals: Val[]): Val[] => path.reduce<Val[]>((acc, p) => propRead(acc, p, use), vals);
    if (ts.isParameter(root)) {
      // A followed call bound it (enter); else the api-ast bindings (a factory's or a caller's argument);
      // else every call site's argument (the parameter default where one omits it).
      const param = root;
      const owner = param.parent;
      const bound = ctx.frames.find((f) => f.owner === owner)?.params?.get(sym);
      if (bound !== undefined) return [...bound];
      const viaEnv = ctx.env.params.get(sym);
      if (viaEnv === undefined) {
        if (!isFrameFunction(owner) || param.dotDotDotToken !== undefined || ctx.depth >= MAX_RESOLVE_DEPTH) return [opaque('a parameter whose argument is not followed', use)];
        const index = owner.parameters.indexOf(param);
        const refs = functionRefs(owner);
        if (refs.length === 0) return [opaque('a parameter of a function the API never calls', use)];
        const deeper: Ctx = { ...ctx, depth: ctx.depth + 1 };
        const vals = refs.flatMap((r): Val[] => {
          const call = calleeOf(r);
          if (call === undefined || !ts.isCallExpression(call)) return [opaque('a parameter of a function passed around as a value', r)];
          if (call.arguments.some((a, j) => j <= index && ts.isSpreadElement(a))) return [opaque('a spread argument', call)];
          const arg = call.arguments[index];
          if (arg !== undefined) return resolve(arg, at(deeper, call));
          return param.initializer !== undefined ? resolve(param.initializer, deeper) : [opaque('an absent argument', call)];
        });
        return readPath(vals);
      }
      if (viaEnv.expr === undefined || ctx.depth >= MAX_RESOLVE_DEPTH) return [opaque('an absent argument', use)];
      const vals = resolve(viaEnv.expr, at({ frames: [], env: viaEnv.env, depth: ctx.depth + 1 }, viaEnv.expr));
      return (viaEnv.path ?? []).reduce<Val[]>((acc, p) => propRead(acc, p, use), vals);
    }
    if (!ts.isVariableDeclaration(root)) return [opaque('not a variable', use)];
    const declList = root.parent;
    const loop = ts.isVariableDeclarationList(declList) && (ts.isForOfStatement(declList.parent) || ts.isForInStatement(declList.parent));
    const out: Val[] = [];
    if (loop) out.push(opaque('a loop variable', use));
    else if (root.initializer !== undefined) out.push(...readPath(resolve(root.initializer, ctx)));
    else out.push(opaque('declared without a value', root));
    for (const w of idx.varWrites.get(sym) ?? []) out.push(...(w.value !== null ? resolve(w.value, ctx) : [opaque('a non-plain assignment', w.site)]));
    return out;
  };

  const enter = (ctx0: Ctx, call: ts.CallExpression, callee: ts.FunctionLikeDeclaration): Ctx => {
    const ctx = at(ctx0, call);
    const caller = ctx.frames[0] ?? MODULE;
    const params = new Map<ts.Symbol, readonly Val[]>();
    let spread = false;
    callee.parameters.forEach((p, i) => {
      const arg = call.arguments[i];
      if (arg !== undefined && ts.isSpreadElement(arg)) spread = true;
      if (spread || p.dotDotDotToken !== undefined) return;
      const vals = arg !== undefined ? resolve(arg, ctx) : [opaque('an absent argument', call)];
      if (ts.isIdentifier(p.name)) {
        const sym = checker.getSymbolAtLocation(p.name);
        if (sym !== undefined) params.set(sym, vals);
      } else if (ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          if (el.dotDotDotToken !== undefined || !ts.isIdentifier(el.name)) continue;
          const key = el.propertyName !== undefined ? propName(el.propertyName) : el.name.text;
          const sym = checker.getSymbolAtLocation(el.name);
          if (key !== undefined && sym !== undefined) params.set(sym, propRead(vals, key, el));
        }
      }
    });
    const target = strip(call.expression);
    const self = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? resolve(target.expression, ctx) : undefined;
    const frame: Frame = { owner: callee, key: `${caller.key}>${nodeId(call)}`, time: caller.time, params, ...(self !== undefined ? { self } : {}) };
    return { frames: [frame, ...at(ctx, callee).frames], env: ctx.env, depth: ctx.depth + 1 };
  };

  // ───────────── members ─────────────
  const propValues = (o: Alloc, name: string): Val[] => memoised(`p${o.key}.${name}`, () => {
    const out = [...initialValues(o, name)];
    const cls = ts.isNewExpression(o.node) ? classOfNew(checker, o.node) : undefined;
    const hierarchy = cls !== undefined ? classChain(cls) : [];
    for (const w of flowOf(o.node).writes) {
      if (w.prop !== name && w.prop !== '*') continue;
      // `this.x = …` directly in the constructor (or a field initialiser) of the object's own class is its initialisation (initialValues).
      if (w.ref.kind === ts.SyntaxKind.ThisKeyword && ts.isBinaryExpression(w.site.parent) && w.site.parent.left === w.site) {
        const [owner] = ownersOf(w.site);
        if (owner !== undefined && hierarchy.some((c) => owner === c || (ts.isConstructorDeclaration(owner) && owner.parent === c))) continue;
      }
      if (w.value === 'absent') out.push(opaque('a deleted property', w.site));
      else if (w.value === null) out.push(opaque('a write of an unknown value', w.site));
      else out.push(...resolve(w.value, top));
    }
    return out;
  });
  const classChain = (cls: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration[] => {
    const out: ts.ClassLikeDeclaration[] = [];
    for (let c: ts.ClassLikeDeclaration | undefined = cls; c !== undefined && !out.includes(c); c = baseClassOf(checker, c)) out.push(c);
    return out;
  };
  const initialValues = (o: Alloc, name: string): Val[] => {
    const node = o.node;
    if (ts.isObjectLiteralExpression(node)) {
      let member: ts.ObjectLiteralElementLike | 'spread' | undefined;
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p)) member = 'spread';
        else if (p.name !== undefined && (ts.isComputedPropertyName(p.name) || propName(p.name) === name)) member = ts.isComputedPropertyName(p.name) ? 'spread' : p;
      }
      if (member === undefined) return [opaque('an absent property', node)];
      if (member === 'spread') return [opaque('a spread or computed member', node)];
      if (ts.isPropertyAssignment(member)) return resolve(member.initializer, o.ctx);
      if (ts.isShorthandPropertyAssignment(member)) return resolve(member.name, o.ctx);
      return [opaque('a method or accessor', member)];
    }
    if (!ts.isNewExpression(node)) return [opaque('a member of a non-object', node)];
    const cls = classOfNew(checker, node);
    if (cls === undefined) return [opaque('a member of a library object', node)];
    const out: Val[] = [];
    const self: Val[] = [{ obj: o, owners: [] }];
    for (const c of classChain(cls)) {
      const ctor = c.members.find((x): x is ts.ConstructorDeclaration => ts.isConstructorDeclaration(x) && x.body !== undefined);
      const params = new Map<ts.Symbol, readonly Val[]>();
      if (c === cls && ctor !== undefined) {
        let spread = false;
        ctor.parameters.forEach((p, i) => {
          const arg = node.arguments?.[i];
          if (arg !== undefined && ts.isSpreadElement(arg)) spread = true;
          const sym = ts.isIdentifier(p.name) ? checker.getSymbolAtLocation(p.name) : undefined;
          if (sym !== undefined && !spread && p.dotDotDotToken === undefined) params.set(sym, arg !== undefined ? resolve(arg, o.ctx) : [opaque('an absent argument', node)]);
        });
      }
      const key = `${o.key}#init${nodeId(c)}`;
      const lexical = at(o.ctx, c).frames;
      const classFrame: Frame = { owner: c, key, time: o.life, params, self };
      const initCtx: Ctx = { frames: ctor !== undefined ? [{ ...classFrame, owner: ctor }, classFrame, ...lexical] : [classFrame, ...lexical], env: o.ctx.env, depth: o.ctx.depth + 1 };
      for (const mem of c.members) {
        if (isStatic(mem)) continue;
        if (ts.isPropertyDeclaration(mem) && mem.name !== undefined && propName(mem.name) === name && mem.initializer !== undefined) out.push(...resolve(mem.initializer, initCtx));
        if ((ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && propName(mem.name) === name) out.push(opaque('an accessor', mem));
      }
      if (ctor?.body === undefined) continue;
      ctor.parameters.forEach((p) => {
        const isProp = (ts.getModifiers(p) ?? []).some((mo) => mo.kind === ts.SyntaxKind.PublicKeyword || mo.kind === ts.SyntaxKind.PrivateKeyword || mo.kind === ts.SyntaxKind.ProtectedKeyword || mo.kind === ts.SyntaxKind.ReadonlyKeyword);
        if (isProp && ts.isIdentifier(p.name) && p.name.text === name) {
          const sym = checker.getSymbolAtLocation(p.name);
          const v = sym !== undefined ? params.get(sym) : undefined;
          out.push(...(v ?? [opaque('a constructor argument that is not followed', p)]));
        }
      });
      const visit = (n: ts.Node): void => {
        if (isFrameFunction(n) || ts.isClassLike(n)) return;
        if (ts.isBinaryExpression(n) && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) && strip(n.left.expression).kind === ts.SyntaxKind.ThisKeyword) {
          const prop = ts.isPropertyAccessExpression(n.left) ? memberName(n.left) : constKey(n.left.argumentExpression);
          if (prop === name || prop === '*') {
            if (ASSIGN_VALUE_OPS.has(n.operatorToken.kind)) out.push(...resolve(n.right, initCtx));
            else if (n.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment) out.push(opaque('a compound assignment', n));
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(ctor.body, visit);
    }
    return out.length > 0 ? out : [opaque('an absent property', node)];
  };

  // ───────────── forward flow ─────────────
  const flows = new Map<ts.Node, Flow>();
  const flowBusy = new Set<ts.Node>();
  const seedsOf = (key: ts.Node): ts.Node[] => {
    if (ts.isObjectLiteralExpression(key)) return [key, ...literalThisNodes(key)];
    if (ts.isClassLike(key)) {
      const out: ts.Node[] = [...(newSites(key) ?? [key]), ...classChain(key).flatMap(classThisNodes)];
      for (const sub of idx.subclasses.get(key) ?? []) out.push(...seedsOf(sub));
      return out;
    }
    if (ts.isNewExpression(key)) {
      const cls = classOfNew(checker, key);
      if (cls === undefined) return [key];
      const all: ts.ClassLikeDeclaration[] = [...classChain(cls)];
      for (let i = 0; i < all.length; i++) for (const s of idx.subclasses.get(all[i] ?? cls) ?? []) if (!all.includes(s)) all.push(s);
      return [key, ...all.flatMap(classThisNodes)];
    }
    return [key];
  };
  /** The flow of the object(s) `key` stands for: an allocation node, or a class (all of its instances). */
  const flowOf = (key: ts.Node): Flow => {
    const hit = flows.get(key);
    if (hit !== undefined) return hit;
    const flow: Flow = { refs: new Set(), escapes: [], writes: [], reads: [], clears: [], deletes: [] };
    if (flowBusy.has(key)) {
      flow.escapes.push(key); // a cycle through containers: not followed
      return flow;
    }
    flowBusy.add(key);
    const queue: ts.Node[] = [];
    const visit = (n: ts.Node): void => {
      if (flow.refs.has(n)) return;
      flow.refs.add(n);
      queue.push(n);
    };
    const visitVar = (sym: ts.Symbol): void => {
      for (const r of idx.refs.get(sym) ?? []) visit(r);
    };
    const into = (t: { node: ts.Node } | { sym: ts.Symbol }): void => {
      if ('node' in t) visit(t.node);
      else visitVar(t.sym);
    };
    const escape = (site: ts.Node): void => {
      flow.escapes.push(site);
    };
    /** The object is stored as property `prop` of the objects `container` stands for: follow reads of it there. */
    const storeIn = (container: ts.Node, prop: string, site: ts.Node): void => {
      const cf = flowOf(container);
      if (cf.escapes.length > 0) escape(site);
      for (const r of cf.reads) if (r.prop === prop || r.prop === '*' || prop === '*') into(r.into);
    };
    const storeInto = (target: ts.Expression, prop: string, site: ts.Node): void => {
      for (const v of resolve(target, top)) {
        if (v.obj.kind === 'alloc') storeIn(v.obj.node, prop, site);
        else escape(site);
      }
    };
    const destructure = (pattern: ts.ObjectBindingPattern): void => {
      for (const el of pattern.elements) {
        if (el.dotDotDotToken !== undefined || !ts.isIdentifier(el.name)) {
          escape(el);
          continue;
        }
        const key = el.propertyName !== undefined ? (propName(el.propertyName) ?? '*') : el.name.text;
        const sym = checker.getSymbolAtLocation(el.name);
        if (sym !== undefined) flow.reads.push({ prop: key, into: { sym } });
      }
    };
    /** The object passed as argument `i` of a program function (or constructor). */
    const intoParam = (callee: ts.FunctionLikeDeclaration | ts.ConstructorDeclaration, args: ts.NodeArray<ts.Expression> | undefined, i: number, site: ts.Node): void => {
      if ((args ?? []).some((a, j) => j <= i && ts.isSpreadElement(a))) {
        escape(site);
        return;
      }
      const p = callee.parameters[i];
      if (p === undefined) {
        let usesArguments = false;
        if (callee.body !== undefined) walk(callee.body, (n) => { usesArguments ||= ts.isIdentifier(n) && n.text === 'arguments'; });
        if (usesArguments) escape(site);
        return;
      }
      if (p.dotDotDotToken !== undefined) escape(site);
      else if (ts.isIdentifier(p.name)) {
        const sym = checker.getSymbolAtLocation(p.name);
        if (sym !== undefined) visitVar(sym);
      } else if (ts.isObjectBindingPattern(p.name)) destructure(p.name);
      else escape(site);
    };
    const write = (ref: ts.Node, prop: string, value: ts.Expression | null | 'absent', site: ts.Node): void => {
      flow.writes.push({ ref, prop, value, site });
    };
    const member = (ref: ts.Node, acc: ts.PropertyAccessExpression | ts.ElementAccessExpression, name: string): void => {
      const target = assignTarget(acc);
      if (target !== undefined) {
        write(ref, name, target.value, acc);
        return;
      }
      let up: ts.Node = acc;
      while (ts.isParenthesizedExpression(up.parent) || ts.isNonNullExpression(up.parent)) up = up.parent;
      const p = up.parent;
      if (ts.isDeleteExpression(p)) {
        write(ref, name, 'absent', p);
        flow.deletes.push({ site: p, arg: ts.isElementAccessExpression(acc) ? acc.argumentExpression : undefined });
        return;
      }
      if (ts.isCallExpression(p) && p.expression === up) {
        const method = ts.isPropertyAccessExpression(acc) ? resolveFunction(checker, acc) : undefined;
        if (method !== undefined && isProgramNode(method) && method.body !== undefined) {
          for (const t of thisNodesIn(method)) visit(t);
          return;
        }
        if (name === 'clear') flow.clears.push(p);
        else if (name === 'delete') flow.deletes.push({ site: p, arg: p.arguments[0] });
        else if (ENTRY_METHODS.has(name)) {
          if (SELF_RETURNING.has(name)) visit(p);
        } else escape(p);
        return;
      }
      flow.reads.push({ prop: name, into: { node: acc } });
    };
    const returned = (owner: ts.Node | undefined, site: ts.Node): void => {
      if (owner === undefined || ts.isConstructorDeclaration(owner)) {
        escape(site);
        return;
      }
      const refs = functionRefs(owner);
      if (refs.length === 0) escape(site);
      for (const r of refs) {
        const call = calleeOf(r);
        if (call !== undefined) visit(call);
        else if (ts.isGetAccessorDeclaration(owner) && ts.isPropertyAccessExpression(r)) visit(r);
        else escape(r);
      }
    };
    const callArg = (call: ts.CallExpression, i: number): void => {
      const builtin = builtinOf(checker, call.expression);
      const args = call.arguments;
      if (builtin === 'Object.assign') {
        if (i !== 0) {
          escape(call);
          return;
        }
        const target = args[0];
        if (target === undefined) return;
        for (const src of args.slice(1)) {
          const s = strip(src);
          if (!ts.isObjectLiteralExpression(s)) {
            write(target, '*', null, call);
            continue;
          }
          for (const p of s.properties) {
            if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) write(target, propName(p.name) ?? '*', p.initializer, call);
            else if (ts.isShorthandPropertyAssignment(p)) write(target, p.name.text, p.name, call);
            else write(target, '*', null, call);
          }
        }
        visit(call); // Object.assign returns its target
        return;
      }
      if (builtin === 'Object.defineProperty' || builtin === 'Reflect.defineProperty') {
        if (i !== 0) {
          if (i !== 1) escape(call);
          return;
        }
        const desc = args[2] !== undefined ? strip(args[2]) : undefined;
        const value = desc !== undefined && ts.isObjectLiteralExpression(desc) ? desc.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name) === 'value') : undefined;
        const onlyValue = desc !== undefined && ts.isObjectLiteralExpression(desc) && desc.properties.every((p) => ts.isPropertyAssignment(p) && ['value', 'writable', 'enumerable', 'configurable'].includes(propName(p.name) ?? ''));
        write(call, args[1] !== undefined ? constKey(args[1]) : '*', value !== undefined && onlyValue ? value.initializer : null, call);
        return;
      }
      if (builtin === 'Reflect.set') {
        if (i !== 0) {
          escape(call);
          return;
        }
        write(call, args[1] !== undefined ? constKey(args[1]) : '*', args[2] ?? null, call);
        return;
      }
      if (builtin === 'Reflect.deleteProperty') {
        if (i === 0) {
          write(call, args[1] !== undefined ? constKey(args[1]) : '*', 'absent', call);
          flow.deletes.push({ site: call, arg: args[1] });
        }
        return;
      }
      if (builtin === 'Object.defineProperties' || builtin === 'Object.setPrototypeOf') {
        if (i === 0) write(call, '*', null, call);
        else escape(call);
        return;
      }
      if (builtin !== undefined && READ_ONLY_CALLS.has(builtin)) return;
      const callee = resolveFunction(checker, call.expression);
      if (callee !== undefined && isProgramNode(callee) && callee.body !== undefined) intoParam(callee, args, i, call);
      else escape(call);
    };
    const step = (n: ts.Node): void => {
      const p = n.parent;
      if (p === undefined) {
        escape(n);
        return;
      }
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p) || ts.isAwaitExpression(p)) {
        visit(p);
        return;
      }
      if (ts.isConditionalExpression(p)) {
        if (p.condition !== n) visit(p);
        return;
      }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if (p.left === n) {
          if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) visit(p);
          return; // a comparison, `in`, `instanceof`, arithmetic, or the left of a comma
        }
        if (ASSIGN_VALUE_OPS.has(op)) {
          visit(p);
          const target = strip(p.left);
          if (ts.isIdentifier(target)) {
            const sym = resolveSymbol(checker, target);
            if (sym !== undefined) visitVar(sym);
          } else if (ts.isPropertyAccessExpression(target)) storeInto(target.expression, memberName(target), p);
          else if (ts.isElementAccessExpression(target)) storeInto(target.expression, constKey(target.argumentExpression), p);
          else escape(p);
          return;
        }
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) visit(p);
        return;
      }
      if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isVoidExpression(p) || ts.isDeleteExpression(p)) return;
      if (ts.isPropertyAccessExpression(p) && p.expression === n) {
        member(n, p, memberName(p));
        return;
      }
      if (ts.isElementAccessExpression(p)) {
        if (p.expression === n) member(n, p, constKey(p.argumentExpression));
        return; // used as a key: coerced to a string
      }
      if (ts.isCallExpression(p)) {
        const callArgs: readonly ts.Node[] = p.arguments;
        const i = callArgs.indexOf(n);
        if (i >= 0) callArg(p, i);
        else escape(p);
        return;
      }
      if (ts.isNewExpression(p)) {
        const newArgs: readonly ts.Node[] = p.arguments ?? [];
        const i = newArgs.indexOf(n);
        const cls = i >= 0 ? classOfNew(checker, p) : undefined;
        const ctor = cls?.members.find((x): x is ts.ConstructorDeclaration => ts.isConstructorDeclaration(x) && x.body !== undefined);
        if (cls === undefined) escape(p);
        else if (ctor === undefined) {
          if (baseClassOf(checker, cls) !== undefined || cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) === true) escape(p);
        } else {
          intoParam(ctor, p.arguments, i, p);
          const param = ctor.parameters[i];
          const isProp = param !== undefined && (ts.getModifiers(param) ?? []).some((mo) => mo.kind === ts.SyntaxKind.PublicKeyword || mo.kind === ts.SyntaxKind.PrivateKeyword || mo.kind === ts.SyntaxKind.ProtectedKeyword || mo.kind === ts.SyntaxKind.ReadonlyKeyword);
          if (isProp && ts.isIdentifier(param.name)) storeIn(p, param.name.text, p);
        }
        return;
      }
      if (ts.isParameter(p) && p.initializer === n) {
        // A parameter default: the parameter holds it.
        if (ts.isIdentifier(p.name)) {
          const sym = checker.getSymbolAtLocation(p.name);
          if (sym !== undefined) visitVar(sym);
        } else if (ts.isObjectBindingPattern(p.name)) destructure(p.name);
        else escape(p);
        return;
      }
      if (ts.isVariableDeclaration(p) && p.initializer === n) {
        if (ts.isIdentifier(p.name)) {
          const sym = checker.getSymbolAtLocation(p.name);
          if (sym !== undefined) visitVar(sym);
        } else if (ts.isObjectBindingPattern(p.name)) destructure(p.name);
        else escape(p);
        return;
      }
      if (ts.isPropertyAssignment(p) && p.initializer === n) {
        if (!isAssignmentPattern(p.parent)) storeIn(p.parent, ts.isComputedPropertyName(p.name) ? '*' : (propName(p.name) ?? '*'), p);
        return;
      }
      if (ts.isShorthandPropertyAssignment(p) && p.name === n) {
        if (!isAssignmentPattern(p.parent)) storeIn(p.parent, p.name.text, p);
        return;
      }
      if (ts.isPropertyDeclaration(p) && p.initializer === n) {
        if (isStatic(p) || !ts.isClassLike(p.parent)) escape(p);
        else storeIn(p.parent, ts.isComputedPropertyName(p.name) ? '*' : (propName(p.name) ?? '*'), p);
        return;
      }
      if (ts.isReturnStatement(p)) {
        returned(ownersOf(p)[0], p);
        return;
      }
      if (ts.isArrowFunction(p) && p.body === n) {
        returned(p, p);
        return;
      }
      if (ts.isSpreadElement(p)) {
        if (ts.isArrayLiteralExpression(p.parent) && !isAssignmentPattern(p.parent)) return; // `[...x]`: iterates it
        escape(p);
        return;
      }
      if (ts.isArrayLiteralExpression(p) && isAssignmentPattern(p)) return;
      if (ts.isTemplateSpan(p) || ts.isExpressionStatement(p) || ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)
        || ts.isSwitchStatement(p) || ts.isCaseClause(p) || ts.isExportSpecifier(p) || ts.isForInStatement(p)) return;
      if (ts.isForOfStatement(p) && p.expression === n) return;
      escape(p);
    };
    for (const s of seedsOf(key)) visit(s);
    while (queue.length > 0) {
      const n = queue.shift();
      if (n !== undefined) step(n);
    }
    flowBusy.delete(key);
    flows.set(key, flow);
    return flow;
  };

  // ───────────── verdict ─────────────
  /** Method names of a program class instance (its whole chain) or an object literal. */
  const methodNames = (node: ts.Node): Set<string> => {
    const out = new Set<string>();
    const members: readonly ts.Node[] = ts.isObjectLiteralExpression(node) ? node.properties
      : ts.isNewExpression(node) ? (() => {
        const cls = classOfNew(checker, node);
        return cls !== undefined ? classChain(cls).flatMap((c) => [...c.members]) : [];
      })()
      : [];
    for (const mem of members) {
      if ((ts.isMethodDeclaration(mem) || ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && !isStatic(mem)) {
        const n = propName(mem.name);
        if (n !== undefined) out.add(n);
      }
    }
    return out;
  };
  const describe = (n: ts.Node): string => {
    const sf = n.getSourceFile();
    const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    const file = sf.fileName.split(/[\\/]/).pop() ?? sf.fileName;
    return `${n.getText(sf).split('\n')[0]?.slice(0, 60) ?? ''} (${file}:${lc.line + 1})`;
  };
  const judge = (vals: readonly Val[], isKeyed: (arg: ts.Expression) => boolean): StoreVerdict => {
    const objs = new Map<string, AbsObj>();
    for (const v of vals) objs.set(v.obj.key, v.obj);
    if (objs.size !== 1) {
      const which = [...objs.values()].map((o) => (o.kind === 'alloc' ? describe(o.node) : o.why)).slice(0, 3).join('; ');
      return { why: objs.size === 0 ? 'nothing known' : `it may be any of ${objs.size} objects, so it is replaced or of unknown origin: ${which}` };
    }
    const [s] = [...objs.values()];
    if (s === undefined || s.kind === 'opaque') return { why: `its origin is unknown (${s?.why ?? 'nothing'})` };
    if (idx.dynamicCode !== undefined) return { why: `the API runs dynamic code (${describe(idx.dynamicCode)}) that can reach any binding` };
    const libraryBase = (o: Alloc): boolean => {
      const cls = ts.isNewExpression(o.node) ? classOfNew(checker, o.node) : undefined;
      return cls !== undefined && classChain(cls).some((c) => c.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) === true && baseClassOf(checker, c) === undefined);
    };
    if (libraryBase(s)) return { why: `its class extends a library class whose inherited methods are not followed (${describe(s.node)})` };
    if (s.life !== 'once') return { why: `it is created ${s.life === 'request' ? 'per request' : 'at an unknown time'} (${describe(s.node)})` };
    const owners = new Map<string, AbsObj>();
    for (const v of vals) for (const o of v.owners) owners.set(o.key, o);
    for (const o of owners.values()) {
      if (o.kind === 'opaque') return { why: `it is read through ${o.why}` };
      if (o.life !== 'once') return { why: `it is read through an object created ${o.life === 'request' ? 'per request' : 'at an unknown time'} (${describe(o.node)})` };
      if (libraryBase(o)) return { why: `it is read through an instance of a class extending a library class (${describe(o.node)})` };
      const esc = flowOf(o.node).escapes[0];
      if (esc !== undefined) return { why: `an object on its access path (${describe(o.node)}) escapes at ${describe(esc)}` };
    }
    // Its own or a path object's methods replaced after creation (`cache.find = …`, prototype-free patching).
    for (const o of [s, ...owners.values()]) {
      if (o.kind !== 'alloc') continue;
      const methods = methodNames(o.node);
      const patch = flowOf(o.node).writes.find((w) => (w.prop === '*' || methods.has(w.prop)) && timeOfSite(w.site) !== 'once');
      if (patch !== undefined && methods.size > 0) return { why: `a method of ${describe(o.node)} is replaced at ${describe(patch.site)}` };
    }
    const f = flowOf(s.node);
    const esc = f.escapes[0];
    if (esc !== undefined) return { why: `it escapes at ${describe(esc)}` };
    const clear = f.clears.find((c) => timeOfSite(c) !== 'once');
    if (clear !== undefined) return { why: `it is cleared at ${describe(clear)}` };
    const bulk = f.deletes.find((d) => timeOfSite(d.site) !== 'once' && (d.arg === undefined || !isKeyed(d.arg)));
    if (bulk !== undefined) return { why: `entries other than the request's own are deleted at ${describe(bulk.site)}` };
    return { store: s.key };
  };

  return { top, at, enter, resolve, judge };
}
