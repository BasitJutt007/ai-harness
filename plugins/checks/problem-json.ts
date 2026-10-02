/**
 * problem-json: every error leaves the API as RFC 9457 application/problem+json.
 * Static: no ad-hoc error bodies, error statuses only with problem bodies, problem
 * producers supply type/title/status, an error middleware and a final not-found
 * handler are registered. Runtime: probes against createApp (UNPROVEN if it cannot start).
 */
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import {
  calleeName,
  extractRoutes,
  isProblemShaped,
  location,
  stringLiteralValue,
  problemProducer,
  programFile,
  propName,
  responseChain,
  unwrap,
  useRegistrations,
  walk,
  constInitializer,
  numericValue,
} from '../lib/api-ast.ts';
import type { RouteInfo, UseRegistration } from '../lib/api-ast.ts';
import { runProbe, substituteParams } from '../lib/probe.ts';

const RULE = 'problem-json';
const ADHOC_KEYS = new Set(['error', 'errors', 'message']);
const REQUIRED = ['type', 'title', 'status'] as const;

const DOC = `problem-json (unit: error paths)
Every error response is RFC 9457 application/problem+json: { type, title, status, detail, instance }.
Static rules (per src file):
- Never send ad-hoc error bodies (object literals with error / errors / message keys).
- Never res.status(>=400).json/send(...) / sendStatus(>=400) unless the body comes from a problem helper
  (or is a {type,title,status,...} literal sent with .type('application/problem+json')).
  Prefer: throw notFound(detail) / conflict(detail) / new HttpProblem({...}) and let the error middleware send it.
- Every problem producer (new HttpProblem(...), notFound(...), conflict(...), ...) yields type, title, status.
- Handlers never throw / next() a non-problem error (new Error('not found') becomes a 500).
- The app registers an error-handling middleware (err, req, res, next) and a final not-found handler.
Runtime (src/app.ts exports createApp): probes must get Content-Type application/problem+json and a body
with string type/title/detail/instance and integer status equal to the HTTP status:
  GET <base>/__harness_probe__/does-not-exist -> 404; POST/PUT/PATCH malformed JSON -> 400, invalid body -> 422;
  GET/PATCH/DELETE on :param routes with an unknown uuid -> 404 (422 accepted); a route that throws a plain
  Error -> 500 problem without the error message or stack; collection GET -> 200 JSON that is NOT a problem.
  App cannot start -> UNPROVEN.
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

function isProblemExpr(checker: ts.TypeChecker, body: ts.Expression): boolean {
  const e = constValue(checker, body);
  return e !== undefined && problemProducer(checker, e) !== undefined;
}

/** An object literal with type, title and status keys (a hand-assembled problem document). */
function isProblemLiteral(checker: ts.TypeChecker, body: ts.Expression): boolean {
  const e = constValue(checker, body);
  if (e === undefined || !ts.isObjectLiteralExpression(e)) return false;
  const keys = new Set(e.properties.map((p) => (p.name !== undefined ? propName(p.name) : undefined)));
  return REQUIRED.every((k) => keys.has(k));
}

function mentionsProblemType(checker: ts.TypeChecker, arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  const e = constValue(checker, arg);
  const text = e !== undefined ? stringLiteralValue(e) : undefined;
  return text !== undefined && /problem\+json/i.test(text);
}

/** Whether the response chain sets Content-Type application/problem+json (`.type(...)`, `.set('Content-Type', ...)`, …). */
function chainSetsProblemType(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  let cur: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const name = cur.expression.name.text;
      const [a0, a1] = cur.arguments;
      if ((name === 'type' || name === 'contentType') && mentionsProblemType(checker, a0)) return true;
      if ((name === 'set' || name === 'header' || name === 'setHeader') && stringLiteralValue(a0)?.toLowerCase() === 'content-type' && mentionsProblemType(checker, a1)) {
        return true;
      }
    }
    cur = cur.expression;
  }
  return false;
}

/** Errors constructed by a handler that are not problems: `throw new Error(...)`, `next(new Error(...))`. */
function nonProblemErrors(checker: ts.TypeChecker, fn: ts.FunctionLikeDeclaration): ts.NewExpression[] {
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
    if (problemProducer(checker, e) !== undefined || isProblemShaped(checker, checker.getTypeAtLocation(e))) return;
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

function isStringish(checker: ts.TypeChecker, t: ts.Type): boolean {
  return (checker.getApparentType(t).flags & ts.TypeFlags.StringLike) !== 0 || (t.flags & ts.TypeFlags.StringLike) !== 0 || checker.typeToString(t) === 'String';
}

function isNumberish(checker: ts.TypeChecker, t: ts.Type): boolean {
  return (t.flags & ts.TypeFlags.NumberLike) !== 0 || checker.typeToString(t) === 'Number';
}

/** Missing type/title/status of a problem producer (by its result type and any object-literal init). */
function missingProblemFields(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression): string[] {
  const missing = new Set<string>();
  const type = checker.getTypeAtLocation(node);
  const fieldOk = (name: string): boolean => {
    const sym = checker.getApparentType(type).getProperty(name);
    if (sym === undefined) return false;
    const t = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(sym, node));
    return name === 'status' ? isNumberish(checker, t) : isStringish(checker, t);
  };
  for (const f of REQUIRED) if (!fieldOk(f)) missing.add(f);
  const args = node.arguments ?? [];
  const hasNumeric = args.some((a) => numericValue(checker, a) !== null);
  for (const a of args) {
    const lit = unwrap(a);
    if (!ts.isObjectLiteralExpression(lit) || lit.properties.some(ts.isSpreadAssignment)) continue;
    const keys = new Set(lit.properties.map((p) => (p.name !== undefined ? propName(p.name) : undefined)));
    for (const f of REQUIRED) if (!keys.has(f) && !(f === 'status' && hasNumeric)) missing.add(f);
  }
  return [...missing];
}

function staticUnits(ctx: CheckContext, program: ts.Program, map: Map<string, Tally>): void {
  const checker = program.getTypeChecker();
  for (const file of ctx.sourceFiles) {
    const sf = programFile(program, ctx.root, file);
    if (sf === undefined) continue;
    walk(sf, (node) => {
      if (ts.isCallExpression(node)) {
        const chain = responseChain(checker, node);
        if (chain !== undefined && isResponseRoot(checker, unwrap(chain.root), chain.statusSet)) {
          const errorStatus = chain.status !== null && chain.status >= 400;
          const keys = adhocKeys(checker, chain.body);
          if (errorStatus || keys.length > 0) {
            const problemBody =
              chain.body !== undefined &&
              (isProblemExpr(checker, chain.body) || (isProblemLiteral(checker, chain.body) && chainSetsProblemType(checker, node)));
            const ok = keys.length === 0 && problemBody;
            const why =
              keys.length > 0
                ? `ad-hoc error body with ${keys.map((k) => `"${k}"`).join(', ')}; throw a problem (e.g. notFound(detail)) and let the error middleware send application/problem+json`
                : `status ${String(chain.status)} is sent with a non-problem body; throw a problem helper (notFound/conflict/new HttpProblem) instead`;
            unit(tally(map, file), ok, { location: location(ctx.root, node), message: why });
          }
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = problemProducer(checker, node);
        if (name === undefined || name.includes('.')) return;
        const missing = missingProblemFields(checker, node);
        unit(tally(map, file), missing.length === 0, {
          location: location(ctx.root, node),
          message: `${name}(...) does not supply ${missing.join(', ')}; a problem needs type, title and status`,
        });
      }
    });
  }
}

function mentionsNotFound(fn: ts.FunctionLikeDeclaration): boolean {
  let found = false;
  walk(fn, (n) => {
    if ((ts.isIdentifier(n) && n.text === 'notFound') || (ts.isNumericLiteral(n) && n.text === '404')) found = true;
  });
  return found;
}

function appUnits(ctx: CheckContext, program: ts.Program, map: Map<string, Tally>): void {
  const uses = useRegistrations(program, ctx.root, ctx.sourceFiles);
  const errorRegs = uses.filter((u) => u.fn !== undefined && u.fn.parameters.length === 4);
  const notFoundRegs = uses.filter(
    (u): u is UseRegistration & { fn: ts.FunctionLikeDeclaration } =>
      u.fn !== undefined && u.path === undefined && u.fn.parameters.length >= 2 && u.fn.parameters.length <= 3 && mentionsNotFound(u.fn),
  );
  const anchor = errorRegs[0]?.call ?? notFoundRegs[0]?.call;
  const file = anchor !== undefined ? location(ctx.root, anchor).replace(/:\d+:\d+$/, '') : ctx.sourceFiles.includes('src/app.ts') ? 'src/app.ts' : (ctx.sourceFiles[0] ?? '(project)');
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

function handlerUnits(ctx: CheckContext, program: ts.Program, routes: RouteInfo[], map: Map<string, Tally>): void {
  const checker = program.getTypeChecker();
  const seen = new Set<ts.Node>();
  for (const r of routes) {
    if (r.handler === undefined || seen.has(r.handler)) continue;
    seen.add(r.handler);
    for (const e of nonProblemErrors(checker, r.handler)) {
      const file = location(ctx.root, e).replace(/:\d+:\d+$/, '');
      unit(tally(map, file), false, {
        location: location(ctx.root, e),
        message: `${r.method.toUpperCase()} ${r.path}: new ${e.expression.getText()}(...) is not a problem, so the client gets a 500; throw a problem helper (notFound/conflict/unprocessable/new HttpProblem)`,
      });
    }
  }
}

async function runtimeFinding(ctx: CheckContext, routes: RouteInfo[]): Promise<CheckFinding> {
  const base: Omit<CheckFinding, 'status' | 'units' | 'violations'> = { rule: RULE, file: '(runtime)' };
  if (!ctx.sourceFiles.includes('src/app.ts')) {
    return { ...base, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'src/app.ts not found: runtime problem+json behaviour is unproven' };
  }
  const run = await runProbe(ctx, routes);
  if (!run.ok) return { ...base, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: run.reason };
  const locs = new Map<string, string>();
  for (const r of routes) {
    const key = `${r.method.toUpperCase()} ${substituteParams(r.path)}`;
    if (!locs.has(key)) locs.set(key, location(ctx.root, r.registration));
  }
  const violations: Violation[] = [];
  let passed = 0;
  for (const o of run.outcomes) {
    if (o.ok) {
      passed++;
      continue;
    }
    violations.push({
      location: locs.get(`${o.probe.method} ${o.probe.path}`) ?? 'src/app.ts:1:1',
      message: `${o.probe.method} ${o.probe.path} (${o.probe.name}): ${o.problems.join('; ')}`,
    });
  }
  return { ...base, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total: run.outcomes.length }, violations };
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const program = ctx.program();
  const map = new Map<string, Tally>();
  const routes = extractRoutes(program, ctx.root, ctx.sourceFiles);
  staticUnits(ctx, program, map);
  appUnits(ctx, program, map);
  handlerUnits(ctx, program, routes, map);
  const findings: CheckFinding[] = [...map.entries()]
    .filter(([, t]) => t.total > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, t]) => ({ rule: RULE, file, status: t.violations.length === 0 ? 'pass' : 'fail', units: { passed: t.passed, total: t.total }, violations: t.violations }));
  findings.push(await runtimeFinding(ctx, routes));
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
