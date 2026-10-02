/**
 * rest-conventions: versioned plural resource paths, cursor pagination on
 * collections, idempotency on POST/PATCH and the house status-code rules.
 */
import pluralize from 'pluralize';
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { calleeName, extractRoutes, hasPathParams, isCollectionPath, location, propertyType, routeLabel, unwrap } from '../lib/api-ast.ts';
import type { RouteInfo } from '../lib/api-ast.ts';

const RULE = 'rest-conventions';
export const ALLOWED_STATUSES = new Set([200, 201, 202, 204, 304, 400, 401, 403, 404, 409, 412, 415, 422, 428, 429, 500, 503]);
const OFFSET_KEYS = ['page', 'offset', 'skip'];

const DOC = `rest-conventions (unit: routes)
A route passes iff ALL of:
1. Versioned base path: the full path (after app.use prefixes) starts with /v<digits>/.
2. Plural nouns: every static segment after the version is plural (kebab-case: the last word); :params are skipped.
3. Cursor pagination: a GET on a collection path (last segment static) parses req.query with a schema whose
   type has cursor and limit (and no page/offset/skip), and its 2xx response schema has nextCursor and an
   array property data or items.
4. Idempotency: every POST and PATCH has a middleware whose name matches /idempot/i (e.g. idempotency(), per route
   or via router.use(idempotency()) before the route),
   or parses req.headers with a schema that has an 'idempotency-key' property.
5. Status codes: POST on a collection responds res.status(201) (never a bare 200); DELETE responds 204 with
   no body; every literal status is one of 200 201 202 204 304 400 401 403 404 409 412 415 422 428 429 500 503;
   :param routes have a 404 path (throw notFound(...) / HttpProblem 404 / res.status(404)); validation
   failures are 422: a literal 400 in a handler is a violation (400 is only for malformed JSON, in the error middleware).
Passing example:
  usersRouter.get('/v1/users', (req, res) => {
    const query = ListUsersQuerySchema.parse(req.query);      // CursorQuerySchema.extend({...})
    res.json(UserPageSchema.parse(store.list(query)));        // { data: User[], nextCursor: string | null }
  });
  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const user = store.create(CreateUserSchema.parse(req.body));
    res.status(201).location(\`/v1/users/\${user.id}\`).json(UserSchema.parse(user));
  });
  usersRouter.delete('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    if (!store.remove(userId)) throw notFound(\`user \${userId} not found\`);
    res.status(204).end();
  });`;

function isPluralWord(word: string): boolean {
  const w = word.toLowerCase();
  if (pluralize.singular(w) === pluralize.plural(w)) return true; // no distinct forms (news, series, …)
  return pluralize.isPlural(w) && !pluralize.isSingular(w);
}

function nameViolations(r: RouteInfo, at: string): Violation[] {
  const out: Violation[] = [];
  const label = routeLabel(r);
  const segs = r.path.split('/').filter((s) => s !== '');
  const versioned = /^\/v\d+\//.test(r.path);
  if (!versioned) out.push({ location: at, message: `${label}: path is not versioned; prefix it with /v1/` });
  for (const seg of versioned ? segs.slice(1) : segs) {
    if (seg.startsWith(':')) continue;
    const word = seg.split(/[-_]/).pop() ?? seg;
    if (!isPluralWord(word)) {
      out.push({ location: at, message: `${label}: segment "${seg}" is not a plural noun; use "${seg.slice(0, seg.length - word.length)}${pluralize.plural(word)}"` });
    }
  }
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
  const bodies = r.responses.filter((s) => s.hasBody && (s.status === null || (s.status >= 200 && s.status < 300)));
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

function idempotencyViolations(checker: ts.TypeChecker, r: RouteInfo, at: string): Violation[] {
  if (r.method !== 'post' && r.method !== 'patch') return [];
  const viaMiddleware = [...r.middleware, ...r.scopeMiddleware].some((m) => {
    const e = unwrap(m);
    const name = ts.isCallExpression(e) ? calleeName(e.expression) : calleeName(e);
    return name !== undefined && /idempot/i.test(name);
  });
  const viaHeaders = r.parses.some((p) => {
    const t = p.schema.parsedType;
    if (p.target !== 'headers' || t === undefined) return false;
    return checker.getApparentType(t).getProperties().some((s) => s.name.toLowerCase() === 'idempotency-key');
  });
  if (viaMiddleware || viaHeaders) return [];
  return [{ location: at, message: `${routeLabel(r)}: no idempotency; add the idempotency() middleware (Idempotency-Key header)` }];
}

function statusViolations(root: string, r: RouteInfo, at: string): Violation[] {
  const label = routeLabel(r);
  const out: Violation[] = [];
  if (r.method === 'post' && isCollectionPath(r.path)) {
    const created = r.responses.some((s) => s.status === 201);
    const plain = r.responses.find((s) => s.status === 200);
    if (!created || plain !== undefined) {
      out.push({ location: plain !== undefined ? location(root, plain.call) : at, message: `${label}: creating a resource must respond res.status(201) (with Location), not 200` });
    }
  }
  if (r.method === 'delete') {
    const noContent = r.responses.some((s) => s.status === 204 && !s.hasBody);
    const withBody = r.responses.find((s) => s.hasBody && (s.status === null || (s.status >= 200 && s.status < 300)));
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
  if (hasPathParams(r.path)) {
    const has404 =
      r.statusLiterals.some((s) => s.status === 404) ||
      [...r.problemSites, ...r.calleeProblemSites].some((p) => p.status === 404 || p.name === 'notFound');
    if (!has404) out.push({ location: at, message: `${label}: no 404 path for an unknown id; throw notFound(...) when the resource does not exist` });
  }
  return out;
}

export function routeViolations(checker: ts.TypeChecker, root: string, r: RouteInfo): Violation[] {
  const at = location(root, r.registration);
  return [
    ...nameViolations(r, at),
    ...paginationViolations(checker, r, at, root),
    ...idempotencyViolations(checker, r, at),
    ...statusViolations(root, r, at),
  ];
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const program = ctx.program();
  const checker = program.getTypeChecker();
  const routes = extractRoutes(program, ctx.root, ctx.sourceFiles);
  const files = [...new Set(routes.map((r) => r.file))].sort();
  return files.map((file): CheckFinding => {
    let passed = 0;
    const violations: Violation[] = [];
    const fileRoutes = routes.filter((r) => r.file === file);
    for (const r of fileRoutes) {
      const v = routeViolations(checker, ctx.root, r);
      if (v.length === 0) passed++;
      violations.push(...v);
    }
    return { rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total: fileRoutes.length }, violations };
  });
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'Routes are /v<N>/ + plural nouns, collections use cursor pagination, POST/PATCH are idempotent, statuses follow 201/204/404/422 rules.',
  unit: 'routes',
  doc: DOC,
  run,
});
