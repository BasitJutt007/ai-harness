/**
 * rest-conventions accepts an idempotency store only when it outlives the request. "The request" is the
 * request function plus every function the analysis follows from it, so helpers, closures, methods and
 * wrappers never get a fresh lifetime boundary of their own. A matrix of real layouts: every store created
 * once (module or middleware-factory scope) passes; every store created, re-created or of unknown origin
 * per request never passes. Each row is also RUN: two identical keyed POSTs against the real app, and the
 * checker's verdict must match the behaviour (passes ⇔ the second response replays the first).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Router } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import { contextFor, removeTempApi, tempApi } from './_ctx.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTempApi(r);
});

const HEAD = `import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
type ItemT = z.infer<typeof Item>;
const Headers = z.object({ 'idempotency-key': z.string().optional() });
function makeStore(): Map<string, ItemT> { return new Map(); }
void makeStore;
let created = 0;
`;

/**
 * A middleware factory `idem` (its body runs once, at route registration) returning the request function.
 * `factory` goes in the factory body, `request` at the start of the request function; `lookup(key)` and
 * `save(key, value)` are expressions the request function uses.
 */
function api(opts: { top?: string; factory?: string; request?: string; lookup: string; save: string; factoryArgs?: string; factoryParams?: string }): string {
  return `${HEAD}${opts.top ?? ''}
function idem(${opts.factoryParams ?? ''}): RequestHandler {
${opts.factory ?? ''}
  return (req, res, next) => {
${opts.request ?? ''}
    const key = Headers.parse(req.headers)['idempotency-key'];
    const hit = key !== undefined ? ${opts.lookup} : undefined;
    if (hit !== undefined) {
      res.status(201).location(\`/v1/items/\${hit.id}\`).json(Item.parse(hit));
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const value = Item.parse(body);
      if (key !== undefined) ${opts.save};
      return json(value);
    };
    next();
  };
}
export const r = Router();
r.post('/v1/items', idem(${opts.factoryArgs ?? ''}), (req, res) => {
  created += 1;
  const body = Item.parse({ id: \`\${Item.parse(req.body).id}-\${String(created)}\` });
  res.status(201).location(\`/v1/items/\${body.id}\`).json(Item.parse(body));
});
`;
}

const MAP = 'new Map<string, ItemT>()';
const CLASS = `class Cache {
  private readonly items = ${MAP};
  find(key: string): ItemT | undefined { return this.items.get(key); }
  save(key: string, value: ItemT): void { this.items.set(key, value); }
}
`;
const HELPERS = `function recall(store: Map<string, ItemT>, key: string): ItemT | undefined { return store.get(key); }
function remember(store: Map<string, ItemT>, key: string, value: ItemT): void { store.set(key, value); }
`;

interface Outcome {
  /** The checker's verdict on the route's idempotency. */
  verdict: 'pass' | 'not pass';
  /** Running the app: a second POST with the same key and body returned the first response. */
  replays: boolean;
}

async function outcome(source: string): Promise<Outcome> {
  const root = await tempApi({ 'src/routes.ts': source });
  roots.push(root);
  const findings = await restConventions.run(await contextFor(root));
  const text = findings.map((f) => `${f.status} ${f.skipReason ?? ''} ${f.violations.map((v) => v.message).join(' | ')}`).join('\n');
  // The route was analysed: a passing route has counted units; an unproven one a skip finding naming the POST.
  expect(findings.some((f) => f.units.total > 0) || /POST \/v1\/items/.test(text), text).toBe(true);
  const mod: unknown = await import(pathToFileURL(join(root, 'src', 'routes.ts')).href);
  const router = (mod as { r: Router }).r;
  const app = express();
  app.use(express.json());
  app.use(router);
  const send = () => request(app).post('/v1/items').set('Idempotency-Key', 'k1').send({ id: 'x' });
  const first = await send();
  const second = await send();
  expect(first.status).toBe(201);
  return {
    verdict: /Idempotency-Key|idempotency/.test(text) ? 'not pass' : 'pass',
    replays: second.status === 201 && JSON.stringify(second.body) === JSON.stringify(first.body),
  };
}

describe('idempotency store lifetime: created once → passes', () => {
  it.each([
    ['module-level store', api({ top: `const S = ${MAP};\n`, lookup: 'S.get(key)', save: 'S.set(key, value)' })],
    ['middleware-factory store', api({ factory: `  const S = ${MAP};`, lookup: 'S.get(key)', save: 'S.set(key, value)' })],
    ['property of a module-level holder', api({ top: `const holder = { store: ${MAP} };\n`, lookup: 'holder.store.get(key)', save: 'holder.store.set(key, value)' })],
    ['request-local alias of a factory store', api({ factory: `  const shared = ${MAP};`, request: '    const S = shared;', lookup: 'S.get(key)', save: 'S.set(key, value)' })],
    ['factory store passed into module-level helpers', api({ top: HELPERS, factory: `  const S = ${MAP};`, lookup: 'recall(S, key)', save: 'remember(S, key, value)' })],
    ['closure in the request function capturing a factory store', api({ factory: `  const S = ${MAP};`, request: '    function put(k: string, v: ItemT): void { S.set(k, v); }', lookup: 'S.get(key)', save: 'put(key, value)' })],
    ['module-level instance whose methods use this', api({ top: `${CLASS}const cache = new Cache();\n`, lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
    ['store passed into the middleware factory', api({ top: `const shared = ${MAP};\n`, factoryParams: 'S: Map<string, ItemT>', factoryArgs: 'shared', lookup: 'S.get(key)', save: 'S.set(key, value)' })],
  ])('%s', async (_label, source) => {
    expect(await outcome(source)).toEqual({ verdict: 'pass', replays: true });
  });
});

describe('idempotency store lifetime: created per request or of unknown origin → never passes', () => {
  it.each([
    ['store created in the request function', api({ request: `    const S = ${MAP};`, lookup: 'S.get(key)', save: 'S.set(key, value)' })],
    ['wrapped store created in the request function', api({ request: `    const holder = { store: ${MAP} };`, lookup: 'holder.store.get(key)', save: 'holder.store.set(key, value)' })],
    ['closure capturing a request-local store', api({ request: `    const S = ${MAP};\n    function put(k: string, v: ItemT): void { S.set(k, v); }`, lookup: 'S.get(key)', save: 'put(key, value)' })],
    ['request-local store passed into helpers', api({ top: HELPERS, request: `    const S = ${MAP};`, lookup: 'recall(S, key)', save: 'remember(S, key, value)' })],
    ['closure passing a request-local store into a helper', api({ top: HELPERS, request: `    const S = ${MAP};\n    const put = (k: string, v: ItemT): void => remember(S, k, v);`, lookup: 'recall(S, key)', save: 'put(key, value)' })],
    ['request-local instance whose methods use this', api({ top: CLASS, request: '    const cache = new Cache();', lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
    ['module-level let re-created by every request', api({ top: `let S = ${MAP};\n`, request: `    S = ${MAP};`, lookup: 'S.get(key)', save: 'S.set(key, value)' })],
    ['module-level holder whose store every request replaces', api({ top: `const holder = { store: ${MAP} };\n`, request: `    holder.store = ${MAP};`, lookup: 'holder.store.get(key)', save: 'holder.store.set(key, value)' })],
    ['store returned by a call in the request function (unknown)', api({ request: '    const S = makeStore();', lookup: 'S.get(key)', save: 'S.set(key, value)' })],
    ['closure returned by a helper the request function calls (unknown)', api({
      top: `function makeSaver(): (k: string, v: ItemT) => void { const S = ${MAP}; return (k, v) => { S.set(k, v); }; }\nconst lookups = ${MAP};\n`,
      request: '    const put = makeSaver();',
      lookup: 'lookups.get(key)',
      save: 'put(key, value)',
    })],
    ['store hung on the request object', api({ request: `    const bag = req as unknown as { cache: Map<string, ItemT> };\n    bag.cache = ${MAP};`, lookup: 'bag.cache.get(key)', save: 'bag.cache.set(key, value)' })],
  ])('%s', async (_label, source) => {
    expect(await outcome(source)).toEqual({ verdict: 'not pass', replays: false });
  });
});
