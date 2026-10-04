/**
 * Program helpers on both sides of the boundary are followed by behaviour, not by name:
 * - request: `h(S, req.X)` (any argument order) is `S.parse(req.X)` when h demonstrably returns its parse of that
 *   parameter on every path (parse / parseAsync, or safeParse whose data is returned only on success);
 * - response: a helper given `res` is followed, its sends are the route's responses (statuses, Location and body
 *   schemas judged by the same rules); only `res` handed to code that cannot be followed is UNPROVEN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import zodBoundary from '../../plugins/checks/zod-boundary.ts';
import { extractRouteTable } from '../../plugins/lib/api-ast.ts';
import type { CheckContext, CheckFinding } from '../../src/core/plugin-api.ts';
import { contextFor, mountApp, removeTempApi, tempApi } from './_ctx.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTempApi(r);
});

async function api(files: Record<string, string>): Promise<CheckContext> {
  const root = await tempApi(files);
  roots.push(root);
  return contextFor(root);
}

function forRoute(findings: CheckFinding[], label: string): string[] {
  return findings.flatMap((f) => f.violations).filter((v) => v.message.startsWith(`${label}:`)).map((v) => `${v.location} ${v.message}`);
}

function unprovenFor(findings: CheckFinding[], label: string): string[] {
  return findings.filter((f) => f.status === 'skip' && (f.skipReason ?? '').includes(label)).map((f) => f.skipReason ?? '');
}

const SCHEMAS = `import { z } from 'zod';
export const Item = z.object({ id: z.string(), name: z.string() });
export const ItemBody = z.object({ name: z.string().min(1) });
export const ItemParams = z.object({ itemId: z.string().uuid() });
export const Query = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().default(20) });
export const Page = z.object({ data: z.array(Item), nextCursor: z.string().nullable() });
`;

const HELPERS = `import { z } from 'zod';
import type { Response } from 'express';
class Unprocessable extends Error { readonly type = 'about:blank'; readonly title = 'Unprocessable'; readonly status = 422; }
/** safeParse, failure throws: a parse. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Unprocessable(parsed.error.message);
  return parsed.data;
}
/** Value first, schema second, arrow form: a parse. */
export const parseWith = <T>(value: unknown, schema: z.ZodType<T>): T => schema.parse(value);
/** Async: a parse. */
export async function parseLater<T>(schema: z.ZodType<T>, value: unknown): Promise<T> { return schema.parseAsync(value); }
/** Success branch returns the data, the failure falls through to a throw: a parse. */
export function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new Unprocessable('invalid');
}
/** Returns the raw value: not a parse. */
export function trust<T>(_schema: z.ZodType<T>, value: unknown): T { return value as T; }
/** Parses only sometimes: not a parse. */
export function maybe<T>(schema: z.ZodType<T>, value: unknown, strict: boolean): T {
  if (strict) return schema.parse(value);
  return value as T;
}
/** safeParse whose data is returned whether or not it succeeded: not a parse. */
export function unchecked<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) console.warn(r.error.message);
  return r.data as T;
}
/** Parses its body with the given schema and sends it: followed. */
export function respond<T>(res: Response, status: 200 | 201, schema: z.ZodType<T>, body: unknown): void {
  res.status(status).json(schema.parse(body));
}
/** Sets 201 + Location itself, sends a parsed body: followed. */
export function created<T>(res: Response, schema: z.ZodType<T>, body: unknown, at: string): void {
  res.status(201).location(at).json(schema.parse(body));
}
/** Sends whatever it is given: the call site decides. */
export function send(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}
/** Sends a raw value. */
export function reply(res: Response, body: unknown): void {
  res.json(body);
}
`;

const ROUTES = `import { Router } from 'express';
import type { Response } from 'express';
import { Item, ItemBody, ItemParams, Page, Query } from './schemas.ts';
import { checked, created, maybe, parseLater, parseWith, reply, respond, send, trust, unchecked, validate } from './helpers.ts';
declare const store: { list(q: unknown): unknown; get(id: string): unknown; add(b: unknown): { id: string } };
declare function externalSend(res: Response, body: unknown): void;
declare function notFound(detail: string): Error & { type: string; title: string; status: 404 };
export const r = Router();
r.get('/v1/items', (req, res) => { const q = validate(Query, req.query); res.json(Page.parse(store.list(q))); });
r.post('/v1/items', async (req, res) => { const body = await parseLater(ItemBody, req.body); const it = store.add(body); created(res, Item, it, \`/v1/items/\${it.id}\`); });
r.get('/v1/items/:itemId', (req, res) => { const { itemId } = parseWith(req.params, ItemParams); respond(res, 200, Item, store.get(itemId)); });
r.patch('/v1/items/:itemId', (req, res) => { const p = checked(ItemParams, req.params); const b = validate(ItemBody, req.body); send(res, 200, Item.parse({ id: p.itemId, ...b })); });
r.get('/v1/raw/:itemId', (req, res) => { const p = trust(ItemParams, req.params); res.json(Item.parse(store.get(p.itemId))); });
r.get('/v1/sometimes/:itemId', (req, res) => { const p = maybe(ItemParams, req.params, false); res.json(Item.parse(store.get(p.itemId))); });
r.get('/v1/unchecked/:itemId', (req, res) => { const p = unchecked(ItemParams, req.params); res.json(Item.parse(store.get(p.itemId))); });
r.get('/v1/raw-send/:itemId', (req, res) => { const p = ItemParams.parse(req.params); reply(res, store.get(p.itemId)); });
r.get('/v1/raw-arg/:itemId', (req, res) => { const p = ItemParams.parse(req.params); send(res, 200, store.get(p.itemId)); });
r.get('/v1/external/:itemId', (req, res) => { const p = ItemParams.parse(req.params); externalSend(res, Item.parse(store.get(p.itemId))); });
r.post('/v1/carried', (req, res) => { const b = ItemBody.parse(req.body); const it = store.add(b); res.location(\`/v1/carried/\${it.id}\`).status(201); reply(res, Item.parse(it)); });
r.delete('/v1/externals/:itemId', (req, res) => { const p = ItemParams.parse(req.params); if (store.get(p.itemId) === undefined) throw notFound('gone'); externalSend(res, null); });
r.delete('/v1/items/:itemId', (req, res) => {
  const raw = req.params['itemId'];
  const value = typeof raw === 'string' ? raw : '';
  const parsed = ItemParams.safeParse({ itemId: value });
  if (!parsed.success) throw new Error('bad');
  res.status(204).end();
});
r.delete('/v1/leaky/:itemId', (req, res) => {
  const raw = req.params['itemId'];
  ItemParams.parse({ itemId: raw });
  store.get(String(raw));
  res.status(204).end();
});
`;

describe('program helpers are followed by behaviour', () => {
  let ctx: CheckContext;
  let zod: CheckFinding[];
  let rest: CheckFinding[];
  beforeAll(async () => {
    ctx = await api({ 'src/schemas.ts': SCHEMAS, 'src/helpers.ts': HELPERS, 'src/routes.ts': ROUTES, ...mountApp() });
    zod = await zodBoundary.run(ctx);
    rest = await restConventions.run(ctx);
  });

  it('a generic validate helper (safeParse + throw, any argument order, async, success branch) is the parse, with the schema output as its type', () => {
    for (const label of ['GET /v1/items', 'POST /v1/items', 'GET /v1/items/:itemId', 'PATCH /v1/items/:itemId']) {
      expect(forRoute(zod, label), label).toEqual([]);
      expect(unprovenFor(zod, `${label}:`), label).toEqual([]);
    }
    // The cursor query parsed through the helper satisfies cursor pagination.
    expect(forRoute(rest, 'GET /v1/items').filter((m) => m.includes('cursor'))).toEqual([]);
    // The request slot carries the call site's schema.
    const table = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles);
    const list = table.routes.find((x) => x.method === 'get' && x.path === '/v1/items');
    expect(list?.parses.map((p) => [p.target, p.schema.text])).toEqual([['query', 'Query']]);
    const post = table.routes.find((x) => x.method === 'post' && x.path === '/v1/items');
    expect(post?.parses.map((p) => [p.target, p.schema.text])).toEqual([['body', 'ItemBody']]);
  });

  it('a helper that returns the raw value, parses only sometimes, or returns unchecked safeParse data fails at the read', () => {
    const raw = forRoute(zod, 'GET /v1/raw/:itemId');
    expect(raw.some((m) => m.startsWith('src/routes.ts:13:') && m.includes('req.params is read without') && m.includes('trust() returns a value that is not its parse'))).toBe(true);
    const some = forRoute(zod, 'GET /v1/sometimes/:itemId');
    expect(some.some((m) => m.startsWith('src/routes.ts:14:') && m.includes('maybe() returns a value that is not its parse of the argument (at src/helpers.ts:25:'))).toBe(true);
    const unchecked = forRoute(zod, 'GET /v1/unchecked/:itemId');
    expect(unchecked.some((m) => m.includes('req.params is read without') && m.includes('unchecked() returns a value'))).toBe(true);
    for (const label of ['GET /v1/raw/:itemId', 'GET /v1/sometimes/:itemId', 'GET /v1/unchecked/:itemId']) {
      expect(forRoute(zod, label).some((m) => m.includes('path parameters are not parsed')), label).toBe(true);
    }
  });

  it('a helper given res that parses what it sends passes, including 201 + Location set inside it', () => {
    expect(forRoute(rest, 'POST /v1/items').filter((m) => m.includes('201') || m.includes('Location'))).toEqual([]);
    expect(forRoute(zod, 'GET /v1/items/:itemId')).toEqual([]);
    // A status set on res before handing it over carries into the helper's send.
    expect(forRoute(rest, 'POST /v1/carried').filter((m) => m.includes('201') || m.includes('Location'))).toEqual([]);
    expect(forRoute(zod, 'POST /v1/carried')).toEqual([]);
  });

  it('a helper given res that sends a raw body fails at its send, naming the call', () => {
    const msgs = forRoute(zod, 'GET /v1/raw-send/:itemId');
    expect(msgs.some((m) => m.startsWith('src/helpers.ts:47:') && m.includes('response body is not parsed') && m.includes('reply(), called at src/routes.ts:16:'))).toBe(true);
    expect(forRoute(zod, 'GET /v1/raw-arg/:itemId').some((m) => m.includes('response body is not parsed') && m.includes('send(), called at src/routes.ts:17:'))).toBe(true);
    expect(msgs.some((m) => m.includes('passed along'))).toBe(false);
  });

  it('res handed to a helper that cannot be followed is UNPROVEN, not FAIL', () => {
    expect(forRoute(zod, 'GET /v1/external/:itemId')).toEqual([]);
    expect(unprovenFor(zod, 'GET /v1/external/:itemId:').some((m) => m.includes('externalSend(), which cannot be followed'))).toBe(true);
    // Its DELETE status cannot be known: unproven rather than "DELETE must respond 204".
    expect(forRoute(rest, 'DELETE /v1/externals/:itemId')).toEqual([]);
    expect(unprovenFor(rest, 'DELETE /v1/externals/:itemId').some((m) => m.includes('externalSend()'))).toBe(true);
  });

  it('a raw member read whose every use feeds a parse counts as parsed; one also used elsewhere does not', () => {
    expect(forRoute(zod, 'DELETE /v1/items/:itemId')).toEqual([]);
    const leaky = forRoute(zod, 'DELETE /v1/leaky/:itemId');
    expect(leaky.some((m) => m.includes('req.params is read without'))).toBe(true);
  });
});
