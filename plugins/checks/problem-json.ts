/**
 * problem-json: every error leaves the API as RFC 9457 application/problem+json.
 * Static: no ad-hoc error bodies, error (or non-constant) statuses only with full problem
 * bodies, problem producers judged by behaviour (an error class the error middleware turns
 * into a problem, or an object with the problem members), an error middleware and a final
 * not-found handler are registered (recognised by type and behaviour, factories included).
 * Runtime: probes against the API's app, wherever it lives (UNPROVEN if none starts).
 */
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import {
  PROBLEM_MEMBERS,
  apiModel,
  calleeName,
  constInitializer,
  constString,
  extractRouteTable,
  isProblemDocument,
  isProblemShaped,
  isReplay,
  location,
  missingMembers,
  numericValue,
  problemProducer,
  problemStatus,
  propName,
  responseChain,
  unwrap,
  useRegistrations,
  walk,
} from '../lib/api-ast.ts';
import type { ApiModel, Env, Producer, ResponseChain, RouteInfo, UseRegistration } from '../lib/api-ast.ts';
import { discoverEntries } from '../lib/app-entry.ts';
import { runProbe, substituteParams } from '../lib/probe.ts';

const RULE = 'problem-json';
const ADHOC_KEYS = new Set(['error', 'errors', 'message']);
const REQUIRED = ['type', 'title', 'status'] as const;

const DOC = `problem-json (unit: error paths)
Every error response is RFC 9457 application/problem+json: { type, title, status, detail, instance }.
Static rules (per src file):
- Never send ad-hoc error bodies (object literals with error / errors / message keys).
- A response whose status is >= 400, or not a constant (res.status(code) with code: number), is an error path:
  its body must be a full problem (a value typed with all five members, or a five-key literal sent with
  .type('application/problem+json')). Replaying a recorded response (res.status(r.status).json(r.body)) is exempt.
  Prefer: throw notFound(detail) / new HttpProblem({...}) and let the error middleware send it.
- Problem producers: an error class the error middleware tests with instanceof (and its subclasses) is a
  problem; any other producer yields type, title, status (an Error) or all five members (a plain object).
- Handlers never throw / next() a non-problem error (new Error('not found') becomes a 500).
- The app registers an error-handling middleware (4 parameters, by type; factories followed) and a final
  not-found handler (a path-less 2-3 parameter middleware that produces a 404).
Runtime: the harness finds the app (an exported factory such as createApp/buildApp, an exported or default
app, or a server the entry file starts with listen(); in src/{app,index,server,main}.ts or what package.json
main/start names) and probes it; POST/PUT/PATCH probes carry an Idempotency-Key. Each response must have
Content-Type application/problem+json and a body with string type/title/detail/instance and integer status
equal to the HTTP status:
  GET <base>/__harness_probe__/does-not-exist -> 404; POST/PUT/PATCH malformed JSON -> 400, invalid body -> 422;
  POST to a collection without Idempotency-Key -> 400/422/428; GET/PATCH/DELETE on :param routes with an
  unknown uuid -> 404 (422 accepted); a route that throws a plain Error -> 500 problem without the error
  message or stack; collection GET -> 200 JSON that is NOT a problem.
  No app found or it cannot start -> UNPROVEN; a non-Express app the throwing route cannot be injected into
  leaves the 500 probe UNPROVEN.
Passing example:
  usersRouter.get('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const user = store.get(userId);
    if (user === undefined) throw notFound(\`user \${userId} not found\`);
    res.json(UserSchema.parse(user));
  });
  // app.ts: app.use(notFoundHandler); app.use(errorHandler);  // errorHandler -> sendProblem(res, problem)`;

interface Tally {
  passed: number;
  total: number;
  violations: Violation[];
}

function tally(map: Map<string, Tally>, file: string): Tally {
  let t = map.get(file);
  if (t === undefined) {
    t = { passed: 0, total: 0, violations: [] };
    map.set(file, t);
  }
  return t;
}

function unit(t: Tally, ok: boolean, v: Violation): void {
  t.total++;
  if (ok) t.passed++;
  else t.violations.push(v);
}

function adhocKeys(checker: ts.TypeChecker, body: ts.Expression | undefined): string[] {
  if (body === undefined) return [];
  let e = unwrap(body);
  if (ts.isIdentifier(e)) {
    const init = constInitializer(checker, e);
    if (init === undefined) return [];
    e = unwrap(init);
  }
  if (!ts.isObjectLiteralExpression(e)) return [];
  const keys: string[] = [];
  for (const p of e.properties) {
    const name = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? propName(p.name) : undefined;
    if (name !== undefined && ADHOC_KEYS.has(name)) keys.push(name);
  }
  return keys;
}

/** `e`, or the initializer of the const it names. */
function constValue(checker: ts.TypeChecker, expr: ts.Expression): ts.Expression | undefined {
  const e = unwrap(expr);
  if (!ts.isIdentifier(e)) return e;
  const init = constInitializer(checker, e);
  return init === undefined ? undefined : unwrap(init);
}

function mentionsProblemType(checker: ts.TypeChecker, arg: ts.Expression | undefined): boolean {
  const text = constString(checker, arg);
  return text !== undefined && /problem\+json/i.test(text);
}

/** `.type(problem+json)`, `.contentType(…)`, `.set/.header/.setHeader('Content-Type', problem+json)`. */
function setsProblemType(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const name = call.expression.name.text;
  const [a0, a1] = call.arguments;
  if ((name === 'type' || name === 'contentType') && mentionsProblemType(checker, a0)) return true;
  return (name === 'set' || name === 'header' || name === 'setHeader') && constString(checker, a0)?.toLowerCase() === 'content-type' && mentionsProblemType(checker, a1);
}

/**
 * Whether the response sets Content-Type application/problem+json: in the send chain itself, or in an
 * earlier statement on the same response in the same function (`res.setHeader('Content-Type', …); res.json(…)`).
 */
function chainSetsProblemType(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  let cur: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    if (ts.isCallExpression(cur) && setsProblemType(checker, cur)) return true;
    cur = cur.expression;
  }
  const root = unwrap(cur);
  const sym = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root) : undefined;
  let fn: ts.Node | undefined = call.parent;
  while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (sym === undefined || fn === undefined) return false;
  let found = false;
  walk(fn, (n) => {
    if (found || !ts.isCallExpression(n) || n.getStart() >= call.getStart() || !setsProblemType(checker, n)) return;
    let r: ts.Expression = n.expression;
    while (ts.isPropertyAccessExpression(r) || ts.isCallExpression(r)) r = r.expression;
    const rr = unwrap(r);
    found = ts.isIdentifier(rr) && checker.getSymbolAtLocation(rr) === sym;
  });
  return found;
}

/**
 * Members a sent error body lacks: an object literal needs all five problem keys and the problem content type;
 * any other value needs a type with all five members (required).
 */
function problemBodyGaps(checker: ts.TypeChecker, chain: ResponseChain): string[] {
  const body = chain.body;
  if (body === undefined) return ['a body'];
  const lit = constValue(checker, body);
  if (lit !== undefined && ts.isObjectLiteralExpression(lit) && !lit.properties.some(ts.isSpreadAssignment)) {
    const keys = new Set(lit.properties.map((p) => (p.name !== undefined ? propName(p.name) : undefined)));
    const gaps: string[] = PROBLEM_MEMBERS.filter((k) => !keys.has(k));
    if (!chainSetsProblemType(checker, chain.call)) gaps.push(".type('application/problem+json')");
    return gaps;
  }
  const typed = isProblemDocument(checker, checker.getTypeAtLocation(body), body);
  if (!typed) return missingMembers(checker, checker.getTypeAtLocation(body), body, PROBLEM_MEMBERS, true);
  return lit !== undefined && ts.isObjectLiteralExpression(lit) && !chainSetsProblemType(checker, chain.call) ? [".type('application/problem+json')"] : [];
}

/** Errors constructed by a handler that are not problems: `throw new Error(...)`, `next(new Error(...))`. */
function nonProblemErrors(m: ApiModel, fn: ts.FunctionLikeDeclaration): ts.NewExpression[] {
  const { checker } = m;
  const out: ts.NewExpression[] = [];
  if (fn.body === undefined) return out;
  const nextParam = fn.parameters[2];
  const nextName = nextParam !== undefined && ts.isIdentifier(nextParam.name) ? nextParam.name.text : undefined;
  walk(fn.body, (n) => {
    let created: ts.Expression | undefined;
    if (ts.isThrowStatement(n)) created = n.expression;
    else if (ts.isCallExpression(n) && nextName !== undefined && calleeName(n.expression) === nextName && ts.isIdentifier(n.expression)) created = n.arguments[0];
    const e = created !== undefined ? unwrap(created) : undefined;
    if (e === undefined || !ts.isNewExpression(e)) return;
    if (problemProducer(m, e) !== undefined || isProblemShaped(checker, checker.getTypeAtLocation(e))) return;
    if (/ZodError$/.test(calleeName(e.expression) ?? '')) return; // the error middleware maps it to 422
    out.push(e);
  });
  return out;
}

/** Whether a chain root is an Express response (by type; by `.status()` use when types are unresolved). */
function isResponseRoot(checker: ts.TypeChecker, root: ts.Expression, statusSet: boolean): boolean {
  const type = checker.getTypeAtLocation(root);
  if (type.flags & ts.TypeFlags.Any) return statusSet;
  const t = checker.getApparentType(type);
  return t.getProperty('json') !== undefined && t.getProperty('status') !== undefined && t.getProperty('sendStatus') !== undefined;
}

/**
 * Members a problem producer does not supply: none for an error class the error middleware handles;
 * type/title/status for another Error; all five (required) for a plain problem object. An object literal
 * argument must itself carry type/title/status (status may be a separate numeric argument).
 */
function missingProblemFields(m: ApiModel, node: ts.CallExpression | ts.NewExpression, producer: Producer): string[] {
  if (producer.kind === 'handled') return [];
  const { checker } = m;
  const type = checker.getTypeAtLocation(node);
  const missing = new Set(producer.kind === 'document' ? missingMembers(checker, type, node, PROBLEM_MEMBERS, true) : missingMembers(checker, type, node, REQUIRED, false));
  const args = node.arguments ?? [];
  const hasNumeric = args.some((a) => numericValue(checker, a) !== null);
  for (const a of args) {
    const lit = unwrap(a);
    if (!ts.isObjectLiteralExpression(lit) || lit.properties.some(ts.isSpreadAssignment)) continue;
    const keys = new Set(lit.properties.map((p) => (p.name !== undefined ? propName(p.name) : undefined)));
    for (const f of REQUIRED) if (!keys.has(f) && !(f === 'status' && hasNumeric)) missing.add(f);
  }
  const order: readonly string[] = PROBLEM_MEMBERS;
  return [...missing].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function statusText(chain: ResponseChain): string {
  if (chain.statuses !== null) return chain.statuses.join('|');
  return chain.statusExpr !== undefined ? chain.statusExpr.getText() : '(unknown)';
}

function staticUnits(ctx: CheckContext, m: ApiModel, map: Map<string, Tally>): void {
  const { checker } = m;
  for (const { rel: file, sf } of m.sources) {
    walk(sf, (node) => {
      if (ts.isCallExpression(node)) {
        const chain = responseChain(checker, node);
        if (chain !== undefined && isResponseRoot(checker, unwrap(chain.root), chain.statusSet)) {
          // A status that is not a constant may be an error: it is judged as one (a replayed record excepted).
          const unknown = chain.statuses === null;
          const errorStatus = unknown ? !isReplay(checker, chain) : (chain.statuses ?? []).some((s) => s >= 400);
          const keys = adhocKeys(checker, chain.body);
          if (errorStatus || keys.length > 0) {
            const gaps = errorStatus ? problemBodyGaps(checker, chain) : [];
            const why =
              keys.length > 0
                ? `ad-hoc error body with ${keys.map((k) => `"${k}"`).join(', ')}; throw a problem (e.g. notFound(detail)) and let the error middleware send application/problem+json`
                : unknown
                  ? `status ${statusText(chain)} is not a constant, so this may be an error response, and its body is not a problem (missing ${gaps.join(', ')}); send a full problem or use a literal success status`
                  : `status ${statusText(chain)} is sent with a non-problem body (missing ${gaps.join(', ')}); throw a problem helper (notFound/conflict/new HttpProblem) instead`;
            unit(tally(map, file), keys.length === 0 && gaps.length === 0, { location: location(ctx.root, node), message: why });
          }
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const producer = problemProducer(m, node);
        if (producer === undefined || producer.name.includes('.')) return;
        const missing = missingProblemFields(m, node, producer);
        unit(tally(map, file), missing.length === 0, {
          location: location(ctx.root, node),
          message: `${producer.name}(...) does not supply ${missing.join(', ')}; ${producer.kind === 'document' ? 'a problem object needs type, title, status, detail and instance' : 'a problem needs type, title and status'}`,
        });
      }
    });
  }
}

/** Whether a middleware produces a 404: a constant 404 argument / literal, or a problem producer whose status is 404. */
function producesNotFound(m: ApiModel, fn: ts.FunctionLikeDeclaration, env: Env): boolean {
  let found = false;
  if (fn.body === undefined) return false;
  walk(fn.body, (n) => {
    if (found) return;
    if (ts.isNumericLiteral(n) && n.text === '404') found = true;
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return;
    if ((n.arguments ?? []).some((a) => numericValue(m.checker, a, env) === 404)) found = true;
    const producer = problemProducer(m, n);
    if (producer !== undefined && problemStatus(m, n, producer.name, env) === 404) found = true;
  });
  return found;
}

/** A use path that matches every request: none, '/', or a catch-all ('*', '/*', '/*splat', '/{*splat}', '(.*)'). */
function matchesEverything(path: string | undefined): boolean {
  return path === undefined || /^\/?(\*\w*|\{\*\w*\}|\(\.\*\))?$/.test(path);
}

function appUnits(ctx: CheckContext, m: ApiModel, map: Map<string, Tally>): void {
  const uses = useRegistrations(m.program, ctx.root, ctx.sourceFiles);
  const errorRegs = uses.filter((u) => u.params === 4);
  const notFoundRegs = uses.filter(
    (u): u is UseRegistration & { fn: ts.FunctionLikeDeclaration } =>
      u.fn !== undefined && matchesEverything(u.path) && u.fn.parameters.length >= 2 && u.fn.parameters.length <= 3 && producesNotFound(m, u.fn, u.env),
  );
  const anchor = errorRegs[0]?.call ?? notFoundRegs[0]?.call;
  // Nothing registered: blame the app's entry module (app-entry discovery over the API's layout), else the first source file.
  const entry = anchor === undefined ? discoverEntries(ctx.root, undefined, ctx.layout?.sourceRoots).candidates.find((c) => ctx.sourceFiles.includes(c.module))?.module : undefined;
  const file = anchor !== undefined ? location(ctx.root, anchor).replace(/:\d+:\d+$/, '') : (entry ?? ctx.sourceFiles[0] ?? '(project)');
  const fallbackLoc = file === '(project)' ? '(project)' : `${file}:1:1`;
  const t = tally(map, file);
  const errorReg = errorRegs[errorRegs.length - 1];
  unit(t, errorReg !== undefined, {
    location: fallbackLoc,
    message: 'no error-handling middleware is registered; add app.use((err, req, res, next) => sendProblem(...)) after the routes',
  });
  const nf = notFoundRegs[notFoundRegs.length - 1];
  const ordered = nf === undefined || errorReg === undefined || nf.call.getSourceFile() !== errorReg.call.getSourceFile() || nf.call.pos < errorReg.call.pos;
  unit(t, nf !== undefined && ordered, {
    location: nf !== undefined ? location(ctx.root, nf.call) : fallbackLoc,
    message:
      nf === undefined
        ? 'no final not-found handler is registered; add app.use((req, res, next) => next(notFound(...))) after the routes'
        : 'the not-found handler is registered after the error middleware; register it before app.use(errorHandler)',
  });
}

function handlerUnits(ctx: CheckContext, m: ApiModel, routes: RouteInfo[], map: Map<string, Tally>): void {
  const seen = new Set<ts.Node>();
  for (const r of routes) {
    if (r.handler === undefined || seen.has(r.handler)) continue;
    seen.add(r.handler);
    for (const e of nonProblemErrors(m, r.handler)) {
      const file = location(ctx.root, e).replace(/:\d+:\d+$/, '');
      unit(tally(map, file), false, {
        location: location(ctx.root, e),
        message: `${r.method.toUpperCase()} ${r.path}: new ${e.expression.getText()}(...) is not a problem, so the client gets a 500; throw a problem helper (notFound/conflict/unprocessable/new HttpProblem)`,
      });
    }
  }
}

/** The judged probes as one finding, plus an UNPROVEN (skip) finding for any probe that could not be carried out. */
async function runtimeFinding(ctx: CheckContext, routes: RouteInfo[]): Promise<CheckFinding[]> {
  const base: Omit<CheckFinding, 'status' | 'units' | 'violations'> = { rule: RULE, file: '(runtime)' };
  const run = await runProbe(ctx, routes);
  if (!run.ok) return [{ ...base, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: run.reason }];
  const locs = new Map<string, string>();
  for (const r of routes) {
    const key = `${r.method.toUpperCase()} ${substituteParams(r.path)}`;
    if (!locs.has(key)) locs.set(key, location(ctx.root, r.registration));
  }
  const appLoc = run.entryModule !== undefined ? `${run.entryModule}:1:1` : '(runtime)';
  const app = run.entry !== undefined ? ` [app: ${run.entry}]` : '';
  const violations: Violation[] = [];
  const unproven: string[] = [];
  let passed = 0;
  let total = 0;
  for (const o of run.outcomes) {
    if (o.unproven !== undefined) {
      unproven.push(`${o.probe.method} ${o.probe.path} (${o.probe.name}): ${o.unproven}`);
      continue;
    }
    total++;
    if (o.ok) {
      passed++;
      continue;
    }
    const routeLoc = locs.get(`${o.probe.method} ${o.probe.path}`);
    violations.push({
      location: routeLoc ?? appLoc,
      message: `${o.probe.method} ${o.probe.path} (${o.probe.name}): ${o.problems.join('; ')}${routeLoc === undefined ? app : ''}`,
    });
  }
  const findings: CheckFinding[] = [{ ...base, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total }, violations }];
  if (unproven.length > 0) findings.push({ ...base, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: `${unproven.join('; ')}${app}` });
  return findings;
}

/** The static findings (per file), without starting the app. */
export function staticProblemFindings(ctx: CheckContext): CheckFinding[] {
  const m = apiModel(ctx.program(), ctx.root, ctx.sourceFiles);
  const map = new Map<string, Tally>();
  staticUnits(ctx, m, map);
  appUnits(ctx, m, map);
  handlerUnits(ctx, m, extractRouteTable(m.program, ctx.root, ctx.sourceFiles).all, map);
  return [...map.entries()]
    .filter(([, t]) => t.total > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, t]) => ({ rule: RULE, file, status: t.violations.length === 0 ? 'pass' : 'fail', units: { passed: t.passed, total: t.total }, violations: t.violations }));
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const findings = staticProblemFindings(ctx);
  findings.push(...(await runtimeFinding(ctx, extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes)));
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'Errors are application/problem+json {type,title,status,detail,instance}: problem helpers only, error middleware + not-found handler, verified by runtime probes.',
  unit: 'error paths',
  doc: DOC,
  run,
});
