/**
 * rest-conventions: versioned plural resource paths, cursor pagination on
 * collections, idempotency on POST/PATCH and the house status-code rules.
 * Paths and statuses are read by value (constants, enums, `as const` objects);
 * idempotency is recognised by behaviour (the chain reads the Idempotency-Key header).
 */
import pluralize from 'pluralize';
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { extractRouteTable, hasPathParams, isCollectionPath, location, propertyType, routeLabel } from '../lib/api-ast.ts';
import type { ResponseSite, RouteInfo } from '../lib/api-ast.ts';

const RULE = 'rest-conventions';
export const ALLOWED_STATUSES = new Set([200, 201, 202, 204, 304, 400, 401, 403, 404, 409, 412, 415, 422, 428, 429, 500, 503]);
const OFFSET_KEYS = ['page', 'offset', 'skip'];
const ACTION_STATUSES = [200, 201, 202, 204];

const DOC = `rest-conventions (unit: routes)
A route passes iff ALL of (paths and statuses are read by value: constants, enums and \`as const\` members count):
1. Versioned base path: the full path (after app.use / router.use prefixes, composed) starts with /v<digits>/.
2. Plural nouns: every static segment after the version is plural (kebab-case: the last word); :params are skipped.
   Exception: the last segment of a POST right after a :param is an action (/v1/orders/:orderId/cancel).
3. Cursor pagination: a GET on a collection path (last segment static) parses req.query (in the handler or a
   middleware) with a schema whose type has cursor and limit (and no page/offset/skip), and its 2xx response
   schema has nextCursor and an array property data or items.
4. Idempotency: every POST and PATCH has a function in its chain (route middleware, router.use(...) before the
   route, or the handler) that reads the Idempotency-Key header: req.get/req.header('Idempotency-Key'),
   req.headers['idempotency-key'], or a parse of req.headers with a schema that has 'idempotency-key'.
5. Status codes: POST on a collection responds 201 (never a bare 200); an action POST responds 200/201/202/204;
   DELETE responds 204 with no body; every status is one of 200 201 202 204 304 400 401 403 404 409 412 415 422
   428 429 500 503; :param routes have a 404 path (throw notFound(...), an error class the error middleware maps
   to 404, or res.status(404)); validation failures are 422: a literal 400 in a handler is a violation.
A route whose path cannot be resolved statically is UNPROVEN unless a path-independent rule already fails.
Passing example:
  usersRouter.get('/v1/users', (req, res) => {
    const query = ListUsersQuerySchema.parse(req.query);      // CursorQuerySchema.extend({...})
    res.json(UserPageSchema.parse(store.list(query)));        // { data: User[], nextCursor: string | null }
  });
  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const user = store.create(CreateUserSchema.parse(req.body));
    res.status(201).location(\`/v1/users/\${user.id}\`).json(UserSchema.parse(user));
  });
  usersRouter.delete('/v1/users/:userId', (req, res) => { … throw notFound(…) … res.status(204).end(); });`;

function isPluralWord(word: string): boolean {
  const w = word.toLowerCase();
  if (pluralize.singular(w) === pluralize.plural(w)) return true; // no distinct forms (news, series, …)
  return pluralize.isPlural(w) && !pluralize.isSingular(w);
}

/** A POST whose last segment is a singular verb-like word right after a :param: `/orders/:orderId/cancel`. */
export function isActionRoute(r: Pick<RouteInfo, 'method' | 'path'>): boolean {
  if (r.method !== 'post') return false;
  const segs = r.path.split('/').filter((s) => s !== '');
  const last = segs[segs.length - 1];
  const before = segs[segs.length - 2];
  if (last === undefined || before === undefined || last.startsWith(':') || !before.startsWith(':')) return false;
  return !isPluralWord(last.split(/[-_]/).pop() ?? last);
}

function nameViolations(r: RouteInfo, at: string): Violation[] {
  const out: Violation[] = [];
  const label = routeLabel(r);
  const segs = r.path.split('/').filter((s) => s !== '');
  const versioned = /^\/v\d+\//.test(r.path);
  if (!versioned) out.push({ location: at, message: `${label}: path is not versioned; prefix it with /v1/` });
  const checked = versioned ? segs.slice(1) : segs;
  const action = isActionRoute(r);
  checked.forEach((seg, i) => {
    if (seg.startsWith(':') || (action && i === checked.length - 1)) return;
    const word = seg.split(/[-_]/).pop() ?? seg;
    if (!isPluralWord(word)) {
      out.push({ location: at, message: `${label}: segment "${seg}" is not a plural noun; use "${seg.slice(0, seg.length - word.length)}${pluralize.plural(word)}"` });
    }
  });
  return out;
}

function paginationViolations(checker: ts.TypeChecker, r: RouteInfo, at: string, root: string): Violation[] {
  if (r.method !== 'get' || !isCollectionPath(r.path)) return [];
  const label = routeLabel(r);
  const out: Violation[] = [];
  const queries = r.parses.filter((p) => p.target === 'query');
  const goodQuery = queries.some((p) => {
    const t = p.schema.parsedType;
    if (t === undefined) return false;
    const has = (k: string): boolean => propertyType(checker, t, k, p.call) !== undefined;
    return has('cursor') && has('limit') && !OFFSET_KEYS.some(has);
  });
  if (!goodQuery) {
    const offset = queries.find((p) => {
      const t = p.schema.parsedType;
      return t !== undefined && OFFSET_KEYS.some((k) => propertyType(checker, t, k, p.call) !== undefined);
    });
    out.push({
      location: offset !== undefined ? location(root, offset.call) : at,
      message: offset !== undefined
        ? `${label}: offset/page pagination; parse req.query with a cursor schema (cursor + limit, e.g. CursorQuerySchema.extend({...}))`
        : `${label}: collection GET must parse req.query with a cursor schema that has cursor and limit`,
    });
  }
  const bodies = r.responses.filter((s) => s.hasBody && !s.isProblem && maySucceed(s));
  const pageOk = (s: (typeof bodies)[number]): boolean => {
    const t = s.schema?.parsedType;
    if (t === undefined) return false;
    if (propertyType(checker, t, 'nextCursor', s.call) === undefined) return false;
    return ['data', 'items'].some((k) => {
      const pt = propertyType(checker, t, k, s.call);
      return pt !== undefined && checker.isArrayType(checker.getNonNullableType(pt));
    });
  };
  const bad = bodies.find((s) => !pageOk(s));
  if (bodies.length === 0 || bad !== undefined) {
    out.push({
      location: bad !== undefined ? location(root, bad.call) : at,
      message: `${label}: collection response must be a page schema with data (array) and nextCursor, e.g. pageSchema(ItemSchema).parse(...)`,
    });
  }
  return out;
}

/** A response that may be a success: a 2xx status, or a status that is not a constant. */
function maySucceed(s: ResponseSite): boolean {
  return s.statuses === null || s.statuses.some((x) => x >= 200 && x < 300);
}

function idempotencyViolations(r: RouteInfo, at: string): Violation[] {
  if (r.method !== 'post' && r.method !== 'patch') return [];
  if (r.readsIdempotencyKey) return [];
  return [{ location: at, message: `${routeLabel(r)}: no idempotency: nothing in the chain reads the Idempotency-Key header; add the idempotency() middleware (or a middleware that reads Idempotency-Key)` }];
}

function statusViolations(root: string, r: RouteInfo, at: string, knownPath: boolean): Violation[] {
  const label = routeLabel(r);
  const out: Violation[] = [];
  const has = (s: ResponseSite, n: number): boolean => s.statuses?.includes(n) === true;
  if (knownPath && isActionRoute(r)) {
    const bad = r.responses.find((s) => s.statuses !== null && s.statuses.some((x) => x >= 200 && x < 300 && !ACTION_STATUSES.includes(x)));
    const ok = r.responses.some((s) => ACTION_STATUSES.some((x) => has(s, x)));
    if (!ok || bad !== undefined) {
      out.push({ location: bad !== undefined ? location(root, bad.call) : at, message: `${label}: an action responds 200, 201, 202 or 204` });
    }
  } else if (knownPath && r.method === 'post' && isCollectionPath(r.path)) {
    const created = r.responses.some((s) => has(s, 201));
    const plain = r.responses.find((s) => has(s, 200));
    if (!created || plain !== undefined) {
      out.push({ location: plain !== undefined ? location(root, plain.call) : at, message: `${label}: creating a resource must respond res.status(201) (with Location), not 200` });
    }
  }
  if (r.method === 'delete') {
    const noContent = r.responses.some((s) => s.status === 204 && !s.hasBody);
    const withBody = r.responses.find((s) => s.hasBody && !s.isProblem && maySucceed(s));
    if (!noContent || withBody !== undefined) {
      out.push({ location: withBody !== undefined ? location(root, withBody.call) : at, message: `${label}: DELETE must respond res.status(204).end() with no body` });
    }
  }
  for (const s of r.statusLiterals) {
    if (s.status === 400) {
      out.push({ location: location(root, s.node), message: `${label}: literal 400 in a handler; validation failures are 422 (parse with Zod and let the error middleware respond)` });
    } else if (!ALLOWED_STATUSES.has(s.status)) {
      out.push({ location: location(root, s.node), message: `${label}: status ${s.status} is not in the allowed set (${[...ALLOWED_STATUSES].join(', ')})` });
    }
  }
  if (knownPath && hasPathParams(r.path)) {
    const has404 =
      r.statusLiterals.some((s) => s.status === 404) ||
      [...r.problemSites, ...r.calleeProblemSites].some((p) => p.status === 404 || p.name === 'notFound');
    if (!has404) out.push({ location: at, message: `${label}: no 404 path for an unknown id; throw notFound(...) when the resource does not exist` });
  }
  return out;
}

export function routeViolations(checker: ts.TypeChecker, root: string, r: RouteInfo): Violation[] {
  const at = location(root, r.registration);
  if (r.unresolvedPath !== undefined) {
    // Only the rules that do not depend on the path can be judged.
    return [...idempotencyViolations(r, at), ...statusViolations(root, r, at, false)];
  }
  return [
    ...nameViolations(r, at),
    ...paginationViolations(checker, r, at, root),
    ...idempotencyViolations(r, at),
    ...statusViolations(root, r, at, true),
  ];
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const program = ctx.program();
  const checker = program.getTypeChecker();
  const { all } = extractRouteTable(program, ctx.root, ctx.sourceFiles);
  const files = [...new Set(all.map((r) => r.file))].sort();
  const findings: CheckFinding[] = [];
  for (const file of files) {
    let passed = 0;
    let total = 0;
    const violations: Violation[] = [];
    for (const r of all.filter((x) => x.file === file)) {
      const v = routeViolations(checker, ctx.root, r);
      if (r.unresolvedPath !== undefined && v.length === 0) {
        findings.push({
          rule: RULE,
          file,
          status: 'skip',
          units: { passed: 0, total: 0 },
          violations: [],
          skipReason: `${location(ctx.root, r.unresolvedPath.node)}: ${r.method.toUpperCase()} route: ${r.unresolvedPath.reason}, so its versioning, naming, pagination and 404 rules are unproven`,
        });
        continue;
      }
      total++;
      if (v.length === 0) passed++;
      violations.push(...v);
    }
    if (total > 0) findings.push({ rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total }, violations });
  }
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'Routes are /v<N>/ + plural nouns, collections use cursor pagination, POST/PATCH are idempotent, statuses follow 201/204/404/422 rules.',
  unit: 'routes',
  doc: DOC,
  run,
});
