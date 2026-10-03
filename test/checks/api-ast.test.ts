import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  extractRoutes,
  hasPathParams,
  isCollectionPath,
  isZodSchemaType,
  joinPaths,
  location,
  propertyType,
} from '../../plugins/lib/api-ast.ts';
import type { RouteInfo } from '../../plugins/lib/api-ast.ts';
import { contextFor, fixtureContext, lineOf, removeTempApi, tempApi } from './_ctx.ts';

async function routesOf(fixture: string): Promise<{ routes: RouteInfo[]; checker: ts.TypeChecker; root: string }> {
  const ctx = await fixtureContext(fixture);
  const program = ctx.program();
  return { routes: extractRoutes(program, ctx.root, ctx.sourceFiles), checker: program.getTypeChecker(), root: ctx.root };
}

function find(routes: RouteInfo[], method: string, path: string): RouteInfo {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`route ${method} ${path} not found in ${routes.map((x) => `${x.method} ${x.path}`).join(', ')}`);
  return r;
}

describe('extractRoutes on the good fixture', () => {
  it('finds the five user routes with registration locations', async () => {
    const { routes } = await routesOf('good');
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'get /v1/users',
      'post /v1/users',
      'get /v1/users/:userId',
      'patch /v1/users/:userId',
      'delete /v1/users/:userId',
    ]);
    const post = find(routes, 'post', '/v1/users');
    expect(post.file).toBe('src/routes/users.ts');
    expect(post.line).toBe(lineOf('good', 'src/routes/users.ts', "usersRouter.post('/v1/users'"));
    expect(post.column).toBe(3);
    expect(post.middleware.map((m) => m.getText())).toEqual(['idempotency()']);
    expect(post.reqName).toBe('req');
    expect(post.resName).toBe('res');
    expect(post.handler).toBeDefined();
  });

  it('records parse sites with the schema module, export name and parsed type', async () => {
    const { routes, checker } = await routesOf('good');
    const post = find(routes, 'post', '/v1/users');
    expect(post.unparsedReads).toEqual([]);
    // the handler's own parse first, then the idempotency() middleware's parse of req.headers (chain parses count)
    expect(post.parses.map((p) => p.target)).toEqual(['body', 'headers']);
    const [site] = post.parses;
    expect(site?.target).toBe('body');
    expect(site?.schema.text).toBe('CreateUserSchema');
    expect(site?.schema.module).toBe('src/schemas/users.ts');
    expect(site?.schema.exportName).toBe('CreateUserSchema');
    const t = site?.schema.parsedType;
    expect(t).toBeDefined();
    if (t !== undefined && site !== undefined) {
      expect(propertyType(checker, t, 'email', site.call)).toBeDefined();
      expect(propertyType(checker, t, 'nope', site.call)).toBeUndefined();
    }
    const list = find(routes, 'get', '/v1/users');
    const q = list.parses.find((p) => p.target === 'query');
    expect(q?.schema.exportName).toBe('ListUsersQuerySchema');
    if (q?.schema.parsedType !== undefined) {
      for (const k of ['cursor', 'limit']) expect(propertyType(checker, q.schema.parsedType, k, q.call)).toBeDefined();
    }
  });

  it('records responses, status literals and problem sites', async () => {
    const { routes } = await routesOf('good');
    const post = find(routes, 'post', '/v1/users');
    expect(post.responses.map((r) => [r.status, r.hasBody, r.schema?.text, r.isProblem])).toEqual([[201, true, 'UserSchema', false]]);
    expect(post.statusLiterals.map((s) => s.status)).toEqual([201]);
    const patch = find(routes, 'patch', '/v1/users/:userId');
    // body is a const initialised with UserSchema.parse(...)
    expect(patch.responses.map((r) => [r.status, r.schema?.text])).toEqual([[200, 'UserSchema']]);
    expect(patch.problemSites.map((p) => [p.name, p.status])).toEqual([['notFound', 404]]);
    const del = find(routes, 'delete', '/v1/users/:userId');
    expect(del.responses.map((r) => [r.status, r.hasBody])).toEqual([[204, false]]);
    expect(del.statusLiterals.map((s) => s.status).sort()).toEqual([204, 404]);
  });
});

describe('extractRoutes: mounts, route() chains and identifier handlers', () => {
  it('applies app.use/router.use prefixes through router factories', async () => {
    const { routes } = await routesOf('mounted');
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'get /v1/gadgets',
      'get /v1/widgets',
      'get /v1/widgets/:widgetId',
      'post /v1/gadgets',
    ]);
  });

  it('resolves handlers passed by name (const arrow and function declaration)', async () => {
    const { routes } = await routesOf('mounted');
    const post = find(routes, 'post', '/v1/gadgets');
    expect(post.handler).toBeDefined();
    expect(post.middleware.map((m) => m.getText())).toEqual(['idempotency()']);
    expect(post.parses.map((p) => p.target)).toEqual(['body', 'headers']); // + the idempotency() middleware's header parse
    expect(post.responses.map((r) => r.status)).toEqual([201]);
    const get = find(routes, 'get', '/v1/gadgets');
    expect(get.parses.map((p) => p.target)).toEqual(['query']);
  });
});

describe('extractRoutes: reads, receivers and escapes', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await removeTempApi(r);
  });

  it('flags unparsed, destructured and non-Zod reads and ignores non-Express receivers', async () => {
    const root = await tempApi({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
const Body = z.object({ a: z.string() });
const fake = { parse: (v: unknown): unknown => v };
const cache = new Map<string, number>();
export const r = Router();
r.post('/v1/things', (req, res) => {
  const { body } = req;
  const ok = Body.parse(req.body);
  const notZod = fake.parse(req.query);
  const h = req.get('x-thing');
  res.status(201).json({ ok, notZod, h, body, n: cache.get('a') });
});
r.get('/v1/things/:thingId', (req, res) => {
  helper(res);
  res.json(Body.safeParse(req.params));
});
function helper(_res: unknown): void {}
const client = { get: (_p: string, _h: () => void): void => undefined };
client.get('/v1/not-a-route', () => undefined);
`,
    });
    roots.push(root);
    const ctx = await contextFor(root);
    const program = ctx.program();
    const routes = extractRoutes(program, root, ctx.sourceFiles);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['post /v1/things', 'get /v1/things/:thingId']);
    const [post, get] = routes;
    expect(post?.parses.map((p) => p.target)).toEqual(['body']);
    expect(post?.unparsedReads.map((u) => u.target)).toEqual(['req', 'query', 'headers']);
    expect(post?.responses[0]?.schema).toBeUndefined();
    expect(get?.parses.map((p) => p.target)).toEqual(['params']); // safeParse is an accepted parse
    expect(get?.resEscapes).toHaveLength(1);
    expect(get?.responses[0]?.schema).toBeUndefined(); // safeParse result is not a parsed body
  });

  it('resolves bound methods, class arrow properties, handler factories and toDto helpers; scope middleware respects order', async () => {
    const root = await tempApi(
      {
        'src/routes.ts': `import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpProblem, typeUri } from './lib/problem.js';
import { idempotency } from './lib/idempotency.js';
const Item = z.object({ id: z.string() });
const Params = z.object({ itemId: z.string() });
class ItemGone extends HttpProblem {
  constructor(id: string) {
    super({ type: typeUri('gone'), title: 'Not Found', status: 404, detail: id });
  }
}
function lookup(id: string): { id: string } {
  if (id === '') throw new ItemGone(id);
  return { id };
}
const toDto = (v: { id: string }) => Item.parse(v);
class Ctl {
  get = (req: Request, res: Response): void => {
    res.json(toDto(lookup(Params.parse(req.params).itemId)));
  };
  remove(req: Request, res: Response): void {
    lookup(z.string().parse(req.params.itemId));
    res.status(204).end();
  }
}
const make = (n: number) => (req: Request, res: Response): void => {
  res.status(201).json(Item.parse({ id: String(n), ...Item.parse(req.body) }));
};
const ctl = new Ctl();
export const r = Router();
r.get('/v1/items/:itemId', ctl.get);
r.delete('/v1/items/:itemId', ctl.remove.bind(ctl));
r.post('/v1/items', make(1));
r.use(idempotency());
r.patch('/v1/items/:itemId', make(2));
`,
      },
      { withLib: true },
    );
    roots.push(root);
    const ctx = await contextFor(root);
    const routes = extractRoutes(ctx.program(), root, ctx.sourceFiles);
    const get = find(routes, 'get', '/v1/items/:itemId');
    expect(get.handler).toBeDefined();
    expect(get.responses.map((x) => x.schema?.text)).toEqual(['Item']); // through toDto(...)
    expect(get.calleeProblemSites.map((p) => [p.name, p.status])).toEqual([['ItemGone', 404]]); // via lookup → super({ status: 404 })
    const del = find(routes, 'delete', '/v1/items/:itemId');
    expect(del.handler).toBeDefined();
    expect(del.parses.map((p) => p.target)).toEqual(['params']); // IdSchema.parse(req.params.itemId)
    expect(del.unparsedReads).toEqual([]);
    const post = find(routes, 'post', '/v1/items');
    expect(post.handler).toBeDefined();
    expect(post.parses.map((p) => p.target)).toEqual(['body']);
    // r.use(idempotency()) applies to routes registered after it only
    expect(post.scopeMiddleware).toEqual([]);
    expect(find(routes, 'patch', '/v1/items/:itemId').scopeMiddleware.map((m) => m.getText())).toEqual(['idempotency()']);
  });

  it('isZodSchemaType and location', async () => {
    const ctx = await fixtureContext('good');
    const program = ctx.program();
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(`${ctx.root}/src/schemas/users.ts`);
    expect(sf).toBeDefined();
    if (sf === undefined) return;
    let zodOk = false;
    let stringOk = true;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'UserSchema') {
        zodOk = isZodSchemaType(checker, checker.getTypeAtLocation(n.name));
        expect(location(ctx.root, n.name)).toBe(`src/schemas/users.ts:${lineOf('good', 'src/schemas/users.ts', 'export const UserSchema')}:14`);
      }
      if (ts.isStringLiteral(n)) stringOk = stringOk && !isZodSchemaType(checker, checker.getTypeAtLocation(n));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(zodOk).toBe(true);
    expect(stringOk).toBe(true);
  });

  it('path helpers', () => {
    expect(joinPaths('/v1', '/users')).toBe('/v1/users');
    expect(joinPaths('/v1/users/', '/')).toBe('/v1/users');
    expect(joinPaths('', '/x')).toBe('/x');
    expect(isCollectionPath('/v1/users')).toBe(true);
    expect(isCollectionPath('/v1/users/:id')).toBe(false);
    expect(hasPathParams('/v1/users/:id')).toBe(true);
  });
});
