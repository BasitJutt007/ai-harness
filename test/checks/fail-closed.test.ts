import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import problemJson from '../../plugins/checks/problem-json.ts';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import zodBoundary from '../../plugins/checks/zod-boundary.ts';
import { extractRouteTable } from '../../plugins/lib/api-ast.ts';
import type { RouteInfo } from '../../plugins/lib/api-ast.ts';
import type { CheckContext, CheckFinding } from '../../src/core/plugin-api.ts';
import { contextFor, mountApp, removeTempApi, tempApi } from './_ctx.ts';

/**
 * Fail-closed: whatever a route's chain does that the analysis does not model makes the route UNPROVEN in every
 * route rule (never pass). Each variant below differs from the control in one construct; the control passes.
 */

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTempApi(r);
});

async function api(files: Record<string, string>): Promise<CheckContext> {
  const root = await tempApi(files, { withLib: true });
  roots.push(root);
  return contextFor(root);
}

const HEAD = `import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { notFound } from './lib/problem.js';
const Item = z.object({ id: z.string(), name: z.string() });
const Params = z.object({ itemId: z.string() });
const items = new Map<string, z.infer<typeof Item>>();
declare const handlers: Record<string, RequestHandler>;
declare function mystery(): RequestHandler;
export const r = Router();
`;

/** [name, handler body after the param parse and the 404, expected: 'ok' | the unknown it must name] */
const BODIES: Array<[string, string, string]> = [
  ['control', 'res.json(Item.parse(item));', 'ok'],
  ['redirect', "res.redirect(302, '/v1/elsewhere');", 'res.redirect'],
  ['write', 'res.write(JSON.stringify(item));\n  res.end();', 'res.write'],
  ['sendFile', "res.sendFile('/etc/hosts');", 'res.sendFile'],
  ['statusCode write', 'res.statusCode = 299;\n  res.json(Item.parse(item));', 'res.statusCode` is assigned'],
  ['computed member', "res['json'](Item.parse(item));", 'computed member'],
  ['non-constant status', 'const code: number = item.name.length;\n  res.status(code).json(Item.parse(item));', 'is not a constant'],
  ['req.param', "void req.param('itemId');\n  res.json(Item.parse(item));", 'req.param'],
  ['req.res', 'req.res?.json(item);', 'req.res'],
];

function body(b: string): string {
  return `(req, res) => {\n  const { itemId } = Params.parse(req.params);\n  const item = items.get(itemId);\n  if (item === undefined) throw notFound('no item');\n  ${b}\n}`;
}

const ROUTES = [
  ...BODIES.map(([, b], i) => `r.get('/v1/c${i}-items/:itemId', ${body(b)});`),
  `r.get('/v1/lib-handler/:itemId', express.static('public'));`,
  `r.get('/v1/unresolved-handler/:itemId', handlers.show ?? ((_req, res) => { res.status(204).end(); }));`,
  `r.get('/v1/declared-handler/:itemId', mystery());`,
  `r.get('/v1/declared-middleware/:itemId', mystery(), ${body('res.json(Item.parse(item));')});`,
  `r.get('/v1/json-items/:itemId', express.json(), ${body('res.json(Item.parse(item));')});`,
].join('\n');

const forPath = (rows: RouteInfo[], path: string): RouteInfo | undefined => rows.find((x) => x.path === path);
const why = (r: RouteInfo | undefined): string => (r?.unknowns ?? []).map((u) => u.why).join(' | ');

describe('a route doing something the analysis does not model is UNPROVEN, never pass', () => {
  let ctx: CheckContext;
  let rows: RouteInfo[];
  beforeAll(async () => {
    ctx = await api({ 'src/routes.ts': HEAD + ROUTES, ...mountApp() });
    rows = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).all;
  });

  it.each(BODIES.map(([name, , want], i) => [name, want, i] as const))('%s → %s', (_name, want, i) => {
    const row = forPath(rows, `/v1/c${i}-items/:itemId`);
    expect(row).toBeDefined();
    if (want === 'ok') expect(row?.unknowns).toEqual([]);
    else expect(why(row)).toContain(want);
  });

  it('a library handler, an unresolved one and a declared-only one are unknown', () => {
    expect(why(forPath(rows, '/v1/lib-handler/:itemId'))).toContain("the handler express.static('public')");
    expect(why(forPath(rows, '/v1/unresolved-handler/:itemId'))).toContain('cannot be resolved');
    expect(why(forPath(rows, '/v1/declared-handler/:itemId'))).toContain('the handler mystery()');
  });

  it('a declared-only middleware is unknown; express.json() is known to be harmless', () => {
    expect(why(forPath(rows, '/v1/declared-middleware/:itemId'))).toContain('the middleware mystery()');
    expect(forPath(rows, '/v1/json-items/:itemId')?.unknowns).toEqual([]);
  });

  it('every route rule reports the unknown routes as UNPROVEN and passes only the clean ones', async () => {
    for (const check of [zodBoundary, restConventions]) {
      const findings: CheckFinding[] = await check.run(ctx);
      const skips = findings.filter((f) => f.status === 'skip').map((f) => f.skipReason ?? '');
      for (const [name, , want] of BODIES) {
        const i = BODIES.findIndex(([n]) => n === name);
        // Never pass: UNPROVEN, or a FAIL the rule finds on its own.
        const label = `/v1/c${i}-items/:itemId:`;
        const hit = skips.some((s) => s.includes(label)) || findings.some((f) => f.violations.some((v) => v.message.includes(label)));
        expect(hit, `${check.id}: ${name}`).toBe(want !== 'ok');
      }
      // Only the control and the express.json() route pass (zod-boundary FAILs the handlers it cannot resolve).
      expect(findings.find((f) => f.status !== 'skip')?.units.passed, check.id).toBe(2);
    }
  });
});

describe('the path a router is served at', () => {
  const ROUTER = `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
export const r = Router();
r.get('/v1/items', (_req, res) => { res.json(Item.array().parse([])); });
`;

  it('a router nothing mounts is unknown; mounted directly or through a registerRoutes(app) parameter it is not', async () => {
    const unmounted = await api({ 'src/routes.ts': ROUTER });
    const u = extractRouteTable(unmounted.program(), unmounted.root, unmounted.sourceFiles).all;
    expect(why(u[0])).toContain('is not mounted where the analysis can follow it');

    const direct = await api({ 'src/routes.ts': ROUTER, ...mountApp() });
    expect(extractRouteTable(direct.program(), direct.root, direct.sourceFiles).all[0]?.unknowns).toEqual([]);

    const viaParam = await api({
      'src/routes.ts': ROUTER,
      'src/register.ts': "import type { Router } from 'express';\nimport { r } from './routes.ts';\nexport function registerRoutes(app: Router): void {\n  app.use('/api', r);\n}\n",
      'src/app.ts': "import express from 'express';\nimport { registerRoutes } from './register.ts';\nexport const app = express();\nregisterRoutes(app);\n",
    });
    const p = extractRouteTable(viaParam.program(), viaParam.root, viaParam.sourceFiles).all;
    expect(p.map((x) => [x.path, x.unknowns.length])).toEqual([['/api/v1/items', 0]]);
  });
});

describe('problem-json judges the status a send actually carries', () => {
  it('res.status(404) in an earlier statement makes the later body an error body; a status in a returning branch does not', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
export const r = Router();
r.get('/v1/items/:itemId', (req, res) => {
  const { itemId } = z.object({ itemId: z.string() }).parse(req.params);
  if (itemId === 'gone') {
    res.status(410).json({ title: 'Gone' });
    return;
  }
  if (itemId === 'missing') {
    res.status(404);
  }
  res.json(Item.parse({ id: itemId }));
});
r.get('/v1/things/:thingId', (req, res) => {
  const { thingId } = z.object({ thingId: z.string() }).parse(req.params);
  res.status(404);
  res.json({ title: 'Not found', thing: thingId });
});
`,
      ...mountApp(),
    });
    const findings = (await problemJson.run(ctx)).filter((f) => f.file === 'src/routes.ts');
    const msgs = findings.flatMap((f) => f.violations).map((v) => `${v.location.replace(/:\d+$/, '')} ${v.message}`);
    // Line 8: an ad-hoc 410 body. Line 14: the fall-through branch may send 404 with a non-problem body. Line 19: 404 set earlier.
    expect(msgs.some((m) => m.startsWith('src/routes.ts:8') && m.includes('status 410'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('src/routes.ts:14') && m.includes('200|404'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('src/routes.ts:19') && m.includes('status 404'))).toBe(true);
  });
});

describe('routes the running app serves that the static analysis did not find', () => {
  const app = (extra: string): string => `import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { r } from './routes.js';
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(r);
  ${extra}
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
`;
  const ROUTES = `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
export const r = Router();
r.get('/v1/items', (_req, res) => { res.json(Item.array().parse([])); });
`;
  const listedSkip = async (extra: string): Promise<string[]> => {
    const ctx = await api({ 'src/routes.ts': ROUTES, 'src/app.ts': app(extra) });
    return (await problemJson.run(ctx)).filter((f) => f.status === 'skip').map((f) => f.skipReason ?? '').filter((s) => s.includes('did not find'));
  };

  const runtimeSkips = async (files: Record<string, string>): Promise<string[]> => {
    const ctx = await api(files);
    return (await problemJson.run(ctx)).filter((f) => f.status === 'skip').map((f) => f.skipReason ?? '');
  };

  it('a router mounted only on an app that is not the one served: its routes were judged but are not served', async () => {
    const skips = await runtimeSkips({
      'src/routes.ts': ROUTES,
      'src/admin.ts': "import express, { Router } from 'express';\nimport { z } from 'zod';\nconst admin = Router();\nadmin.get('/v1/audits', (_req, res) => { res.json(z.array(z.string()).parse([])); });\nexport const adminApp = express();\nadminApp.use(admin);\n",
      'src/app.ts': app(''),
    });
    expect(skips.filter((s) => s.includes('does not serve routes the static analysis judged') && s.includes('GET /v1/audits'))).toHaveLength(1);
  }, 120_000);

  it('blanket authentication answers every probe before the route: UNPROVEN, not passed', async () => {
    const skips = await runtimeSkips({
      'src/routes.ts': ROUTES,
      'src/app.ts': `import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { HttpProblem } from './lib/problem.js';
import { r } from './routes.js';
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => { next(new HttpProblem({ type: 'https://api.sf/problems/unauthorized', title: 'Unauthorized', status: 401, detail: 'no credentials' })); });
  app.use(r);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
`,
    });
    expect(skips.some((s) => s.includes('before reaching the route (authentication)'))).toBe(true);
  }, 120_000);

  it('app.all(...) is not a route the analysis models: UNPROVEN from the runtime listing; without it nothing is withheld', async () => {
    expect(await listedSkip('')).toEqual([]);
    const skips = await listedSkip("app.all('/v1/everythings', (_req, res) => { res.status(204).end(); });");
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('ALL /v1/everythings');
  }, 120_000);
});

describe('a parse counts only when it validates', () => {
  // [name, schema expression (declared as S<i>, typed `{ name: string }`), handler body using `S`, expected: ok | the violation it must name]
  const CASES: Array<[string, string, string, string]> = [
    ['checked safeParse', 'z.object({ name: z.string() })', "const p = S.safeParse(req.body);\n  if (!p.success) throw badRequest('bad');\n  res.status(201).location('/v1/xs/1').json(Out.parse({ id: '1', name: p.data.name }));", 'ok'],
    ['unchecked safeParse', 'z.object({ name: z.string() })', "const p = S.safeParse(req.body);\n  res.status(201).location('/v1/xs/1').json(Out.parse({ id: '1', name: (p.data as { name: string }).name }));", 'request body is not parsed'],
    ['.catch fallback', "z.object({ name: z.string() }).catch({ name: 'anon' })", "const b = S.parse(req.body);\n  res.status(201).location('/v1/xs/1').json(Out.parse({ id: '1', name: b.name }));", '.catch'],
    ['typed z.any()', 'z.any()', "const b = S.parse(req.body);\n  res.status(201).location('/v1/xs/1').json(Out.parse({ id: '1', name: b.name }));", 'z.any()'],
    ['z.any().transform', 'z.any().transform((v) => v as { name: string })', "const b = S.parse(req.body);\n  res.status(201).location('/v1/xs/1').json(Out.parse({ id: '1', name: b.name }));", 'z.any()'],
  ];
  let findings: CheckFinding[];
  beforeAll(async () => {
    const routes = CASES.map(([, decl, b], i) => `const S${i}: z.ZodType<{ name: string }> = ${decl};\nr.post('/v1/c${i}-xs', (req, res) => {\n  ${b.replaceAll('S.', `S${i}.`)}\n});`).join('\n');
    const ctx = await api({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from './lib/problem.js';
const Out = z.object({ id: z.string(), name: z.string() });
export const r = Router();
${routes}
`,
      ...mountApp(),
    });
    findings = await zodBoundary.run(ctx);
  });

  it.each(CASES.map(([name, , , want], i) => [name, want, i] as const))('%s → %s', (_name, want, i) => {
    const label = `POST /v1/c${i}-xs:`;
    const msgs = findings.flatMap((f) => f.violations).map((v) => v.message).filter((m) => m.startsWith(label));
    if (want === 'ok') expect(msgs).toEqual([]);
    else expect(msgs.some((m) => m.includes(want)), `${msgs.join('\n')}\n${JSON.stringify(findings.filter((f) => f.status === 'skip'))}`).toBe(true);
  });
});

describe('errors thrown below the handler', () => {
  it('a service the handler calls that throws a plain Error or a non-error value fails; an explicit problem passes', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from './lib/problem.js';
const Item = z.object({ id: z.string() });
const Params = z.object({ itemId: z.string() });
const items = new Map<string, z.infer<typeof Item>>();
function plain(id: string): void { if (items.has(id)) throw new Error('duplicate'); }
function literal(id: string): void { if (items.has(id)) throw { status: 409 }; }
function problem(id: string): void { if (items.has(id)) throw conflict('duplicate'); }
export const r = Router();
r.get('/v1/as/:itemId', (req, res) => { const { itemId } = Params.parse(req.params); plain(itemId); const it = items.get(itemId); if (it === undefined) throw notFound('x'); res.json(Item.parse(it)); });
r.get('/v1/bs/:itemId', (req, res) => { const { itemId } = Params.parse(req.params); literal(itemId); const it = items.get(itemId); if (it === undefined) throw notFound('x'); res.json(Item.parse(it)); });
r.get('/v1/cs/:itemId', (req, res) => { const { itemId } = Params.parse(req.params); problem(itemId); const it = items.get(itemId); if (it === undefined) throw notFound('x'); res.json(Item.parse(it)); });
`,
      ...mountApp(),
    });
    const { staticProblemFindings } = await import('../../plugins/checks/problem-json.ts');
    const msgs = staticProblemFindings(ctx).flatMap((f) => f.violations).map((v) => v.message);
    expect(msgs.some((m) => m.startsWith('GET /v1/as/:itemId: new Error(...) (in plain the handler calls)'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('GET /v1/bs/:itemId: throw { status: 409 } (in literal the handler calls)'))).toBe(true);
    expect(msgs.filter((m) => m.startsWith('GET /v1/cs/'))).toEqual([]);
  });
});
