/**
 * Shared Express route extraction for the standards checks and the contract lock.
 *
 * A route is `<x>.<get|post|put|patch|delete>(<path literal>, ...middleware, handler)`
 * (or `<x>.route(<path literal>).<method>(...handlers)`) where `<x>` is an Express
 * app/Router according to the type checker (falling back to conventional names
 * when express types are unavailable). Mount prefixes from `x.use('/prefix', router)`
 * are applied when they are statically determinable.
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
}
export interface ParseSite {
  target: 'params' | 'query' | 'body' | 'headers';
  call: ts.CallExpression;
  schema: SchemaRef;
}
export interface ResponseSite {
  call: ts.CallExpression;
  status: number | null;
  hasBody: boolean;
  schema?: SchemaRef;
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
  parses: ParseSite[];
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
}

/** Problem helper names and the status they produce. */
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
  const sym = resolveSymbol(checker, id);
  const decl = sym?.valueDeclaration;
  if (decl !== undefined && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && isConstDeclaration(decl)) {
    return decl.initializer;
  }
  return undefined;
}

/** A numeric literal, or a const identifier initialised with one. */
export function numericValue(checker: ts.TypeChecker, expr: ts.Expression | undefined): number | null {
  if (expr === undefined) return null;
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isIdentifier(e)) {
    const init = constInitializer(checker, e);
    if (init !== undefined && ts.isNumericLiteral(unwrap(init))) return Number(unwrap(init).getText());
  }
  return null;
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

const MAX_HANDLER_DEPTH = 3;

/**
 * Route handler: like resolveFunction, plus
 *  - one level of wrapper whose last argument is the function (`asyncHandler(async (req, res) => …)`),
 *  - `fn.bind(thisArg)`,
 *  - a handler factory call (`getUser(service)`) whose returned expression is itself a handler.
 */
function resolveHandler(checker: ts.TypeChecker, expr: ts.Expression, depth = 0): ts.FunctionLikeDeclaration | undefined {
  const direct = resolveFunction(checker, expr);
  if (direct !== undefined) return direct;
  const e = unwrap(expr);
  if (!ts.isCallExpression(e) || depth >= MAX_HANDLER_DEPTH) return undefined;
  const callee = unwrap(e.expression);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return resolveHandler(checker, callee.expression, depth + 1);
  const last = e.arguments[e.arguments.length - 1];
  const wrapped = last !== undefined ? resolveFunction(checker, last) : undefined;
  if (wrapped !== undefined && wrapped.parameters.length >= 2) return wrapped;
  const factory = resolveFunction(checker, callee);
  if (factory === undefined) return wrapped;
  for (const ret of returnedExpressions(factory)) {
    const h = resolveHandler(checker, ret, depth + 1);
    if (h !== undefined) return h;
  }
  return wrapped;
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

/** If `call` is `<zod schema>.<parse method>(…)`, its SchemaRef. */
export function parseCallSchema(
  checker: ts.TypeChecker,
  root: string,
  call: ts.CallExpression,
  methods: ReadonlySet<string> = PARSE_METHODS,
): SchemaRef | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !methods.has(callee.name.text)) return undefined;
  const schemaExpr = callee.expression;
  if (!isZodSchemaType(checker, checker.getTypeAtLocation(schemaExpr))) return undefined;
  const ref: SchemaRef = { expr: schemaExpr, text: schemaExpr.getText(), ...schemaOrigin(checker, root, schemaExpr) };
  const parsedType = parsedTypeOf(checker, call, callee.name.text);
  if (parsedType !== undefined) ref.parsedType = parsedType;
  return ref;
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

// ───────────────────────────── problems ─────────────────────────────

/** Name of a call/new that produces a problem (helper, `problem(…)`, `new HttpProblem(…)`, `ProblemSchema.parse(…)`). */
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

/**
 * Type-aware problemProducerName: the call must also yield an object (so `problemType(slug)`
 * returning a string, or `sendProblem(res, p)` returning void, are not producers).
 */
export function problemProducer(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  const name = problemProducerName(node);
  if (name === undefined) {
    // `new UserNotFoundError(id)` where the class is problem-shaped (e.g. extends HttpProblem).
    if (!ts.isNewExpression(node)) return undefined;
    const ctor = calleeName(node.expression);
    return ctor !== undefined && isProblemShaped(checker, checker.getTypeAtLocation(node)) ? ctor : undefined;
  }
  const t = checker.getTypeAtLocation(node);
  if (t.flags & ts.TypeFlags.Any) return name; // unresolved types: trust the name
  const parts = t.isUnion() ? t.types : [t];
  return parts.some((p) => (p.flags & PRIMITIVE) === 0) ? name : undefined;
}

/** A type with `type`, `title` and `status` members (an HttpProblem, its subclasses, a Problem object). */
export function isProblemShaped(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const t = checker.getApparentType(type);
  return ['type', 'title', 'status'].every((k) => t.getProperty(k) !== undefined);
}

/** The `super(...)` call in the constructor of the class a `new X(...)` instantiates. */
function superCallOf(checker: ts.TypeChecker, node: ts.NewExpression): ts.CallExpression | undefined {
  const sym = resolveSymbol(checker, node.expression);
  const decl = sym?.valueDeclaration;
  if (decl === undefined || !ts.isClassDeclaration(decl)) return undefined;
  for (const member of decl.members) {
    if (!ts.isConstructorDeclaration(member) || member.body === undefined) continue;
    let found: ts.CallExpression | undefined;
    walk(member.body, (n) => {
      if (found === undefined && ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) found = n;
    });
    return found;
  }
  return undefined;
}

/**
 * Status a problem producer creates: helper table, numeric literal argument, `{ status: n }` argument,
 * or (for `new SubclassOfHttpProblem(...)`) the status its constructor passes to super(...).
 */
export function problemStatus(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression, name: string): number | null {
  const fixed = PROBLEM_HELPERS[name];
  if (fixed !== undefined) return fixed;
  const own = literalStatus(checker, node);
  if (own !== null || !ts.isNewExpression(node)) return own;
  const sup = superCallOf(checker, node);
  return sup !== undefined ? literalStatus(checker, sup) : null;
}

function literalStatus(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression): number | null {
  for (const arg of node.arguments ?? []) {
    const n = numericValue(checker, arg);
    if (n !== null) return n;
    const a = unwrap(arg);
    if (ts.isObjectLiteralExpression(a)) {
      for (const p of a.properties) {
        if (ts.isPropertyAssignment(p) && propName(p.name) === 'status') {
          const v = numericValue(checker, p.initializer);
          if (v !== null) return v;
        }
      }
    }
  }
  return null;
}

export function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** Whether a body expression is produced by a problem helper (directly or via a const). */
function isProblemBody(checker: ts.TypeChecker, body: ts.Expression): boolean {
  let e = unwrap(body);
  if (ts.isIdentifier(e)) {
    const init = constInitializer(checker, e);
    if (init === undefined) return false;
    e = unwrap(init);
  }
  return problemProducer(checker, e) !== undefined;
}

// ───────────────────────────── response chains ─────────────────────────────

export interface ResponseChain {
  call: ts.CallExpression;
  method: string;
  /** Root expression of the chain (e.g. the `res` identifier). */
  root: ts.Expression;
  status: number | null;
  /** Whether a .status()/.sendStatus() appeared in the chain at all. */
  statusSet: boolean;
  statusNodes: Array<{ status: number; node: ts.Node }>;
  body: ts.Expression | undefined;
}

/** Decompose `x.status(n).location(u).json(body)` style calls. */
export function responseChain(checker: ts.TypeChecker, call: ts.CallExpression): ResponseChain | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !RESPONSE_METHODS.has(callee.name.text)) return undefined;
  const method = callee.name.text;
  let status: number | null = method === 'sendStatus' ? numericValue(checker, call.arguments[0]) : 200;
  let statusSet = method === 'sendStatus';
  const statusNodes: Array<{ status: number; node: ts.Node }> = [];
  if (method === 'sendStatus' && status !== null) statusNodes.push({ status, node: call });
  let cur: ts.Expression = callee.expression;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const name = cur.expression.name.text;
    if (name === 'status' && !statusSet) {
      statusSet = true;
      status = numericValue(checker, cur.arguments[0]);
      if (status !== null) statusNodes.push({ status, node: cur });
    }
    cur = cur.expression.expression;
  }
  const body = method === 'sendStatus' ? undefined : call.arguments[0];
  return { call, method, root: cur, status, statusSet, statusNodes, body };
}

// ───────────────────────────── handler analysis ─────────────────────────────

interface HandlerFacts {
  parses: ParseSite[];
  unparsedReads: Array<{ target: string; node: ts.Node }>;
  responses: ResponseSite[];
  statusLiterals: Array<{ status: number; node: ts.Node }>;
  problemSites: Array<{ name: string; status: number | null; node: ts.Node }>;
  resEscapes: ts.Node[];
}

function emptyFacts(): HandlerFacts {
  return { parses: [], unparsedReads: [], responses: [], statusLiterals: [], problemSites: [], resEscapes: [] };
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

function reqRead(id: ts.Identifier): { target: string; node: ts.Node } {
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
    const key = stringLiteralValue(parent.argumentExpression);
    if (key !== undefined && !REQ_TARGETS.has(key) && !REQ_RAW_INPUTS.has(key)) return { target: '', node: parent };
    return { target: key ?? 'req[…]', node: parent };
  }
  // Bare use (destructuring, aliasing, passing req along): unverifiable.
  return { target: 'req', node: id };
}

function analyseHandler(checker: ts.TypeChecker, root: string, fn: ts.FunctionLikeDeclaration): HandlerFacts {
  const facts = emptyFacts();
  const body = fn.body;
  if (body === undefined) return facts;
  const reqSym = paramSymbol(checker, fn, 0);
  const resSym = paramSymbol(checker, fn, 1);
  const isSym = (n: ts.Node, s: ts.Symbol | undefined): boolean => s !== undefined && ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === s;

  walk(body, (node) => {
    if (isSym(node, reqSym) && ts.isIdentifier(node)) {
      const read = reqRead(node);
      if (read.target === '') return;
      // `IdSchema.parse(req.params.userId)` parses one field of the input: the argument is the member read.
      let arg: ts.Node = read.node;
      const up = arg.parent;
      if (REQ_TARGETS.has(read.target) && (ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up)) && up.expression === arg) arg = up;
      const parent = arg.parent;
      const schema = ts.isCallExpression(parent) && parent.arguments[0] === arg ? parseCallSchema(checker, root, parent) : undefined;
      if (schema !== undefined && ts.isCallExpression(parent)) {
        if (read.target === 'params' || read.target === 'query' || read.target === 'body' || read.target === 'headers') {
          facts.parses.push({ target: read.target, call: parent, schema });
        }
      } else {
        facts.unparsedReads.push(read);
      }
      return;
    }
    if (isSym(node, resSym) && ts.isIdentifier(node)) {
      if (isResEscape(node)) facts.resEscapes.push(node);
      return;
    }
    if (ts.isCallExpression(node)) {
      const chain = responseChain(checker, node);
      if (chain !== undefined && isSym(unwrap(chain.root), resSym)) {
        const site: ResponseSite = {
          call: node,
          status: chain.status,
          hasBody: chain.body !== undefined,
          isProblem: chain.body !== undefined && isProblemBody(checker, chain.body),
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
        const n = numericValue(checker, node.arguments[0]);
        if (isSym(unwrap(r), resSym) && n !== null) facts.statusLiterals.push({ status: n, node });
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = problemProducer(checker, node);
      if (name !== undefined) {
        const status = problemStatus(checker, node, name);
        facts.problemSites.push({ name, status, node });
        if (status !== null) facts.statusLiterals.push({ status, node });
      }
    }
  });
  return facts;
}

/** Problem producers in the functions `fn` calls (transitively, program sources only, excluding `fn` itself). */
function calleeProblems(checker: ts.TypeChecker, fn: ts.FunctionLikeDeclaration): HandlerFacts['problemSites'] {
  const out: HandlerFacts['problemSites'] = [];
  const seen = new Set<ts.Node>([fn]);
  let frontier: ts.FunctionLikeDeclaration[] = [fn];
  for (let depth = 0; depth < MAX_HANDLER_DEPTH && frontier.length > 0; depth++) {
    const next: ts.FunctionLikeDeclaration[] = [];
    for (const f of frontier) {
      if (f.body === undefined) continue;
      walk(f.body, (n) => {
        if (!ts.isCallExpression(n)) return;
        const target = resolveFunction(checker, n.expression);
        if (target === undefined || seen.has(target)) return;
        seen.add(target);
        next.push(target);
        if (target.body === undefined) return;
        walk(target.body, (m) => {
          if (!ts.isCallExpression(m) && !ts.isNewExpression(m)) return;
          const name = problemProducer(checker, m);
          if (name !== undefined) out.push({ name, status: problemStatus(checker, m, name), node: m });
        });
      });
    }
    frontier = next;
  }
  return out;
}

// ───────────────────────────── mount prefixes ─────────────────────────────

interface Mount {
  child: ts.Symbol;
  parent: ts.Symbol | undefined;
  prefix: string;
}

function rootSymbol(checker: ts.TypeChecker, expr: ts.Expression): ts.Symbol | undefined {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return resolveSymbol(checker, e);
  if (ts.isCallExpression(e)) {
    // `createUsersRouter()` → the function symbol stands for its router.
    return resolveSymbol(checker, ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression);
  }
  return undefined;
}

function collectMounts(checker: ts.TypeChecker, sources: ts.SourceFile[]): Mount[] {
  const mounts: Mount[] = [];
  for (const sf of sources) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== 'use') return;
      const prefix = stringLiteralValue(node.arguments[0]);
      if (prefix === undefined || !isExpressReceiver(checker, node.expression.expression)) return;
      const parent = rootSymbol(checker, node.expression.expression);
      for (const arg of node.arguments.slice(1)) {
        const child = rootSymbol(checker, arg);
        if (child !== undefined) mounts.push({ child, parent, prefix });
      }
    });
  }
  return mounts;
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

function prefixOf(checker: ts.TypeChecker, mounts: Mount[], sym: ts.Symbol | undefined, seen: Set<ts.Symbol> = new Set()): string {
  if (sym === undefined || seen.has(sym)) return '';
  seen.add(sym);
  const ids = [sym];
  const factory = factoryOf(checker, sym);
  if (factory !== undefined) ids.push(factory);
  const own = mounts.filter((m) => ids.includes(m.child));
  const candidates = new Set(own.map((m) => joinPaths(prefixOf(checker, mounts, m.parent, new Set(seen)), m.prefix)));
  if (candidates.size !== 1) return ''; // not mounted under a path, or ambiguous: use paths as written
  const [only] = [...candidates];
  return only ?? '';
}

/** A `<x>.use([path,] ...fns)` registration: middleware that applies to the routes of `owner` and its sub-routers. */
interface ScopeUse {
  owner: ts.Symbol | undefined;
  path: string | undefined;
  arg: ts.Expression;
  call: ts.CallExpression;
}

function collectScopeUses(checker: ts.TypeChecker, sources: ts.SourceFile[]): { uses: ScopeUse[]; links: Mount[] } {
  const uses: ScopeUse[] = [];
  const links: Mount[] = [];
  for (const sf of sources) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== 'use' || !isExpressReceiver(checker, node.expression.expression)) return;
      const path = stringLiteralValue(node.arguments[0]);
      const owner = rootSymbol(checker, node.expression.expression);
      for (const arg of node.arguments.slice(path === undefined ? 0 : 1)) {
        uses.push({ owner, path, arg, call: node });
        const child = rootSymbol(checker, arg);
        if (child !== undefined) links.push({ child, parent: owner, prefix: path ?? '' });
      }
    });
  }
  return { uses, links };
}

/** `sym` (plus its factory) and every router/app it is mounted on, transitively. */
function ancestorSymbols(checker: ts.TypeChecker, links: Mount[], sym: ts.Symbol | undefined): Set<ts.Symbol> {
  const out = new Set<ts.Symbol>();
  const queue = sym !== undefined ? [sym] : [];
  for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
    if (out.has(s)) continue;
    out.add(s);
    const factory = factoryOf(checker, s);
    if (factory !== undefined && !out.has(factory)) {
      out.add(factory);
    }
    for (const l of links) {
      if ((l.child === s || l.child === factory) && l.parent !== undefined) queue.push(l.parent);
    }
  }
  return out;
}

/** Middleware registered with `.use()` on the route's router (before the route) or on a router/app it is mounted on. */
function scopeMiddlewareFor(
  checker: ts.TypeChecker,
  scope: { uses: ScopeUse[]; links: Mount[] },
  reg: Registration,
  fullPath: string,
): ts.Expression[] {
  const receiver = rootSymbol(checker, reg.receiver);
  const owners = ancestorSymbols(checker, scope.links, receiver);
  const regFile = reg.call.getSourceFile();
  return scope.uses
    .filter((u) => u.owner !== undefined && owners.has(u.owner))
    .filter((u) => u.path === undefined || fullPath.includes(u.path.replace(/\/+$/, '')))
    .filter((u) => !(u.owner === receiver && u.call.getSourceFile() === regFile && u.call.getStart() > reg.call.getStart()))
    .map((u) => u.arg);
}

// ───────────────────────────── extraction ─────────────────────────────

function asMethod(name: string): HttpMethod | undefined {
  return (HTTP_METHODS as readonly string[]).includes(name) ? (name as HttpMethod) : undefined;
}

interface Registration {
  call: ts.CallExpression;
  method: HttpMethod;
  path: string;
  receiver: ts.Expression;
  handlerArgs: ts.Expression[];
}

function registrationOf(checker: ts.TypeChecker, call: ts.CallExpression): Registration | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = asMethod(callee.name.text);
  if (method === undefined) return undefined;
  const path = stringLiteralValue(call.arguments[0]);
  if (path !== undefined && call.arguments.length >= 2 && isExpressReceiver(checker, callee.expression)) {
    return { call, method, path, receiver: callee.expression, handlerArgs: call.arguments.slice(1) };
  }
  // router.route('/x').get(h).post(h)
  let base: ts.Expression = callee.expression;
  while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && asMethod(base.expression.name.text) !== undefined) {
    base = base.expression.expression;
  }
  if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === 'route') {
    const routePath = stringLiteralValue(base.arguments[0]);
    if (routePath !== undefined && call.arguments.length >= 1 && isExpressReceiver(checker, base.expression.expression)) {
      return { call, method, path: routePath, receiver: base.expression.expression, handlerArgs: [...call.arguments] };
    }
  }
  return undefined;
}

export function extractRoutes(program: ts.Program, root: string, files: string[]): RouteInfo[] {
  const checker = program.getTypeChecker();
  const sources: Array<{ rel: string; sf: ts.SourceFile }> = [];
  for (const rel of files) {
    const sf = programFile(program, root, rel);
    if (sf !== undefined) sources.push({ rel: toPosix(rel), sf });
  }
  const mounts = collectMounts(checker, sources.map((s) => s.sf));
  const scope = collectScopeUses(checker, sources.map((s) => s.sf));
  const routes: RouteInfo[] = [];
  for (const { rel, sf } of sources) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const reg = registrationOf(checker, node);
      if (reg === undefined) return;
      const prefix = prefixOf(checker, mounts, rootSymbol(checker, reg.receiver));
      const last = reg.handlerArgs[reg.handlerArgs.length - 1];
      const handler = last !== undefined ? resolveHandler(checker, last) : undefined;
      const facts = handler !== undefined ? analyseHandler(checker, root, handler) : emptyFacts();
      const calleeProblemSites = handler !== undefined ? calleeProblems(checker, handler) : [];
      const path = joinPaths(prefix, reg.path);
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      routes.push({
        file: rel,
        method: reg.method,
        path,
        line: lc.line + 1,
        column: lc.character + 1,
        registration: node,
        handler,
        middleware: reg.handlerArgs.slice(0, -1),
        reqName: handler !== undefined ? paramName(handler, 0) : undefined,
        resName: handler !== undefined ? paramName(handler, 1) : undefined,
        ...facts,
        calleeProblemSites,
        scopeMiddleware: scopeMiddlewareFor(checker, scope, reg, path),
      });
    });
  }
  return routes;
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

/** Every function-like node reachable as a registered middleware: `<x>.use(...fns)`. */
export interface UseRegistration {
  call: ts.CallExpression;
  path: string | undefined;
  fn: ts.FunctionLikeDeclaration | undefined;
  arg: ts.Expression;
}

/** The program's SourceFile for an API-relative path. */
export function programFile(program: ts.Program, root: string, rel: string): ts.SourceFile | undefined {
  return program.getSourceFile(resolve(root, rel)) ?? program.getSourceFile(toPosix(resolve(root, rel)));
}

export function useRegistrations(program: ts.Program, root: string, files: string[]): UseRegistration[] {
  const checker = program.getTypeChecker();
  const out: UseRegistration[] = [];
  for (const rel of files) {
    const sf = programFile(program, root, rel);
    if (sf === undefined) continue;
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== 'use' || !isExpressReceiver(checker, node.expression.expression)) return;
      const path = stringLiteralValue(node.arguments[0]);
      for (const arg of node.arguments.slice(path === undefined ? 0 : 1)) {
        const e = unwrap(arg);
        // Direct functions/identifiers only: `x.use(express.json())` is a factory call, not a handler.
        const fn = ts.isCallExpression(e) ? undefined : resolveFunction(checker, e);
        out.push({ call: node, path, fn, arg });
      }
    });
  }
  return out;
}

export { walk };
