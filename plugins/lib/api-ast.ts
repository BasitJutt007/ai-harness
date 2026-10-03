/**
 * Shared Express route extraction for the standards checks and the contract lock.
 *
 * Routes are recognised by value and type, not by one template's syntax:
 * - a route is `<x>.<get|post|put|patch|delete>(path, ...handlers)` or `<x>.route(path).<method>(...handlers)`
 *   where `<x>` is an Express app/Router by type (conventional names only when types are unresolved);
 * - `path` is any expression with a constant string value: a literal, a const (across imports), a template
 *   or `+` of constants, an `as const` object member, or a literal type. A path that cannot be determined
 *   is reported as unresolved (`unresolvedPath`), never dropped;
 * - `x.use([path,] ...children)` mounts children under `path` ('' when path-less); prefixes compose;
 * - every handler argument (and arrays of them) forms the route's chain: middleware is analysed too, with
 *   factory arguments bound from the call site (`validate({ body: S })`);
 * - statuses come from literal types (enums, `as const` objects, library constants), unions as sets;
 * - error classes are problems when the error middleware turns them into problem responses (`instanceof`).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export const HTTP_METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export interface SchemaRef {
  expr: ts.Expression;
  text: string;
  module?: string;
  exportName?: string;
  parsedType?: ts.Type;
  /** Set when only this member of the schema's output is the request part (`S.parse({ body: req.body })`). */
  member?: string;
}
export interface ParseSite {
  target: 'params' | 'query' | 'body' | 'headers';
  call: ts.CallExpression;
  schema: SchemaRef;
}
export interface ResponseSite {
  call: ts.CallExpression;
  /** The status when it is a single known value (200 when no status is set), else null. */
  status: number | null;
  /** Every status the call can send (a union of literals is a set); null when unknown. */
  statuses: number[] | null;
  hasBody: boolean;
  schema?: SchemaRef;
  /** The body is a full problem document by type (type, title, status, detail, instance). */
  isProblem: boolean;
}
export interface RouteInfo {
  file: string;
  method: HttpMethod;
  path: string;
  line: number;
  column: number;
  registration: ts.CallExpression;
  handler: ts.FunctionLikeDeclaration | undefined;
  middleware: ts.Expression[];
  reqName: string | undefined;
  resName: string | undefined;
  /** Parses of the handler first, then of the middleware chain (in chain order). */
  parses: ParseSite[];
  /** Raw request reads in the handler and its middleware chain that no parse covers. */
  unparsedReads: Array<{ target: string; node: ts.Node }>;
  responses: ResponseSite[];
  statusLiterals: Array<{ status: number; node: ts.Node }>;
  problemSites: Array<{ name: string; status: number | null; node: ts.Node }>;
  /**
   * Addition (beyond the zod-boundary rule doc in plugins/checks/zod-boundary.ts): bare uses of `res` other than a method call on it —
   * passed to a helper (except a problem sender) or aliased — so the body it sends cannot be verified.
   */
  resEscapes: ts.Node[];
  /**
   * Addition: problem producers inside the program functions the handler calls (transitively,
   * up to 3 calls deep), e.g. a service method that throws notFound(...). Used for the 404 path.
   */
  calleeProblemSites: Array<{ name: string; status: number | null; node: ts.Node }>;
  /** Addition: middleware applied by `.use()` on the route's router (before it) or on a router/app it is mounted on. */
  scopeMiddleware: ts.Expression[];
  /** Addition: some function of the chain (or a callee it passes `req` to) reads the Idempotency-Key header. */
  readsIdempotencyKey: boolean;
  /** Set when the full path cannot be determined statically; `path` is then only a display label. */
  unresolvedPath?: { node: ts.Node; reason: string };
}

/** Problem helper names and the status they produce (fallback when the helper cannot be followed). */
export const PROBLEM_HELPERS: Readonly<Record<string, number>> = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  notAcceptable: 406,
  conflict: 409,
  gone: 410,
  preconditionFailed: 412,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  unprocessable: 422,
  unprocessableEntity: 422,
  preconditionRequired: 428,
  tooManyRequests: 429,
  internal: 500,
  internalError: 500,
  serviceUnavailable: 503,
};

const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const DATA_PARSE_METHODS = new Set(['parse', 'parseAsync']);
const REQ_TARGETS = new Set(['params', 'query', 'body', 'headers']);
/** Other raw request inputs: reading them unparsed is a boundary violation too. */
const REQ_RAW_INPUTS = new Set(['cookies', 'signedCookies', 'rawHeaders', 'headersDistinct', 'trailers', 'rawTrailers']);
const RESPONSE_METHODS = new Set(['json', 'send', 'end', 'sendStatus', 'jsonp']);
const RECEIVER_NAME = /^(app|api|server|router|\w*router)$/i;
/** Names matching /problem/i that do not produce a problem (they send or test one). */
const NON_PRODUCER = /^(send|is|has|write|handle|render|format|to|as|map|log)/i;
/** The members of an RFC 9457 problem document, as every error response must carry them. */
export const PROBLEM_MEMBERS = ['type', 'title', 'status', 'detail', 'instance'] as const;
export const IDEMPOTENCY_HEADER = 'idempotency-key';

const MAX_HANDLER_DEPTH = 3;
const MAX_EVAL_DEPTH = 16;

// ───────────────────────────── small helpers ─────────────────────────────

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function location(root: string, node: ts.Node): string {
  const sf = node.getSourceFile();
  const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const file = isAbsolute(sf.fileName) ? relative(root, sf.fileName) : sf.fileName;
  return `${toPosix(file)}:${lc.line + 1}:${lc.character + 1}`;
}

export function isZodSchemaType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  const apparent = checker.getApparentType(type);
  return apparent.getProperty('_zod') !== undefined || apparent.getProperty('_def') !== undefined;
}

/** Strip parentheses, type assertions, `satisfies`, non-null and `await`. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) || ts.isTypeAssertionExpression(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

export function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

/** Identifier name or property name of a call/new callee. */
export function calleeName(expr: ts.Expression): string | undefined {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

export function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const s = checker.getSymbolAtLocation(node);
  if (s === undefined) return undefined;
  return s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
}

function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0;
}

/** Initializer of the `const` an identifier refers to (undefined when not a const with initializer). */
export function constInitializer(checker: ts.TypeChecker, id: ts.Identifier): ts.Expression | undefined {
  return constInitializerOf(resolveSymbol(checker, id));
}

function constInitializerOf(sym: ts.Symbol | undefined): ts.Expression | undefined {
  const decl = sym?.valueDeclaration;
  if (decl !== undefined && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && isConstDeclaration(decl)) {
    return decl.initializer;
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

/** Resolve an expression to the function it denotes (inline, or an identifier/property bound to one). */
export function resolveFunction(checker: ts.TypeChecker, expr: ts.Expression): ts.FunctionLikeDeclaration | undefined {
  const e = unwrap(expr);
  if (isFunctionLike(e)) return e;
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
  const sym = resolveSymbol(checker, ts.isPropertyAccessExpression(e) ? e.name : e);
  for (const decl of sym?.declarations ?? []) {
    if (decl.getSourceFile().isDeclarationFile) continue;
    if (isFunctionLike(decl)) return decl;
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer !== undefined) {
      const init = unwrap(decl.initializer);
      if (isFunctionLike(init)) return init;
    }
  }
  return undefined;
}

/** Expressions a function returns: an arrow's expression body, or each `return x` not inside a nested function. */
export function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** Whether `expr` is an Express application or router. */
export function isExpressReceiver(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(expr);
  if (!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
    const t = checker.getApparentType(type);
    if (t.getProperty('use') !== undefined && t.getProperty('route') !== undefined) return true;
    if (!(type.flags & ts.TypeFlags.Any)) return false;
  }
  // Unresolved types: fall back to conventional names.
  const e = unwrap(expr);
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
  return name !== undefined && RECEIVER_NAME.test(name);
}

function paramName(fn: ts.FunctionLikeDeclaration, i: number): string | undefined {
  const p = fn.parameters[i];
  return p !== undefined && ts.isIdentifier(p.name) ? p.name.text : undefined;
}

function paramSymbol(checker: ts.TypeChecker, fn: ts.FunctionLikeDeclaration, i: number): ts.Symbol | undefined {
  const p = fn.parameters[i];
  return p !== undefined && ts.isIdentifier(p.name) ? checker.getSymbolAtLocation(p.name) : undefined;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

export function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function isProgramNode(node: ts.Node): boolean {
  return !node.getSourceFile().isDeclarationFile;
}

// ───────────────────────────── values ─────────────────────────────

/** An argument bound to a parameter at one call site; `expr: undefined` = statically absent. */
interface Bound {
  expr: ts.Expression | undefined;
  env: Env;
  /** Member path into the argument, for destructured parameters (`({ body }) => …`). */
  path?: string[];
}

/** Call-site bindings under which an expression is evaluated (a factory's arguments, a narrowed error). */
export interface Env {
  readonly params: ReadonlyMap<ts.Symbol, Bound>;
  /** Identifiers known to hold an instance of a class (an error narrowed by `instanceof`). */
  readonly instances: ReadonlyMap<ts.Symbol, Instance>;
  /** `this` while evaluating a class member. */
  readonly self?: Instance;
}

export const NO_ENV: Env = { params: new Map(), instances: new Map() };

/** `new Cls(...args)` evaluated in `argEnv`. */
export interface Instance {
  cls: ts.ClassLikeDeclaration;
  args: readonly ts.Expression[];
  argEnv: Env;
}

type Resolved = { expr: ts.Expression; env: Env } | 'absent';

/** Bind `fn`'s parameters to `args` (evaluated in `env`); missing arguments fall back to defaults or are absent. */
export function bindCall(checker: ts.TypeChecker, fn: ts.SignatureDeclaration, args: readonly ts.Expression[], env: Env): Env {
  const params = new Map<ts.Symbol, Bound>();
  const out: Env = { params, instances: env.instances };
  let spread = false;
  fn.parameters.forEach((p, i) => {
    if (p.dotDotDotToken !== undefined) return;
    const arg = spread ? undefined : args[i];
    if (arg !== undefined && ts.isSpreadElement(arg)) spread = true;
    if (spread) return; // positions after a spread argument are unknown
    const bound: Bound = arg !== undefined ? { expr: arg, env } : p.initializer !== undefined ? { expr: p.initializer, env: out } : { expr: undefined, env };
    if (ts.isIdentifier(p.name)) {
      const sym = checker.getSymbolAtLocation(p.name);
      if (sym !== undefined) params.set(sym, bound);
    } else if (ts.isObjectBindingPattern(p.name) && bound.expr !== undefined) {
      for (const el of p.name.elements) {
        if (el.dotDotDotToken !== undefined || !ts.isIdentifier(el.name)) continue;
        const key = el.propertyName !== undefined ? propName(el.propertyName) : el.name.text;
        const sym = checker.getSymbolAtLocation(el.name);
        if (key !== undefined && sym !== undefined) params.set(sym, { ...bound, path: [...(bound.path ?? []), key] });
      }
    }
  });
  return out;
}

function boundOf(checker: ts.TypeChecker, id: ts.Identifier, env: Env): Bound | undefined {
  if (env.params.size === 0) return undefined;
  const sym = checker.getSymbolAtLocation(id);
  return sym === undefined ? undefined : env.params.get(sym);
}

/** Property `name` of an object literal: the member, 'spread' when a spread may supply it, undefined when absent. */
function objectMember(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | 'spread' | undefined {
  let found: ts.ObjectLiteralElementLike | 'spread' | undefined;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      found = 'spread';
      continue;
    }
    if (p.name !== undefined && propName(p.name) === name) found = p;
  }
  return found;
}

/**
 * The expression that supplies `expr`'s value: follows parameter bindings, members of object literals and
 * (with `consts`) const initializers across imports. Returns 'absent' when the value is statically missing
 * (an omitted factory argument / object member).
 */
function resolveValue(checker: ts.TypeChecker, expr: ts.Expression, env: Env, consts: boolean, depth = 0): Resolved {
  const e = unwrap(expr);
  if (depth > MAX_EVAL_DEPTH) return { expr: e, env };
  if (ts.isIdentifier(e)) {
    const bound = boundOf(checker, e, env);
    if (bound !== undefined) return resolveBound(checker, bound, consts, depth + 1);
    if (consts) {
      const init = constInitializer(checker, e);
      if (init !== undefined) return resolveValue(checker, init, env, consts, depth + 1);
    }
    return { expr: e, env };
  }
  const key = memberKey(checker, e, env, depth);
  if (key !== undefined && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) {
    const obj = resolveValue(checker, e.expression, env, true, depth + 1);
    if (obj === 'absent') return 'absent';
    if (ts.isObjectLiteralExpression(obj.expr)) return memberValue(checker, obj.expr, key, obj.env, consts, depth + 1) ?? { expr: e, env };
  }
  return { expr: e, env };
}

function resolveBound(checker: ts.TypeChecker, bound: Bound, consts: boolean, depth: number): Resolved {
  if (bound.expr === undefined) return 'absent';
  let cur = resolveValue(checker, bound.expr, bound.env, bound.path !== undefined ? true : consts, depth);
  for (const key of bound.path ?? []) {
    if (cur === 'absent') return 'absent';
    if (!ts.isObjectLiteralExpression(cur.expr)) return { expr: bound.expr, env: bound.env };
    const next = memberValue(checker, cur.expr, key, cur.env, consts, depth + 1);
    if (next === undefined) return { expr: bound.expr, env: bound.env };
    cur = next;
  }
  return cur;
}

function memberValue(checker: ts.TypeChecker, obj: ts.ObjectLiteralExpression, key: string, env: Env, consts: boolean, depth: number): Resolved | undefined {
  const prop = objectMember(obj, key);
  if (prop === undefined) return 'absent';
  if (prop === 'spread') return undefined;
  if (ts.isPropertyAssignment(prop)) return resolveValue(checker, prop.initializer, env, consts, depth);
  if (ts.isShorthandPropertyAssignment(prop)) {
    const sym = checker.getShorthandAssignmentValueSymbol(prop);
    const bound = sym !== undefined ? env.params.get(sym) : undefined;
    if (bound !== undefined) return resolveBound(checker, bound, consts, depth);
    const target = sym !== undefined && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const init = consts ? constInitializerOf(target) : undefined;
    return init !== undefined ? resolveValue(checker, init, env, consts, depth) : { expr: prop.name, env };
  }
  return undefined;
}

/** The constant member name of `o.p` / `o['p']` / `o[KEY]`. */
function memberKey(checker: ts.TypeChecker, e: ts.Expression, env: Env, depth: number): string | undefined {
  if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.name) ? e.name.text : undefined;
  if (ts.isElementAccessExpression(e)) {
    const v = evalConst(checker, e.argumentExpression, env, depth + 1);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
  }
  return undefined;
}

export type ConstValue = string | number | boolean;

function literalOfType(type: ts.Type): string | number | undefined {
  if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
  return undefined;
}

/** Whether an expression is statically missing (an omitted argument/member, `undefined` or `null`). */
function isAbsent(checker: ts.TypeChecker, expr: ts.Expression, env: Env): boolean {
  const r = resolveValue(checker, expr, env, true);
  if (r === 'absent') return true;
  return r.expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(r.expr) && r.expr.text === 'undefined');
}

/**
 * The constant value of an expression, by value and type: literals, consts (across imports), parameter
 * bindings, templates and `+` of constants, `??`/`||`/conditionals with known operands, members of
 * (`as const`) object literals, enum members, members of known class instances, and literal types
 * (e.g. a library's `declare const NOT_FOUND = 404`). Undefined when not determinable.
 */
export function evalConst(checker: ts.TypeChecker, expr: ts.Expression, env: Env = NO_ENV, depth = 0): ConstValue | undefined {
  if (depth > MAX_EVAL_DEPTH) return undefined;
  const r = resolveValue(checker, expr, env, true, depth);
  if (r === 'absent') return undefined;
  const e = r.expr;
  const en = r.env;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    const v = evalConst(checker, e.operand, en, depth + 1);
    return typeof v === 'number' ? -v : undefined;
  }
  if (ts.isTemplateExpression(e)) {
    let s = e.head.text;
    for (const span of e.templateSpans) {
      const v = evalConst(checker, span.expression, en, depth + 1);
      if (v === undefined) return undefined;
      s += `${String(v)}${span.literal.text}`;
    }
    return s;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      const l = evalConst(checker, e.left, en, depth + 1);
      const rv = evalConst(checker, e.right, en, depth + 1);
      if (l === undefined || rv === undefined) return undefined;
      if (typeof l === 'number' && typeof rv === 'number') return l + rv;
      return typeof l === 'boolean' || typeof rv === 'boolean' ? undefined : `${String(l)}${String(rv)}`;
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      const l = evalConst(checker, e.left, en, depth + 1);
      if (l !== undefined && (op === ts.SyntaxKind.QuestionQuestionToken || l !== false && l !== 0 && l !== '')) return l;
      return l !== undefined || isAbsent(checker, e.left, en) ? evalConst(checker, e.right, en, depth + 1) : undefined;
    }
  }
  if (ts.isConditionalExpression(e)) {
    const c = evalConst(checker, e.condition, en, depth + 1);
    if (typeof c === 'boolean') return evalConst(checker, c ? e.whenTrue : e.whenFalse, en, depth + 1);
    const a = evalConst(checker, e.whenTrue, en, depth + 1);
    return a !== undefined && a === evalConst(checker, e.whenFalse, en, depth + 1) ? a : undefined;
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const enumValue = checker.getConstantValue(e);
    if (enumValue !== undefined) return enumValue;
    const key = memberKey(checker, e, en, depth);
    const inst = key !== undefined ? instanceOfExpr(checker, e.expression, en) : undefined;
    if (inst !== undefined && key !== undefined) {
      const v = evalMember(checker, inst, key, depth + 1);
      if (v !== undefined) return v;
    }
  }
  return literalOfType(checker.getTypeAtLocation(e));
}

/** A constant string value (route paths, mount prefixes, header names). */
export function constString(checker: ts.TypeChecker, expr: ts.Expression | undefined, env: Env = NO_ENV): string | undefined {
  if (expr === undefined) return undefined;
  const v = evalConst(checker, expr, env);
  return typeof v === 'string' ? v : undefined;
}

/** A constant number (status codes by value and type: literals, consts, enums, `as const` members). */
export function numericValue(checker: ts.TypeChecker, expr: ts.Expression | undefined, env: Env = NO_ENV): number | null {
  if (expr === undefined) return null;
  const v = evalConst(checker, expr, env);
  return typeof v === 'number' ? v : null;
}

/** Every status an expression can be (a literal, or a union of literals / both arms of a conditional); null when unknown. */
export function statusValues(checker: ts.TypeChecker, expr: ts.Expression | undefined, env: Env = NO_ENV, depth = 0): number[] | null {
  if (expr === undefined || depth > MAX_EVAL_DEPTH) return null;
  const single = numericValue(checker, expr, env);
  if (single !== null) return [single];
  const r = resolveValue(checker, expr, env, true);
  if (r === 'absent') return null;
  if (ts.isConditionalExpression(r.expr)) {
    const a = statusValues(checker, r.expr.whenTrue, r.env, depth + 1);
    const b = statusValues(checker, r.expr.whenFalse, r.env, depth + 1);
    return a !== null && b !== null ? [...new Set([...a, ...b])].sort((x, y) => x - y) : null;
  }
  const type = checker.getTypeAtLocation(r.expr);
  const parts = type.isUnion() ? type.types : [type];
  const values: number[] = [];
  for (const p of parts) {
    if (!p.isNumberLiteral()) return null;
    values.push(p.value);
  }
  return values.length > 0 ? [...new Set(values)].sort((x, y) => x - y) : null;
}

// ───────────────────────────── classes ─────────────────────────────

/** The class declaration an expression (a class name, possibly imported or aliased) denotes. */
export function classOf(checker: ts.TypeChecker, expr: ts.Expression): ts.ClassLikeDeclaration | undefined {
  const e = unwrap(expr);
  const sym = resolveSymbol(checker, ts.isPropertyAccessExpression(e) ? e.name : e);
  return classOfSymbol(sym);
}

function classOfSymbol(sym: ts.Symbol | undefined): ts.ClassLikeDeclaration | undefined {
  for (const decl of sym?.declarations ?? []) {
    if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined && ts.isClassExpression(unwrap(decl.initializer))) {
      const init = unwrap(decl.initializer);
      if (ts.isClassExpression(init)) return init;
    }
  }
  return undefined;
}

function constructorOf(cls: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | undefined {
  return cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined);
}

function baseClassExpr(cls: ts.ClassLikeDeclaration): ts.Expression | undefined {
  for (const h of cls.heritageClauses ?? []) {
    if (h.token === ts.SyntaxKind.ExtendsKeyword) return h.types[0]?.expression;
  }
  return undefined;
}

function superCall(ctor: ts.ConstructorDeclaration): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  if (ctor.body !== undefined) {
    walk(ctor.body, (n) => {
      if (found === undefined && ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) found = n;
    });
  }
  return found;
}

/** The instance an expression denotes: `new C(...)`, `this`, or an identifier narrowed to a known instance. */
function instanceOfExpr(checker: ts.TypeChecker, expr: ts.Expression, env: Env): Instance | undefined {
  const e = unwrap(expr);
  if (e.kind === ts.SyntaxKind.ThisKeyword) return env.self;
  if (ts.isIdentifier(e)) {
    const sym = checker.getSymbolAtLocation(e);
    const known = sym !== undefined ? env.instances.get(sym) : undefined;
    if (known !== undefined) return known;
  }
  const r = resolveValue(checker, e, env, true);
  if (r === 'absent' || !ts.isNewExpression(r.expr)) return undefined;
  const cls = classOf(checker, r.expr.expression);
  return cls !== undefined ? { cls, args: r.expr.arguments ?? [], argEnv: r.env } : undefined;
}

/**
 * The constant value of member `name` on a class instance: a `this.name = …` assignment in a
 * constructor, a field initializer, or a constructor parameter property — on the class or (through the
 * arguments of `super(...)`) on its base classes.
 */
export function evalMember(checker: ts.TypeChecker, inst: Instance, name: string, depth = 0): ConstValue | undefined {
  let cur: Instance | undefined = inst;
  for (let level = 0; cur !== undefined && level < 8 && depth <= MAX_EVAL_DEPTH; level++) {
    const ctor = constructorOf(cur.cls);
    const ctorEnv: Env = { ...(ctor !== undefined ? bindCall(checker, ctor, cur.args, cur.argEnv) : cur.argEnv), self: inst };
    if (ctor?.body !== undefined) {
      let assigned: ts.Expression | undefined;
      for (const st of ctor.body.statements) {
        if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression) || st.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        const left = st.expression.left;
        if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && left.name.text === name) assigned = st.expression.right;
      }
      if (assigned !== undefined) return evalConst(checker, assigned, ctorEnv, depth + 1);
    }
    for (const member of cur.cls.members) {
      if (ts.isPropertyDeclaration(member) && member.name !== undefined && propName(member.name) === name && member.initializer !== undefined
        && !(member.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
        return evalConst(checker, member.initializer, ctorEnv, depth + 1);
      }
    }
    const paramProp = ctor?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name && ts.getModifiers(p) !== undefined && (ts.getModifiers(p) ?? []).length > 0);
    if (paramProp !== undefined && ts.isIdentifier(paramProp.name)) return evalConst(checker, paramProp.name, ctorEnv, depth + 1);
    const baseExpr = baseClassExpr(cur.cls);
    const base = baseExpr !== undefined ? classOf(checker, baseExpr) : undefined;
    if (base === undefined) return undefined;
    const sup = ctor !== undefined ? superCall(ctor) : undefined;
    cur = ctor !== undefined ? { cls: base, args: sup?.arguments ?? [], argEnv: ctorEnv } : { cls: base, args: cur.args, argEnv: cur.argEnv };
  }
  return undefined;
}

/** The class symbols of `cls` and its base classes (program classes; a library base ends the chain). */
function classChain(checker: ts.TypeChecker, cls: ts.ClassLikeDeclaration): ts.Symbol[] {
  const out: ts.Symbol[] = [];
  let cur: ts.ClassLikeDeclaration | undefined = cls;
  for (let i = 0; cur !== undefined && i < 10; i++) {
    const sym = cur.name !== undefined ? checker.getSymbolAtLocation(cur.name) : undefined;
    if (sym !== undefined) out.push(sym);
    const baseExpr = baseClassExpr(cur);
    if (baseExpr === undefined) break;
    const baseSym = resolveSymbol(checker, ts.isPropertyAccessExpression(baseExpr) ? baseExpr.name : baseExpr);
    if (baseSym !== undefined && !out.includes(baseSym)) out.push(baseSym);
    cur = classOfSymbol(baseSym);
  }
  return out;
}

// ───────────────────────────── the program model ─────────────────────────────

/** A branch of an error middleware that handles one error class (`if (err instanceof C) { … }`). */
interface HandledBranch {
  node: ts.Node;
  err: ts.Symbol | undefined;
}

/** One `<express>.use(...)` call. */
interface UseCall {
  call: ts.CallExpression;
  owner: ts.Symbol | undefined;
  /** undefined: no path argument; null: a path argument that could not be resolved; else the prefixes. */
  paths: string[] | null | undefined;
  pathNode: ts.Expression | undefined;
  /** The middleware / child arguments (arrays flattened). */
  args: ts.Expression[];
}

export interface ApiModel {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
  sources: Array<{ rel: string; sf: ts.SourceFile }>;
  uses: UseCall[];
  /** Error classes (by symbol) that a registered error middleware tests with `instanceof`. */
  handled: Map<ts.Symbol, HandledBranch[]>;
  /** Whether an error-handling middleware is registered at all. */
  hasErrorMiddleware: boolean;
  /** Lazily computed: function symbols that some call in the sources invokes. */
  called?: Set<ts.Symbol>;
}

const MODELS = new WeakMap<ts.Program, Map<string, ApiModel>>();

/** The (cached) model of an API: its `.use` registrations and what its error middleware handles. */
export function apiModel(program: ts.Program, root: string, files: string[]): ApiModel {
  const key = `${root}\n${files.join('\n')}`;
  let perProgram = MODELS.get(program);
  if (perProgram === undefined) {
    perProgram = new Map();
    MODELS.set(program, perProgram);
  }
  const cached = perProgram.get(key);
  if (cached !== undefined) return cached;
  const checker = program.getTypeChecker();
  const sources: ApiModel['sources'] = [];
  for (const rel of files) {
    const sf = programFile(program, root, rel);
    if (sf !== undefined) sources.push({ rel: toPosix(rel), sf });
  }
  const m: ApiModel = { program, checker, root, sources, uses: [], handled: new Map(), hasErrorMiddleware: false };
  m.uses = collectUses(m);
  for (const u of useRegistrationsOf(m)) {
    if (u.params !== 4) continue;
    m.hasErrorMiddleware = true;
    // Only an error middleware that responds turns errors into problems (one that only forwards does not).
    if (u.fn !== undefined && responds(m, u.fn)) collectHandled(m, u.fn, paramSymbol(m.checker, u.fn, 3), 0, new Set());
  }
  perProgram.set(key, m);
  return m;
}

/** Whether an error middleware sends a response: a call on its `res` parameter, or `res` passed to a helper. */
function responds(m: ApiModel, fn: ts.FunctionLikeDeclaration): boolean {
  const resSym = paramSymbol(m.checker, fn, 2);
  let found = false;
  if (fn.body === undefined || resSym === undefined) return false;
  walk(fn.body, (n) => {
    if (!found && ts.isIdentifier(n) && m.checker.getSymbolAtLocation(n) === resSym) {
      const p = n.parent;
      found = (ts.isPropertyAccessExpression(p) && p.expression === n && ts.isCallExpression(p.parent)) || (ts.isCallExpression(p) && p.arguments.includes(n));
    }
  });
  return found;
}

/** A branch that only forwards the error (`return next(err)`): the class is not turned into a problem there. */
function onlyForwards(branch: ts.Node, nextSym: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  if (nextSym === undefined) return false;
  const statements = ts.isBlock(branch) ? [...branch.statements] : [branch];
  const isNextCall = (e: ts.Node | undefined): boolean =>
    e !== undefined && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && checker.getSymbolAtLocation(e.expression) === nextSym;
  return statements.length > 0 && statements.every((s) =>
    (ts.isExpressionStatement(s) && isNextCall(s.expression)) || (ts.isReturnStatement(s) && (s.expression === undefined || isNextCall(s.expression))) || isNextCall(s));
}

/** Record the classes an error middleware (or a function it calls) tests with `instanceof` and handles. */
function collectHandled(m: ApiModel, fn: ts.FunctionLikeDeclaration, nextSym: ts.Symbol | undefined, depth: number, seen: Set<ts.Node>): void {
  if (fn.body === undefined || seen.has(fn)) return;
  seen.add(fn);
  walk(fn.body, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const right = unwrap(n.right);
      const sym = resolveSymbol(m.checker, ts.isPropertyAccessExpression(right) ? right.name : right);
      const branch = branchOf(n);
      if (sym !== undefined && sym.flags & ts.SymbolFlags.Class && !onlyForwards(branch, nextSym, m.checker)) {
        const left = unwrap(n.left);
        const branches = m.handled.get(sym) ?? [];
        branches.push({ node: branch, err: ts.isIdentifier(left) ? m.checker.getSymbolAtLocation(left) : undefined });
        m.handled.set(sym, branches);
      }
    }
    if (ts.isCallExpression(n) && depth < MAX_HANDLER_DEPTH) {
      const callee = resolveFunction(m.checker, n.expression);
      if (callee !== undefined) collectHandled(m, callee, nextSym, depth + 1, seen);
    }
  });
}

/**
 * The code that runs when `test` holds: the then-branch of the if / the true arm of the conditional whose
 * condition contains it (through parentheses, `&&` and `||`), else the right side of an `a instanceof C && …`.
 */
function branchOf(test: ts.Node): ts.Node {
  let cur: ts.Node = test;
  let andRight: ts.Node | undefined;
  for (let i = 0; i < 8; i++) {
    const p = cur.parent;
    const logical = ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind);
    if (ts.isParenthesizedExpression(p) || logical) {
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.left === cur) andRight ??= p.right;
      cur = p;
      continue;
    }
    if (ts.isIfStatement(p) && p.expression === cur) return p.thenStatement;
    if (ts.isConditionalExpression(p) && p.condition === cur) return p.whenTrue;
    break;
  }
  return andRight ?? test;
}

/** The handled ancestor (branches) of a class: the class itself or a base the error middleware tests. */
function handledBranches(m: ApiModel, cls: ts.ClassLikeDeclaration): HandledBranch[] | undefined {
  for (const sym of classChain(m.checker, cls)) {
    const b = m.handled.get(sym);
    if (b !== undefined) return b;
  }
  return undefined;
}

/** The class whose instances a type describes, when the error middleware turns them into problems. */
function handledClassOfType(m: ApiModel, type: ts.Type): ts.ClassLikeDeclaration | undefined {
  const t = m.checker.getNonNullableType(type);
  const cls = classOfSymbol(t.getSymbol());
  return cls !== undefined && handledBranches(m, cls) !== undefined ? cls : undefined;
}

/** Expressions inside an error-middleware branch that decide the response status. */
function statusCandidates(branch: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  const isStatusName = (n: string): boolean => /^(http)?status(code)?$/i.test(n);
  walk(branch, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['status', 'sendStatus'].includes(n.expression.name.text) && n.arguments[0] !== undefined) {
      out.push(n.arguments[0]);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isStatusName(n.name.text) && n.initializer !== undefined) out.push(n.initializer);
    if (ts.isPropertyAssignment(n) && propName(n.name) !== undefined && isStatusName(propName(n.name) ?? '')) out.push(n.initializer);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = calleeName(n.left);
      if (name !== undefined && isStatusName(name)) out.push(n.right);
    }
  });
  return out;
}

/** HTTP status of an error instance: its `status`/`statusCode` member, else what the error middleware's branch maps it to. */
function instanceStatus(m: ApiModel, inst: Instance): number | null {
  for (const name of ['status', 'statusCode']) {
    const v = evalMember(m.checker, inst, name);
    if (typeof v === 'number' && v >= 100 && v <= 599) return v;
  }
  const values = new Set<number>();
  for (const b of handledBranches(m, inst.cls) ?? []) {
    const env: Env = b.err !== undefined ? { params: new Map(), instances: new Map([[b.err, inst]]) } : NO_ENV;
    for (const c of statusCandidates(b.node)) {
      const v = evalConst(m.checker, c, env);
      if (typeof v === 'number' && v >= 100 && v <= 599) values.add(v);
    }
  }
  const [only] = [...values];
  return values.size === 1 && only !== undefined ? only : null;
}

// ───────────────────────────── schemas and parse calls ─────────────────────────────

function schemaOrigin(checker: ts.TypeChecker, root: string, expr: ts.Expression): { module?: string; exportName?: string } {
  if (!ts.isIdentifier(expr)) return {};
  const sym = resolveSymbol(checker, expr);
  const decl = sym?.valueDeclaration;
  if (sym === undefined || decl === undefined || !ts.isVariableDeclaration(decl)) return {};
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile) return {};
  const moduleSym = checker.getSymbolAtLocation(sf);
  if (moduleSym === undefined) return {};
  for (const exp of checker.getExportsOfModule(moduleSym)) {
    const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    if (target === sym) return { module: toPosix(relative(root, sf.fileName)), exportName: exp.name };
  }
  return {};
}

function parsedTypeOf(checker: ts.TypeChecker, call: ts.CallExpression, method: string): ts.Type | undefined {
  const raw = checker.getTypeAtLocation(call);
  const t = method.endsWith('Async') ? (checker.getAwaitedType(raw) ?? raw) : raw;
  if (DATA_PARSE_METHODS.has(method)) return t;
  // safeParse: the `data` of the success branch.
  for (const part of t.isUnion() ? t.types : [t]) {
    const success = part.getProperty('success');
    const data = part.getProperty('data');
    if (success === undefined || data === undefined) continue;
    const st = checker.getTypeOfSymbolAtLocation(success, call);
    if (st.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(st) === 'true') {
      return checker.getTypeOfSymbolAtLocation(data, call);
    }
  }
  return undefined;
}

/** The output type of a Zod schema type (Zod 4 `_zod.output`, Zod 3 `_output`). */
export function schemaOutputType(checker: ts.TypeChecker, schemaType: ts.Type, at: ts.Node): ts.Type | undefined {
  const t = checker.getApparentType(checker.getNonNullableType(schemaType));
  const internals = t.getProperty('_zod');
  if (internals !== undefined) {
    const out = checker.getApparentType(checker.getTypeOfSymbolAtLocation(internals, at)).getProperty('output');
    if (out !== undefined) return checker.getTypeOfSymbolAtLocation(out, at);
  }
  const legacy = t.getProperty('_output');
  return legacy !== undefined ? checker.getTypeOfSymbolAtLocation(legacy, at) : undefined;
}

/** `<schema>.<parse method>(…)`: its schema (bound through `env`), 'inactive' when the schema is statically absent. */
function parseCallInfo(
  checker: ts.TypeChecker,
  root: string,
  call: ts.CallExpression,
  env: Env,
  methods: ReadonlySet<string> = PARSE_METHODS,
): SchemaRef | 'inactive' | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !methods.has(callee.name.text)) return undefined;
  const written = callee.expression;
  const r = resolveValue(checker, written, env, false);
  if (r === 'absent') return 'inactive';
  const schemaExpr = r.expr;
  if (schemaExpr === unwrap(written)) {
    if (!isZodSchemaType(checker, checker.getTypeAtLocation(written))) return undefined;
    const ref: SchemaRef = { expr: written, text: written.getText(), ...schemaOrigin(checker, root, written) };
    const parsedType = parsedTypeOf(checker, call, callee.name.text);
    if (parsedType !== undefined) ref.parsedType = parsedType;
    return ref;
  }
  // Bound at a factory call site (`validate({ body: CreateOrder })`): the call-site schema decides.
  const type = checker.getTypeAtLocation(schemaExpr);
  if (!isZodSchemaType(checker, type)) return undefined;
  const ref: SchemaRef = { expr: schemaExpr, text: schemaExpr.getText(), ...schemaOrigin(checker, root, schemaExpr) };
  const parsedType = schemaOutputType(checker, type, schemaExpr);
  if (parsedType !== undefined) ref.parsedType = parsedType;
  return ref;
}

/** If `call` is `<zod schema>.<parse method>(…)`, its SchemaRef. */
export function parseCallSchema(
  checker: ts.TypeChecker,
  root: string,
  call: ts.CallExpression,
  methods: ReadonlySet<string> = PARSE_METHODS,
): SchemaRef | undefined {
  const info = parseCallInfo(checker, root, call, NO_ENV, methods);
  return info === 'inactive' ? undefined : info;
}

/**
 * Schema of a body expression that is `S.parse(…)` / `await S.parseAsync(…)`, a const initialised
 * with one, or a call of a helper (`toDto(user)`) whose every returned expression is such a body.
 */
export function bodySchema(checker: ts.TypeChecker, root: string, body: ts.Expression, depth = 0): SchemaRef | undefined {
  let e = unwrap(body);
  if (ts.isIdentifier(e)) {
    const init = constInitializer(checker, e);
    if (init === undefined) return undefined;
    e = unwrap(init);
  }
  if (!ts.isCallExpression(e)) return undefined;
  const direct = parseCallSchema(checker, root, e, DATA_PARSE_METHODS);
  if (direct !== undefined || depth >= MAX_HANDLER_DEPTH) return direct;
  const helper = resolveFunction(checker, e.expression);
  if (helper === undefined) return undefined;
  const returns = returnedExpressions(helper);
  let first: SchemaRef | undefined;
  for (const ret of returns) {
    const s = bodySchema(checker, root, ret, depth + 1);
    if (s === undefined) return undefined;
    first ??= s;
  }
  return first;
}

function isAnyOrUnknown(t: ts.Type): boolean {
  return (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * Why a schema's output validates nothing about the data, or undefined: any/unknown output (z.any(),
 * z.unknown(), z.custom() without a type), a record of unknown/any values, an object with no properties
 * that passes unknown keys through (`z.object({}).passthrough()/.loose()`), or an array of those.
 */
export function permissiveReason(checker: ts.TypeChecker, type: ts.Type | undefined, depth = 0): string | undefined {
  if (type === undefined || depth > 4) return undefined;
  if (isAnyOrUnknown(type)) return 'its output is any/unknown';
  const t = checker.getNonNullableType(type);
  if (isAnyOrUnknown(t)) return 'its output is any/unknown';
  if (checker.isArrayType(t)) {
    const [el] = checker.getTypeArguments(t as ts.TypeReference);
    const inner = permissiveReason(checker, el, depth + 1);
    return inner !== undefined ? `its array elements are unchecked (${inner})` : undefined;
  }
  if (t.flags & ts.TypeFlags.Object && checker.getPropertiesOfType(t).length === 0) {
    const index = checker.getIndexInfoOfType(t, ts.IndexKind.String);
    if (index !== undefined && isAnyOrUnknown(index.type)) return 'it is a record/passthrough object of unknown values with no declared properties';
  }
  return undefined;
}

// ───────────────────────────── problems ─────────────────────────────

/** Name of a call/new that names a problem (helper, `problem(…)`, `new HttpProblem(…)`, `ProblemSchema.parse(…)`). */
export function problemProducerName(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
  const callee = unwrap(node.expression);
  const name = calleeName(callee);
  if (name === undefined) return undefined;
  if (Object.hasOwn(PROBLEM_HELPERS, name)) return name;
  if (/problem/i.test(name) && !NON_PRODUCER.test(name)) return name;
  if (ts.isPropertyAccessExpression(callee) && PARSE_METHODS.has(name)) {
    const recv = calleeName(callee.expression);
    if (recv !== undefined && /problem/i.test(recv)) return `${recv}.${name}`;
  }
  return undefined;
}

const PRIMITIVE =
  ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never;

/** A data object: not a primitive and not a function (a middleware factory named `problemHandler()` is not a producer). */
function yieldsObject(type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((p) => (p.flags & PRIMITIVE) === 0 && p.getCallSignatures().length === 0);
}

/** An Error value (has `name` and `message`). */
export function isErrorLike(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const t = checker.getApparentType(checker.getNonNullableType(type));
  return t.getProperty('message') !== undefined && t.getProperty('name') !== undefined;
}

export interface Producer {
  name: string;
  /**
   * handled: an error class the error middleware turns into a problem (it supplies the members);
   * error: an Error that must itself carry type/title/status; document: a problem object that must carry all five members.
   */
  kind: 'handled' | 'error' | 'document';
}

/**
 * A call/new that produces a problem, judged by behaviour: an instance of an error class the error middleware
 * handles (and its subclasses), a problem-shaped `new X(...)`, or a problem-named helper that yields an object.
 */
export function problemProducer(m: ApiModel, node: ts.Node): Producer | undefined {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
  const { checker } = m;
  const t = checker.getTypeAtLocation(node);
  const name = problemProducerName(node);
  const label = name ?? calleeName(node.expression) ?? node.expression.getText();
  if (!(t.flags & ts.TypeFlags.Any) && handledClassOfType(m, t) !== undefined) return { name: label, kind: 'handled' };
  if (name === undefined) {
    // `new UserNotFoundError(id)` where the class is problem-shaped (e.g. extends HttpProblem).
    if (!ts.isNewExpression(node) || !isProblemShaped(checker, t)) return undefined;
    return { name: label, kind: isErrorLike(checker, t) ? 'error' : 'document' };
  }
  if (t.flags & ts.TypeFlags.Any) return { name, kind: 'document' }; // unresolved types: trust the name
  if (!yieldsObject(t)) return undefined;
  return { name, kind: isErrorLike(checker, t) ? 'error' : 'document' };
}

/** A type with `type`, `title` and `status` members (an HttpProblem, its subclasses, a Problem object). */
export function isProblemShaped(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const t = checker.getApparentType(type);
  return ['type', 'title', 'status'].every((k) => t.getProperty(k) !== undefined);
}

function isStringish(checker: ts.TypeChecker, t: ts.Type): boolean {
  return (checker.getApparentType(t).flags & ts.TypeFlags.StringLike) !== 0 || (t.flags & ts.TypeFlags.StringLike) !== 0 || checker.typeToString(t) === 'String';
}

function isNumberish(checker: ts.TypeChecker, t: ts.Type): boolean {
  return (t.flags & ts.TypeFlags.NumberLike) !== 0 || checker.typeToString(t) === 'Number';
}

/**
 * Members of `fields` the type lacks (or has with the wrong primitive type). With `required`, an optional
 * member counts as missing: a problem document must always carry it.
 */
export function missingMembers(checker: ts.TypeChecker, type: ts.Type, at: ts.Node, fields: readonly string[], required: boolean): string[] {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return [...fields];
  const apparent = checker.getApparentType(checker.getNonNullableType(type));
  return fields.filter((f) => {
    const sym = apparent.getProperty(f);
    if (sym === undefined || (required && sym.flags & ts.SymbolFlags.Optional)) return true;
    const ft = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(sym, at));
    return !(f === 'status' ? isNumberish(checker, ft) : isStringish(checker, ft));
  });
}

/** Whether a value is a full problem document by type: type, title, status, detail and instance, all required. */
export function isProblemDocument(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): boolean {
  return missingMembers(checker, type, at, PROBLEM_MEMBERS, true).length === 0;
}

/**
 * Status a problem producer creates: for `new C(...)` the instance's status/statusCode member or what the
 * error middleware maps the class to; for a helper call, what its returned producer creates (arguments
 * bound); then a numeric argument / `{ status: n }` argument; then the helper-name table.
 */
export function problemStatus(m: ApiModel, node: ts.CallExpression | ts.NewExpression, name: string, env: Env = NO_ENV, depth = 0): number | null {
  const { checker } = m;
  if (ts.isNewExpression(node)) {
    const cls = classOf(checker, node.expression);
    if (cls !== undefined) {
      const s = instanceStatus(m, { cls, args: node.arguments ?? [], argEnv: env });
      if (s !== null) return s;
    }
  } else if (depth < MAX_HANDLER_DEPTH) {
    const helper = resolveFunction(checker, node.expression);
    if (helper !== undefined) {
      const helperEnv = bindCall(checker, helper, node.arguments, env);
      const found = new Set<number>();
      for (const ret of returnedExpressions(helper)) {
        const r = unwrap(ret);
        if (!ts.isCallExpression(r) && !ts.isNewExpression(r)) continue;
        const s = problemStatus(m, r, calleeName(r.expression) ?? '', helperEnv, depth + 1);
        if (s !== null) found.add(s);
      }
      const [only] = [...found];
      if (found.size === 1 && only !== undefined) return only;
    }
  }
  const own = literalStatus(checker, node, env);
  if (own !== null) return own;
  return PROBLEM_HELPERS[name] ?? null;
}

function literalStatus(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression, env: Env): number | null {
  for (const arg of node.arguments ?? []) {
    const n = numericValue(checker, arg, env);
    if (n !== null && n >= 100 && n <= 599) return n;
    const a = unwrap(arg);
    if (ts.isObjectLiteralExpression(a)) {
      for (const p of a.properties) {
        if (ts.isPropertyAssignment(p) && propName(p.name) === 'status') {
          const v = numericValue(checker, p.initializer, env);
          if (v !== null) return v;
        }
      }
    }
  }
  return null;
}

// ───────────────────────────── response chains ─────────────────────────────

export interface ResponseChain {
  call: ts.CallExpression;
  method: string;
  /** Root expression of the chain (e.g. the `res` identifier). */
  root: ts.Expression;
  /** The status when it is a single known value (200 when none is set), else null. */
  status: number | null;
  /** Every status the chain can send; null when unknown. */
  statuses: number[] | null;
  /** Whether a .status()/.sendStatus() appeared in the chain at all. */
  statusSet: boolean;
  /** The status argument, when one was set. */
  statusExpr: ts.Expression | undefined;
  statusNodes: Array<{ status: number; node: ts.Node }>;
  body: ts.Expression | undefined;
}

/** Decompose `x.status(n).location(u).json(body)` style calls. */
export function responseChain(checker: ts.TypeChecker, call: ts.CallExpression, env: Env = NO_ENV): ResponseChain | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !RESPONSE_METHODS.has(callee.name.text)) return undefined;
  const method = callee.name.text;
  let statusExpr: ts.Expression | undefined = method === 'sendStatus' ? call.arguments[0] : undefined;
  let statusNode: ts.Node | undefined = method === 'sendStatus' ? call : undefined;
  let statusSet = method === 'sendStatus';
  let cur: ts.Expression = callee.expression;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    if (cur.expression.name.text === 'status' && !statusSet) {
      statusSet = true;
      statusExpr = cur.arguments[0];
      statusNode = cur;
    }
    cur = cur.expression.expression;
  }
  const statuses = statusSet ? statusValues(checker, statusExpr, env) : [200];
  const status = statuses !== null && statuses.length === 1 ? (statuses[0] ?? null) : null;
  const statusNodes = statuses !== null && statusNode !== undefined ? statuses.map((s) => ({ status: s, node: statusNode })) : [];
  const body = method === 'sendStatus' ? undefined : call.arguments[0];
  return { call, method, root: cur, status, statuses, statusSet, statusExpr, statusNodes, body };
}

/**
 * A replay of a recorded response: `res.status(r.status).json(r.body)` with both read from the same record
 * and an opaque (unknown/any) body. The recorded response was itself checked where it was first sent.
 */
export function isReplay(checker: ts.TypeChecker, chain: ResponseChain): boolean {
  if (chain.statusExpr === undefined || chain.body === undefined) return false;
  const s = unwrap(chain.statusExpr);
  const b = unwrap(chain.body);
  if (!(ts.isPropertyAccessExpression(s) || ts.isElementAccessExpression(s)) || !(ts.isPropertyAccessExpression(b) || ts.isElementAccessExpression(b))) return false;
  const sr = unwrap(s.expression);
  const br = unwrap(b.expression);
  if (!ts.isIdentifier(sr) || !ts.isIdentifier(br)) return false;
  const sym = checker.getSymbolAtLocation(sr);
  return sym !== undefined && sym === checker.getSymbolAtLocation(br) && isAnyOrUnknown(checker.getTypeAtLocation(b));
}

// ───────────────────────────── function analysis ─────────────────────────────

interface FnFacts {
  parses: ParseSite[];
  /** Raw request reads, each with its position (for write-backs earlier in the same function). */
  reads: Array<{ target: string; node: ts.Node }>;
  /** `req.<part> = <parsed value>` (also defineProperty / Object.assign). */
  writeBacks: Array<{ target: string; pos: number }>;
  responses: ResponseSite[];
  statusLiterals: Array<{ status: number; node: ts.Node }>;
  problemSites: Array<{ name: string; status: number | null; node: ts.Node }>;
  resEscapes: ts.Node[];
  idempotencyKey: boolean;
}

function emptyFacts(): FnFacts {
  return { parses: [], reads: [], writeBacks: [], responses: [], statusLiterals: [], problemSites: [], resEscapes: [], idempotencyKey: false };
}

/** `res` used other than as `res.<member>`: aliased, or passed to a non-problem helper. */
function isResEscape(id: ts.Identifier): boolean {
  const parent = id.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === id) return false;
  if (ts.isCallExpression(parent) && parent.arguments.includes(id)) {
    const name = calleeName(parent.expression);
    return name === undefined || !/problem/i.test(name);
  }
  return true;
}

function reqRead(checker: ts.TypeChecker, id: ts.Identifier, env: Env): { target: string; node: ts.Node } {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
    const name = parent.name.text;
    if (REQ_TARGETS.has(name) || REQ_RAW_INPUTS.has(name)) return { target: name, node: parent };
    if ((name === 'get' || name === 'header') && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      return { target: 'headers', node: parent.parent };
    }
    return { target: '', node: parent }; // req.method, req.originalUrl, … are not client payload
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === id) {
    const key = constString(checker, parent.argumentExpression, env);
    if (key !== undefined && !REQ_TARGETS.has(key) && !REQ_RAW_INPUTS.has(key)) return { target: '', node: parent };
    return { target: key ?? 'req[…]', node: parent };
  }
  // Bare use (destructuring, aliasing, passing req along): unverifiable.
  return { target: 'req', node: id };
}

/** Whether `expr` is (a const holding) the data of an active parse: `S.parse(x)`, `await S.parseAsync(x)`, `S.safeParse(x).data`. */
function isParseResult(m: ApiModel, expr: ts.Expression, env: Env, depth = 0): boolean {
  if (depth > 4) return false;
  const e = unwrap(expr);
  const active = (call: ts.Expression, methods: ReadonlySet<string>): boolean => {
    const c = unwrap(call);
    const info = ts.isCallExpression(c) ? parseCallInfo(m.checker, m.root, c, env, methods) : undefined;
    return info !== undefined && info !== 'inactive';
  };
  if (ts.isIdentifier(e)) {
    const init = constInitializer(m.checker, e);
    return init !== undefined && isParseResult(m, init, env, depth + 1);
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    // `S.safeParse(x).data`, or a member of a parsed value (`parsed.body`).
    const recv = unwrap(e.expression);
    const recvValue = ts.isIdentifier(recv) ? (constInitializer(m.checker, recv) ?? recv) : recv;
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'data' && active(recvValue, PARSE_METHODS)) return true;
    return isParseResult(m, recv, env, depth + 1);
  }
  return active(e, DATA_PARSE_METHODS);
}

/** JSON.stringify of the standard library: it serialises a value without trusting its shape. */
function isJsonStringify(checker: ts.TypeChecker, callee: ts.Expression): boolean {
  const e = unwrap(callee);
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'stringify' || !ts.isIdentifier(e.expression) || e.expression.text !== 'JSON') return false;
  const sym = resolveSymbol(checker, e.expression);
  return (sym?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * A raw read whose value is only serialised (JSON.stringify, a template string), directly or through a
 * program function's `unknown` parameter used that way: hashing or logging input does not trust its shape.
 */
function isOpaqueUse(m: ApiModel, node: ts.Node, depth = 0): boolean {
  let cur = node;
  for (let i = 0; i < 12; i++) {
    const p = cur.parent;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) {
      cur = p;
    } else if (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) {
      cur = p;
    } else if (ts.isPropertyAssignment(p) && p.initializer === cur && ts.isObjectLiteralExpression(p.parent)) {
      cur = p.parent;
    } else if (ts.isTemplateSpan(p)) {
      return true;
    } else {
      break;
    }
  }
  const call = cur.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(cur as ts.Expression)) return false;
  if (isJsonStringify(m.checker, call.expression)) return true;
  if (depth >= 2) return false;
  const fn = resolveFunction(m.checker, call.expression);
  const param = fn?.parameters[call.arguments.indexOf(cur as ts.Expression)];
  if (fn?.body === undefined || param === undefined || !ts.isIdentifier(param.name) || param.type?.kind !== ts.SyntaxKind.UnknownKeyword) return false;
  const sym = m.checker.getSymbolAtLocation(param.name);
  let opaque = true;
  walk(fn.body, (n) => {
    if (opaque && ts.isIdentifier(n) && m.checker.getSymbolAtLocation(n) === sym && !isOpaqueUse(m, n, depth + 1)) opaque = false;
  });
  return opaque;
}

/** `req.<part>` / `req['part']` on the request symbol: the part name. */
function reqMember(m: ApiModel, e: ts.Expression, isReq: (n: ts.Node) => boolean, env: Env): string | undefined {
  const x = unwrap(e);
  if (ts.isPropertyAccessExpression(x) && isReq(unwrap(x.expression))) return x.name.text;
  if (ts.isElementAccessExpression(x) && isReq(unwrap(x.expression))) return constString(m.checker, x.argumentExpression, env);
  return undefined;
}

/**
 * Analyse one function of a route's chain. `reqIndex`/`resIndex` locate the request/response parameters
 * (resIndex -1: responses are not tracked, e.g. for a callee that only receives `req`).
 */
function analyseFunction(m: ApiModel, fn: ts.FunctionLikeDeclaration, env: Env, reqIndex: number, resIndex: number, depth = 0): FnFacts {
  const { checker, root } = m;
  const facts = emptyFacts();
  const body = fn.body;
  if (body === undefined) return facts;
  const reqParam = fn.parameters[reqIndex];
  const reqSym = paramSymbol(checker, fn, reqIndex);
  const resSym = resIndex >= 0 ? paramSymbol(checker, fn, resIndex) : undefined;
  const isSym = (n: ts.Node, s: ts.Symbol | undefined): boolean => s !== undefined && ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === s;
  const isReq = (n: ts.Node): boolean => isSym(n, reqSym);
  const writes = new Set<ts.Node>();

  // `({ body, params }, res) => …`: destructuring the request reads those parts raw.
  if (reqParam !== undefined && ts.isObjectBindingPattern(reqParam.name)) {
    for (const el of reqParam.name.elements) {
      const key = el.dotDotDotToken !== undefined ? 'req' : el.propertyName !== undefined ? propName(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : undefined;
      if (key !== undefined && (key === 'req' || REQ_TARGETS.has(key) || REQ_RAW_INPUTS.has(key))) facts.reads.push({ target: key, node: el });
    }
  }

  const addParse = (target: string, call: ts.CallExpression, schema: SchemaRef): void => {
    if (target === 'params' || target === 'query' || target === 'body' || target === 'headers') facts.parses.push({ target, call, schema });
    if (target === 'headers' && schema.parsedType !== undefined) {
      const props = checker.getApparentType(schema.parsedType).getProperties();
      if (props.some((p) => p.name.toLowerCase() === IDEMPOTENCY_HEADER)) facts.idempotencyKey = true;
    }
  };

  walk(body, (node) => {
    // Write-backs: `req.body = S.parse(req.body)`, `Object.defineProperty(req, 'query', { value: S.parse(…) })`.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const part = reqMember(m, node.left, isReq, env);
      if (part !== undefined) {
        writes.add(unwrap(node.left));
        if (REQ_TARGETS.has(part) && isParseResult(m, node.right, env)) facts.writeBacks.push({ target: part, pos: node.getStart() });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && calleeName(node.expression.expression) === 'Object' && node.arguments[0] !== undefined && isReq(unwrap(node.arguments[0]))) {
      const how = node.expression.name.text;
      writes.add(unwrap(node.arguments[0]));
      const pairs: Array<[string | undefined, ts.Expression | undefined]> = [];
      if (how === 'defineProperty') {
        const desc = node.arguments[2] !== undefined ? unwrap(node.arguments[2]) : undefined;
        const value = desc !== undefined && ts.isObjectLiteralExpression(desc) ? desc.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name) === 'value') : undefined;
        pairs.push([constString(checker, node.arguments[1], env), value?.initializer]);
      } else if (how === 'assign') {
        for (const src of node.arguments.slice(1)) {
          const o = unwrap(src);
          if (ts.isObjectLiteralExpression(o)) for (const p of o.properties) if (ts.isPropertyAssignment(p)) pairs.push([propName(p.name), p.initializer]);
        }
      }
      for (const [part, value] of pairs) {
        if (part !== undefined && value !== undefined && REQ_TARGETS.has(part) && isParseResult(m, value, env)) facts.writeBacks.push({ target: part, pos: node.getStart() });
      }
    }

    if (isReq(node) && ts.isIdentifier(node)) {
      if (writes.has(node)) return;
      const read = reqRead(checker, node, env);
      if (read.target === '' || writes.has(read.node)) return;
      if (read.target === 'req') {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
          const info = parseCallInfo(checker, root, parent, env);
          if (info === 'inactive') return;
          if (info !== undefined) {
            // `S.parse(req)`: every request part the schema's output declares is parsed.
            for (const part of REQ_TARGETS) {
              const pt = info.parsedType !== undefined ? propertyType(checker, info.parsedType, part, parent) : undefined;
              if (pt !== undefined) addParse(part, parent, { ...info, parsedType: pt, member: part, ...noOrigin });
            }
            return;
          }
        }
        if (ts.isCallExpression(parent) && parent.arguments.includes(node) && depth < MAX_HANDLER_DEPTH) {
          const callee = resolveFunction(checker, parent.expression);
          if (callee !== undefined && isProgramNode(callee)) {
            const sub = analyseFunction(m, callee, bindCall(checker, callee, parent.arguments, env), parent.arguments.indexOf(node), -1, depth + 1);
            facts.parses.push(...sub.parses);
            facts.reads.push(...sub.reads);
            facts.writeBacks.push(...sub.writeBacks);
            facts.idempotencyKey ||= sub.idempotencyKey;
            return;
          }
        }
        facts.reads.push(read);
        return;
      }
      // `IdSchema.parse(req.params.userId)` parses one field of the input: the argument is the member read.
      let arg: ts.Node = read.node;
      const up = arg.parent;
      if (REQ_TARGETS.has(read.target) && (ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up)) && up.expression === arg) arg = up;
      if (read.target === 'headers') {
        const key = ts.isCallExpression(read.node) ? constString(checker, read.node.arguments[0], env) : ts.isElementAccessExpression(arg) ? constString(checker, arg.argumentExpression, env) : undefined;
        if (key?.toLowerCase() === IDEMPOTENCY_HEADER) facts.idempotencyKey = true;
      }
      const parent = arg.parent;
      if (ts.isCallExpression(parent) && parent.arguments[0] === arg) {
        const info = parseCallInfo(checker, root, parent, env);
        if (info === 'inactive') return;
        // `JSON.stringify(z.unknown().parse(req.body))`: a no-op parse of a value that is only serialised.
        if (info !== undefined && permissiveReason(checker, info.parsedType) !== undefined && isOpaqueUse(m, parent)) return;
        if (info !== undefined) {
          addParse(read.target, parent, info);
          return;
        }
      }
      // `S.parse({ body: req.body, query: req.query })`: the member of the schema output is the part's schema.
      // Only a whole part under its own name counts (`{ id: req.body.id }` builds a value from raw input).
      if (ts.isPropertyAssignment(parent) && parent.initializer === arg && arg === read.node && ts.isObjectLiteralExpression(parent.parent)) {
        const call = parent.parent.parent;
        const key = propName(parent.name);
        if (ts.isCallExpression(call) && call.arguments[0] === parent.parent && key === read.target) {
          const info = parseCallInfo(checker, root, call, env);
          if (info === 'inactive') return;
          // A schema without that member strips the part: it is not validated, and not used either.
          if (info !== undefined) {
            const pt = info.parsedType !== undefined ? propertyType(checker, info.parsedType, key, call) : undefined;
            if (pt !== undefined) addParse(read.target, call, { ...info, member: key, ...noOrigin, parsedType: pt });
            return;
          }
        }
      }
      if (isOpaqueUse(m, arg)) return;
      facts.reads.push(read);
      return;
    }
    if (isSym(node, resSym) && ts.isIdentifier(node)) {
      if (isResEscape(node)) facts.resEscapes.push(node);
      return;
    }
    if (ts.isCallExpression(node) && resSym !== undefined) {
      const chain = responseChain(checker, node, env);
      if (chain !== undefined && isSym(unwrap(chain.root), resSym)) {
        const site: ResponseSite = {
          call: node,
          status: chain.status,
          statuses: chain.statuses,
          hasBody: chain.body !== undefined,
          isProblem: chain.body !== undefined && isProblemDocument(checker, checker.getTypeAtLocation(chain.body), chain.body),
        };
        const schema = chain.body !== undefined ? bodySchema(checker, root, chain.body) : undefined;
        if (schema !== undefined) site.schema = schema;
        facts.responses.push(site);
      }
      // res.status(n) anywhere (including statements that do not end in a send).
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'status' || callee.name.text === 'sendStatus')) {
        let r: ts.Expression = callee.expression;
        while (ts.isCallExpression(r) && ts.isPropertyAccessExpression(r.expression)) r = r.expression.expression;
        if (isSym(unwrap(r), resSym)) {
          for (const n of statusValues(checker, node.arguments[0], env) ?? []) facts.statusLiterals.push({ status: n, node });
        }
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const producer = problemProducer(m, node);
      if (producer !== undefined) {
        const status = problemStatus(m, node, producer.name, env);
        facts.problemSites.push({ name: producer.name, status, node });
        if (status !== null) facts.statusLiterals.push({ status, node });
      }
    }
  });
  // Reads after a write-back of the same part in this function see the parsed value.
  facts.reads = facts.reads.filter((r) => !facts.writeBacks.some((w) => w.target === r.target && w.pos < r.node.getStart()));
  return facts;
}

/** A sub-schema (one member of a request-wide schema) is not an exported schema of its own. */
const noOrigin = { module: undefined, exportName: undefined } as const;

/** Problem producers in the functions `fn` calls (transitively, program sources only, excluding `fn` itself). */
function calleeProblems(m: ApiModel, fn: ts.FunctionLikeDeclaration): FnFacts['problemSites'] {
  const out: FnFacts['problemSites'] = [];
  const seen = new Set<ts.Node>([fn]);
  let frontier: ts.FunctionLikeDeclaration[] = [fn];
  for (let depth = 0; depth < MAX_HANDLER_DEPTH && frontier.length > 0; depth++) {
    const next: ts.FunctionLikeDeclaration[] = [];
    for (const f of frontier) {
      if (f.body === undefined) continue;
      walk(f.body, (n) => {
        if (!ts.isCallExpression(n)) return;
        const target = resolveFunction(m.checker, n.expression);
        if (target === undefined || seen.has(target)) return;
        seen.add(target);
        next.push(target);
        if (target.body === undefined) return;
        walk(target.body, (x) => {
          if (!ts.isCallExpression(x) && !ts.isNewExpression(x)) return;
          const producer = problemProducer(m, x);
          if (producer !== undefined) out.push({ name: producer.name, status: problemStatus(m, x, producer.name), node: x });
        });
      });
    }
    frontier = next;
  }
  return out;
}

/** A callable resolved with the bindings it closes over. */
interface Callable {
  fn: ts.FunctionLikeDeclaration;
  env: Env;
}

/**
 * Route handler / middleware: like resolveFunction, plus
 *  - a parameter bound at a factory call site,
 *  - one level of wrapper whose last argument is the function (`asyncHandler(async (req, res) => …)`),
 *  - `fn.bind(thisArg)`,
 *  - a factory call (`validate({ body: S })`, `getUser(service)`) whose returned expression is itself a handler,
 *    with the factory's parameters bound to the call's arguments.
 */
function resolveCallable(m: ApiModel, expr: ts.Expression, env: Env, depth = 0): Callable | undefined {
  const { checker } = m;
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) {
    const bound = boundOf(checker, e, env);
    if (bound !== undefined) return bound.expr !== undefined && depth < MAX_HANDLER_DEPTH ? resolveCallable(m, bound.expr, bound.env, depth + 1) : undefined;
  }
  const direct = resolveFunction(checker, e);
  if (direct !== undefined) return { fn: direct, env };
  if (ts.isIdentifier(e) && depth < MAX_HANDLER_DEPTH) {
    // `const validateBody = validate({ body: S })`: the const holds a factory's result.
    const init = constInitializer(checker, e);
    if (init !== undefined && ts.isCallExpression(unwrap(init))) return resolveCallable(m, init, env, depth + 1);
  }
  if (!ts.isCallExpression(e) || depth >= MAX_HANDLER_DEPTH) return undefined;
  const callee = unwrap(e.expression);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return resolveCallable(m, callee.expression, env, depth + 1);
  const last = e.arguments[e.arguments.length - 1];
  const wrapped = last !== undefined ? resolveCallable(m, last, env, depth + 1) : undefined;
  if (wrapped !== undefined && wrapped.fn.parameters.length >= 2) return wrapped;
  const factory = resolveFunction(checker, callee);
  if (factory === undefined) return wrapped;
  const factoryEnv = bindCall(checker, factory, e.arguments, env);
  for (const ret of returnedExpressions(factory)) {
    const h = resolveCallable(m, ret, factoryEnv, depth + 1);
    if (h !== undefined) return h;
  }
  return wrapped;
}

/** Handler arguments with arrays (`[auth, validate(...)]`, `...handlers`, or a const holding one) flattened. */
function flattenArgs(checker: ts.TypeChecker, args: readonly ts.Expression[]): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (const a of args) {
    let e = unwrap(ts.isSpreadElement(a) ? a.expression : a);
    if (ts.isIdentifier(e)) {
      const init = constInitializer(checker, e);
      if (init !== undefined && ts.isArrayLiteralExpression(unwrap(init))) e = unwrap(init);
    }
    if (ts.isArrayLiteralExpression(e)) out.push(...flattenArgs(checker, e.elements));
    else out.push(ts.isSpreadElement(a) ? a.expression : a);
  }
  return out;
}

// ───────────────────────────── mounts and scope ─────────────────────────────

interface Mount {
  child: ts.Symbol;
  parent: ts.Symbol | undefined;
  /** null: the prefix could not be resolved. */
  prefixes: string[] | null;
  call: ts.CallExpression;
  pathNode: ts.Expression | undefined;
}

function rootSymbol(checker: ts.TypeChecker, expr: ts.Expression): ts.Symbol | undefined {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return resolveSymbol(checker, e);
  if (ts.isPropertyAccessExpression(e)) return resolveSymbol(checker, e.name);
  if (ts.isCallExpression(e)) {
    // `createUsersRouter()` → the function symbol stands for its router.
    return resolveSymbol(checker, ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression);
  }
  return undefined;
}

/** Whether the first `.use()` argument is a path (string, string[] or RegExp by type) rather than middleware. */
function isPathArgument(checker: ts.TypeChecker, arg: ts.Expression): boolean {
  const e = unwrap(arg);
  if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e) || ts.isRegularExpressionLiteral(e)) return true;
  const type = checker.getTypeAtLocation(e);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const stringish = (t: ts.Type): boolean => (t.flags & ts.TypeFlags.StringLike) !== 0;
  if (stringish(type) || (type.isUnion() && type.types.every(stringish))) return true;
  if (checker.isArrayType(type)) return checker.getTypeArguments(type as ts.TypeReference).every((t) => stringish(t));
  return type.getSymbol()?.name === 'RegExp';
}

function pathValues(checker: ts.TypeChecker, arg: ts.Expression): string[] | null {
  const e = unwrap(arg);
  if (ts.isArrayLiteralExpression(e)) {
    const out: string[] = [];
    for (const el of e.elements) {
      const v = constString(checker, el);
      if (v === undefined) return null;
      out.push(v);
    }
    return out;
  }
  const v = constString(checker, e);
  return v === undefined ? null : [v];
}

function collectUses(m: ApiModel): UseCall[] {
  const { checker } = m;
  const uses: UseCall[] = [];
  for (const { sf } of m.sources) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== 'use' || !isExpressReceiver(checker, node.expression.expression)) return;
      const first = node.arguments[0];
      const hasPath = first !== undefined && isPathArgument(checker, first);
      uses.push({
        call: node,
        owner: rootSymbol(checker, node.expression.expression),
        paths: hasPath && first !== undefined ? pathValues(checker, first) : undefined,
        pathNode: hasPath ? first : undefined,
        args: flattenArgs(checker, node.arguments.slice(hasPath ? 1 : 0)),
      });
    });
  }
  return uses;
}

function mountsOf(m: ApiModel): Mount[] {
  const out: Mount[] = [];
  for (const u of m.uses) {
    for (const arg of u.args) {
      const child = rootSymbol(m.checker, arg);
      if (child !== undefined) out.push({ child, parent: u.owner, prefixes: u.paths === undefined ? [''] : u.paths, call: u.call, pathNode: u.pathNode });
    }
  }
  return out;
}

export function joinPaths(prefix: string, path: string): string {
  if (prefix === '' || prefix === '/') return path;
  const p = prefix.replace(/\/+$/, '');
  if (path === '/' || path === '') return p;
  return `${p}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * The factory function that creates and returns the router bound to `sym`
 * (`function createApiRouter() { const api = Router(); …; return api; }`), so a
 * mount of `createApiRouter()` applies to routes registered on `api`.
 */
function factoryOf(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol | undefined {
  const decl = sym.valueDeclaration;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return undefined;
  let fn: ts.Node | undefined = decl.parent;
  while (fn !== undefined && !isFunctionLike(fn)) fn = fn.parent;
  if (fn === undefined || !isFunctionLike(fn) || fn.body === undefined) return undefined;
  let returned = false;
  walk(fn.body, (n) => {
    if (ts.isReturnStatement(n) && n.expression !== undefined && ts.isIdentifier(unwrap(n.expression))) {
      if (resolveSymbol(checker, unwrap(n.expression)) === sym) returned = true;
    }
  });
  if (!returned) return undefined;
  const nameNode = fn.name ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined);
  return nameNode !== undefined ? resolveSymbol(checker, nameNode) : undefined;
}

interface Prefixes {
  values: string[];
  /** A mount on the way up whose path could not be resolved. */
  unresolved?: ts.Node;
}

/** Every function symbol some call expression in the sources invokes. */
function calledSymbols(m: ApiModel): Set<ts.Symbol> {
  if (m.called !== undefined) return m.called;
  const out = new Set<ts.Symbol>();
  for (const { sf } of m.sources) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = unwrap(n.expression);
      const sym = resolveSymbol(m.checker, ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      if (sym !== undefined) out.add(sym);
    });
  }
  m.called = out;
  return out;
}

/**
 * A router (not an application: apps are the roots that get served) created inside a factory that
 * nothing in the sources calls: what is mounted on it is never served.
 */
function isDeadRouter(m: ApiModel, sym: ts.Symbol | undefined): boolean {
  const decl = sym?.valueDeclaration;
  if (sym === undefined || decl === undefined || !ts.isVariableDeclaration(decl)) return false;
  const type = m.checker.getApparentType(m.checker.getTypeOfSymbolAtLocation(sym, decl));
  if (type.getProperty('listen') !== undefined) return false;
  const factory = factoryOf(m.checker, sym);
  return factory !== undefined && !calledSymbols(m).has(factory);
}

/** Every full prefix the routes of router `sym` are served under (composed through nested mounts). */
function prefixesOf(m: ApiModel, mounts: Mount[], sym: ts.Symbol | undefined, seen: Set<ts.Symbol> = new Set()): Prefixes {
  if (sym === undefined || seen.has(sym)) return { values: [''] };
  const inner = new Set(seen).add(sym);
  const factory = factoryOf(m.checker, sym);
  const own = mounts.filter((x) => (x.child === sym || (factory !== undefined && x.child === factory)) && !isDeadRouter(m, x.parent));
  if (own.length === 0) return { values: [''] };
  const values = new Set<string>();
  let unresolved: ts.Node | undefined;
  for (const mount of own) {
    const parent = prefixesOf(m, mounts, mount.parent, inner);
    unresolved ??= parent.unresolved;
    if (mount.prefixes === null) {
      unresolved ??= mount.pathNode ?? mount.call;
      continue;
    }
    for (const pp of parent.values) for (const p of mount.prefixes) values.add(joinPaths(pp, p));
  }
  return unresolved !== undefined ? { values: [...values], unresolved } : { values: [...values] };
}

/** `:name` → `:` so a use path and a route path with differently named params compare equal. */
function normalizeParams(path: string): string {
  return path.replace(/:[^/]+/g, ':');
}

function pathCovers(prefix: string, fullPath: string): boolean {
  const p = normalizeParams(prefix.replace(/\/+$/, ''));
  const f = normalizeParams(fullPath);
  return p === '' || f === p || f.startsWith(`${p}/`);
}

/**
 * Middleware registered with `.use()` on the route's router before the route, or on a router/app it is
 * mounted on before that mount (same file; other files: included), whose path covers the route.
 * Outermost (app-level) middleware first, as Express runs it.
 */
function scopeMiddlewareFor(m: ApiModel, mounts: Mount[], reg: Registration, fullPath: string): ts.Expression[] {
  const levels: ts.Expression[][] = [];
  const visited = new Set<ts.Symbol>();
  const queue: Array<{ sym: ts.Symbol; anchor: ts.CallExpression; child?: ts.Symbol; level: number }> = [];
  const receiver = rootSymbol(m.checker, reg.receiver);
  if (receiver !== undefined) queue.push({ sym: receiver, anchor: reg.call, level: 0 });
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    const { sym, anchor } = item;
    const out = (levels[item.level] ??= []);
    if (visited.has(sym)) continue;
    visited.add(sym);
    const factory = factoryOf(m.checker, sym);
    const owners = factory !== undefined ? [sym, factory] : [sym];
    for (const u of m.uses) {
      if (u.owner === undefined || !owners.includes(u.owner)) continue;
      if (u.paths === null) continue;
      const sameFile = u.call.getSourceFile() === anchor.getSourceFile();
      if (sameFile && u.call.getStart() > anchor.getStart()) continue;
      const ownerPrefixes = prefixesOf(m, mounts, u.owner).values;
      if (u.paths !== undefined && !u.paths.some((p) => ownerPrefixes.some((op) => pathCovers(joinPaths(op, p), fullPath)))) continue;
      for (const arg of u.args) {
        // The mount through which the route is reached: only the arguments before the child run first.
        if (u.call === anchor && item.child !== undefined) {
          const childSym = rootSymbol(m.checker, arg);
          if (childSym === item.child || (childSym !== undefined && factoryOf(m.checker, item.child) === childSym)) break;
        }
        if (u.call === anchor && item.child === undefined) continue;
        out.push(arg);
      }
    }
    for (const mount of mounts) {
      if ((mount.child === sym || mount.child === factory) && mount.parent !== undefined && !isDeadRouter(m, mount.parent)) {
        queue.push({ sym: mount.parent, anchor: mount.call, child: mount.child, level: item.level + 1 });
      }
    }
  }
  return levels.reverse().flat();
}

// ───────────────────────────── extraction ─────────────────────────────

function asMethod(name: string): HttpMethod | undefined {
  return (HTTP_METHODS as readonly string[]).includes(name) ? (name as HttpMethod) : undefined;
}

interface Registration {
  call: ts.CallExpression;
  method: HttpMethod;
  /** The constant path(s) (an array of paths registers each); undefined: not a constant. */
  paths: string[] | undefined;
  pathNode: ts.Expression;
  receiver: ts.Expression;
  /** Handlers, preceded by middleware from `.all(...)` earlier in a `route()` chain. */
  handlerArgs: ts.Expression[];
}

/** A route path argument: one constant, or an array of constants (Express accepts both). */
function routePaths(checker: ts.TypeChecker, arg: ts.Expression): string[] | undefined {
  const e = unwrap(arg);
  if (ts.isArrayLiteralExpression(e)) return pathValues(checker, e) ?? undefined;
  const v = constString(checker, e);
  return v === undefined ? undefined : [v];
}

function isCallable(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  return checker.getTypeAtLocation(expr).getCallSignatures().length > 0 || resolveFunction(checker, expr) !== undefined;
}

/**
 * `app[verb](path, ...handlers)` on an Express receiver where `verb` is not a constant (routes registered
 * from a table in a loop): the method, path and chain cannot be known statically.
 */
function dynamicRegistration(checker: ts.TypeChecker, call: ts.CallExpression): ts.Expression | undefined {
  const callee = call.expression;
  if (!ts.isElementAccessExpression(callee) || call.arguments.length < 2) return undefined;
  const first = call.arguments[0];
  if (first === undefined || isCallable(checker, first) || !isExpressReceiver(checker, callee.expression)) return undefined;
  const key = constString(checker, callee.argumentExpression);
  return key === undefined ? callee.argumentExpression : undefined;
}

function registrationOf(checker: ts.TypeChecker, call: ts.CallExpression): Registration | undefined {
  const callee = call.expression;
  // `router.get(…)` or `router['get'](…)` / `router[VERB](…)` with a constant verb.
  const named = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? constString(checker, callee.argumentExpression) : undefined;
  if (named === undefined || !(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) return undefined;
  const method = asMethod(named);
  if (method === undefined) return undefined;
  const first = call.arguments[0];
  if (first !== undefined && call.arguments.length >= 2 && isExpressReceiver(checker, callee.expression) && !isCallable(checker, first)) {
    return { call, method, paths: routePaths(checker, first), pathNode: first, receiver: callee.expression, handlerArgs: call.arguments.slice(1) };
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  // router.route('/x').get(h).all(mw).post(h): `.all(mw)` before a method runs first for it.
  let base: ts.Expression = callee.expression;
  const before: ts.Expression[] = [];
  while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && (asMethod(base.expression.name.text) !== undefined || base.expression.name.text === 'all')) {
    if (base.expression.name.text === 'all') before.unshift(...base.arguments);
    base = base.expression.expression;
  }
  if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === 'route') {
    const routeArg = base.arguments[0];
    if (routeArg !== undefined && call.arguments.length >= 1 && isExpressReceiver(checker, base.expression.expression)) {
      return { call, method, paths: routePaths(checker, routeArg), pathNode: routeArg, receiver: base.expression.expression, handlerArgs: [...before, ...call.arguments] };
    }
  }
  return undefined;
}

export interface RouteTable {
  /** Every route, including those whose path could not be resolved (`unresolvedPath` set). */
  all: RouteInfo[];
  /** Routes with a fully resolved path. */
  routes: RouteInfo[];
  /** Routes whose path (or a mount prefix on the way up) could not be resolved statically. */
  unresolved: RouteInfo[];
  /** Registrations with a computed method (`router[verb](…)`): nothing about them can be proven statically. */
  dynamic: Array<{ file: string; call: ts.CallExpression; method: ts.Expression }>;
}

const TABLES = new WeakMap<ApiModel, RouteTable>();

/** Every route registration of the API, with its chain analysed. Cached per program. */
export function extractRouteTable(program: ts.Program, root: string, files: string[]): RouteTable {
  const m = apiModel(program, root, files);
  const cached = TABLES.get(m);
  if (cached !== undefined) return cached;
  const { checker } = m;
  const mounts = mountsOf(m);
  const memberFacts = new Map<ts.Node, FnFacts | null>();
  const factsOfMember = (expr: ts.Expression): FnFacts | null => {
    const hit = memberFacts.get(expr);
    if (hit !== undefined) return hit;
    const c = resolveCallable(m, expr, NO_ENV);
    // Error middleware (err, req, res, next) is not part of the request chain.
    const f = c !== undefined && c.fn.parameters.length < 4 && isProgramNode(c.fn) ? analyseFunction(m, c.fn, c.env, 0, -1) : null;
    memberFacts.set(expr, f);
    return f;
  };
  const all: RouteInfo[] = [];
  const dynamic: RouteTable['dynamic'] = [];
  for (const { rel, sf } of m.sources) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const computed = dynamicRegistration(checker, node);
      if (computed !== undefined) dynamic.push({ file: rel, call: node, method: computed });
      const reg = registrationOf(checker, node);
      if (reg === undefined) return;
      const args = flattenArgs(checker, reg.handlerArgs);
      const last = args[args.length - 1];
      const resolved = last !== undefined ? resolveCallable(m, last, NO_ENV) : undefined;
      const handler = resolved?.fn;
      const own = resolved !== undefined ? analyseFunction(m, resolved.fn, resolved.env, 0, 1) : emptyFacts();
      const calleeProblemSites = handler !== undefined ? calleeProblems(m, handler) : [];
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const targets: Array<{ path: string; unresolvedPath?: RouteInfo['unresolvedPath'] }> = [];
      if (reg.paths === undefined) {
        targets.push({ path: `<${reg.pathNode.getText()}>`, unresolvedPath: { node: reg.pathNode, reason: `route path ${reg.pathNode.getText()} is not a constant string` } });
      } else {
        const prefixes = prefixesOf(m, mounts, rootSymbol(checker, reg.receiver));
        for (const path of reg.paths) {
          for (const p of prefixes.values) targets.push({ path: joinPaths(p, path) });
          if (prefixes.unresolved !== undefined) {
            const text = prefixes.unresolved.getText();
            targets.push({ path: `<${text}>${path}`, unresolvedPath: { node: prefixes.unresolved, reason: `mount prefix ${text} is not a constant string` } });
          }
        }
      }
      for (const t of targets) {
        const scope = scopeMiddlewareFor(m, mounts, reg, t.path);
        const chain = [...scope, ...args.slice(0, -1)].map(factsOfMember).filter((f): f is FnFacts => f !== null);
        all.push({
          file: rel,
          method: reg.method,
          path: t.path,
          line: lc.line + 1,
          column: lc.character + 1,
          registration: node,
          handler,
          middleware: reg.handlerArgs.slice(0, -1),
          reqName: handler !== undefined ? paramName(handler, 0) : undefined,
          resName: handler !== undefined ? paramName(handler, 1) : undefined,
          ...combineChain(chain, own),
          calleeProblemSites,
          scopeMiddleware: scope,
          ...(t.unresolvedPath !== undefined ? { unresolvedPath: t.unresolvedPath } : {}),
        });
      }
    });
  }
  const table: RouteTable = { all, routes: all.filter((r) => r.unresolvedPath === undefined), unresolved: all.filter((r) => r.unresolvedPath !== undefined), dynamic };
  TABLES.set(m, table);
  return table;
}

/**
 * Merge a route's middleware chain with its handler: parses anywhere in the chain count for the route
 * (handler parses first); a raw read is covered only when an earlier function wrote the parsed value back.
 */
function combineChain(chain: FnFacts[], handler: FnFacts): Pick<RouteInfo, 'parses' | 'unparsedReads' | 'responses' | 'statusLiterals' | 'problemSites' | 'resEscapes' | 'readsIdempotencyKey'> {
  const written = new Set<string>();
  const unparsedReads: RouteInfo['unparsedReads'] = [];
  for (const f of [...chain, handler]) {
    for (const r of f.reads) if (!written.has(r.target)) unparsedReads.push({ target: r.target, node: r.node });
    for (const w of f.writeBacks) written.add(w.target);
  }
  return {
    parses: [...handler.parses, ...chain.flatMap((f) => f.parses)],
    unparsedReads,
    responses: handler.responses,
    statusLiterals: handler.statusLiterals,
    problemSites: handler.problemSites,
    resEscapes: handler.resEscapes,
    readsIdempotencyKey: handler.idempotencyKey || chain.some((f) => f.idempotencyKey),
  };
}

/** Why a route registered with a computed method (`router[verb](…)`) is UNPROVEN, with its location. */
export function dynamicRouteReason(root: string, d: RouteTable['dynamic'][number]): string {
  return `${location(root, d.call)}: route registered with a computed method (${d.method.getText()}), so its method, path and handler chain are unproven; register it with a constant method and path`;
}

/** Routes with a resolved path (see extractRouteTable for the unresolved ones). */
export function extractRoutes(program: ts.Program, root: string, files: string[]): RouteInfo[] {
  return extractRouteTable(program, root, files).routes;
}

/** Sort key helpers for deterministic output. */
export function routeLabel(r: Pick<RouteInfo, 'method' | 'path'>): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

/** Whether a route path ends in a static (collection) segment. */
export function isCollectionPath(path: string): boolean {
  const segs = path.split('/').filter((s) => s !== '');
  const last = segs[segs.length - 1];
  return last !== undefined && !last.startsWith(':') && !/^v\d+$/.test(last);
}

export function hasPathParams(path: string): boolean {
  return path.split('/').some((s) => s.startsWith(':'));
}

/** Property type of `name` on `type`, or undefined when absent. */
export function propertyType(checker: ts.TypeChecker, type: ts.Type, name: string, at: ts.Node): ts.Type | undefined {
  const sym = checker.getApparentType(type).getProperty(name);
  return sym === undefined ? undefined : checker.getTypeOfSymbolAtLocation(sym, at);
}

/** A function registered with `<x>.use(...)`. */
export interface UseRegistration {
  call: ts.CallExpression;
  /** The first resolved path prefix; undefined for a path-less registration. */
  path: string | undefined;
  /** Resolved body (factories such as `errorHandler()` are followed), when it is program code. */
  fn: ts.FunctionLikeDeclaration | undefined;
  env: Env;
  arg: ts.Expression;
  /** Parameter count, from the body or (for library middleware) the call signature of its type. */
  params: number | undefined;
}

/** The program's SourceFile for an API-relative path. */
export function programFile(program: ts.Program, root: string, rel: string): ts.SourceFile | undefined {
  return program.getSourceFile(resolve(root, rel)) ?? program.getSourceFile(toPosix(resolve(root, rel)));
}

function useRegistrationsOf(m: ApiModel): UseRegistration[] {
  const out: UseRegistration[] = [];
  for (const u of m.uses) {
    for (const arg of u.args) {
      const c = resolveCallable(m, arg, NO_ENV);
      const fn = c !== undefined && isProgramNode(c.fn) ? c.fn : undefined;
      const sigs = m.checker.getTypeAtLocation(arg).getCallSignatures();
      const params = fn !== undefined ? fn.parameters.length : sigs.length > 0 ? Math.max(...sigs.map((s) => s.parameters.length)) : undefined;
      const path = u.paths === undefined ? undefined : (u.paths?.[0] ?? '<unresolved>');
      out.push({ call: u.call, path, fn, env: c?.env ?? NO_ENV, arg, params });
    }
  }
  return out;
}

export function useRegistrations(program: ts.Program, root: string, files: string[]): UseRegistration[] {
  return useRegistrationsOf(apiModel(program, root, files));
}

export { walk };
