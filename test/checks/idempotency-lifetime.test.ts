/**
 * rest-conventions accepts an idempotency store only when it is ONE object, created once, that nothing
 * replaces, empties or leaks during a request, and the replayed response is read from that same object. The
 * analysis tracks objects, not names (store-identity.ts): aliases, properties, nested holders, destructuring,
 * helper parameters, closures and `this` all lead to the same abstract object, and a replacement through any
 * of them counts. "The request" is the request function plus every function followed from it, so helpers,
 * closures, methods and wrappers never get a fresh lifetime boundary of their own.
 *
 * Every row is RUN as well: two identical keyed POSTs against the real app, and the checker's verdict must
 * match the behaviour (passes ⇔ the second response replays the first). The rows come in PAIRED FAMILIES:
 * each broken layout next to a working control that differs only in the breaking statement. Rows the
 * analysis cannot establish (an object handed to code it cannot see) must be UNPROVEN, never pass, whatever
 * they do at runtime: those are listed separately.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Router } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import { extractRouteTable } from '../../plugins/lib/api-ast.ts';
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
/** The same cache with a method that replaces its map. */
const RESETTABLE = `class Cache {
  private items = ${MAP};
  find(key: string): ItemT | undefined { return this.items.get(key); }
  save(key: string, value: ItemT): void { this.items.set(key, value); }
  reset(): void { this.items = ${MAP}; }
}
`;
const HELPERS = `function recall(store: Map<string, ItemT>, key: string): ItemT | undefined { return store.get(key); }
function remember(store: Map<string, ItemT>, key: string, value: ItemT): void { store.set(key, value); }
`;
const HOLDER = `  const holder = { store: ${MAP} };`;
const VIA_S = { lookup: 'S.get(key)', save: 'S.set(key, value)' };
const VIA_HOLDER = { lookup: 'holder.store.get(key)', save: 'holder.store.set(key, value)' };
const NESTED = { factory: `  const holder = { a: { b: { store: ${MAP} } } };`, lookup: 'holder.a.b.store.get(key)', save: 'holder.a.b.store.set(key, value)' };

interface Outcome {
  /** The checker's verdict on the route's idempotency. */
  verdict: 'pass' | 'not pass';
  /** The route is UNPROVEN (a skip finding names it). */
  unproven: boolean;
  /** Running the app: a second POST with the same key and body returned the first response. */
  replays: boolean;
}

async function outcome(source: string, extra: Record<string, string> = {}): Promise<Outcome> {
  // A runnable app: rest-conventions confirms a statically accepted replay at runtime (unconfirmed = UNPROVEN).
  const appSource = "import express, { type Express } from 'express';\nimport { r } from './routes.js';\nexport function createApp(): Express {\n  const app = express();\n  app.use(express.json());\n  app.use(r);\n  return app;\n}\n";
  const root = await tempApi({ 'src/routes.ts': source, 'src/app.ts': appSource, ...extra });
  roots.push(root);
  const ctx = await contextFor(root);
  const findings = await restConventions.run(ctx);
  const post = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).all.find((x) => x.method === 'post' && x.path === '/v1/items');
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
    // The static analysis itself admitted it cannot establish the store (independent of the runtime probe's verdict).
    unproven: post?.idempotencyUse === 'unproven',
    replays: second.status === 201 && JSON.stringify(second.body) === JSON.stringify(first.body),
  };
}

const passes = async (source: string, extra?: Record<string, string>): Promise<void> => {
  expect(await outcome(source, extra)).toMatchObject({ verdict: 'pass', replays: true });
};
const neverPasses = async (source: string, extra?: Record<string, string>): Promise<void> => {
  expect(await outcome(source, extra)).toMatchObject({ verdict: 'not pass', replays: false });
};

describe('idempotency store lifetime: created once → passes', () => {
  it.each([
    ['module-level store', api({ top: `const S = ${MAP};\n`, ...VIA_S })],
    ['middleware-factory store', api({ factory: `  const S = ${MAP};`, ...VIA_S })],
    ['property of a module-level holder', api({ top: `const holder = { store: ${MAP} };\n`, ...VIA_HOLDER })],
    ['request-local alias of a factory store', api({ factory: `  const shared = ${MAP};`, request: '    const S = shared;', ...VIA_S })],
    ['factory store passed into module-level helpers', api({ top: HELPERS, factory: `  const S = ${MAP};`, lookup: 'recall(S, key)', save: 'remember(S, key, value)' })],
    ['closure in the request function capturing a factory store', api({ factory: `  const S = ${MAP};`, request: '    function put(k: string, v: ItemT): void { S.set(k, v); }', lookup: 'S.get(key)', save: 'put(key, value)' })],
    ['module-level instance whose methods use this', api({ top: `${CLASS}const cache = new Cache();\n`, lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
    ['store passed into the middleware factory', api({ top: `const shared = ${MAP};\n`, factoryParams: 'S: Map<string, ItemT>', factoryArgs: 'shared', ...VIA_S })],
    ['factory store made by a helper the factory calls once', api({ factory: '  const S = makeStore();', ...VIA_S })],
  ])('%s', async (_label, source) => {
    await passes(source);
  });
});

describe('idempotency store lifetime: created per request or of unknown origin → never passes', () => {
  it.each([
    ['store created in the request function', api({ request: `    const S = ${MAP};`, ...VIA_S })],
    ['wrapped store created in the request function', api({ request: `    const holder = { store: ${MAP} };`, ...VIA_HOLDER })],
    ['closure capturing a request-local store', api({ request: `    const S = ${MAP};\n    function put(k: string, v: ItemT): void { S.set(k, v); }`, lookup: 'S.get(key)', save: 'put(key, value)' })],
    ['request-local store passed into helpers', api({ top: HELPERS, request: `    const S = ${MAP};`, lookup: 'recall(S, key)', save: 'remember(S, key, value)' })],
    ['closure passing a request-local store into a helper', api({ top: HELPERS, request: `    const S = ${MAP};\n    const put = (k: string, v: ItemT): void => remember(S, k, v);`, lookup: 'recall(S, key)', save: 'put(key, value)' })],
    ['request-local instance whose methods use this', api({ top: CLASS, request: '    const cache = new Cache();', lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
    ['module-level let re-created by every request', api({ top: `let S = ${MAP};\n`, request: `    S = ${MAP};`, ...VIA_S })],
    ['module-level holder whose store every request replaces', api({ top: `const holder = { store: ${MAP} };\n`, request: `    holder.store = ${MAP};`, ...VIA_HOLDER })],
    ['store returned by a call in the request function', api({ request: '    const S = makeStore();', ...VIA_S })],
    ['closure returned by a helper the request function calls (unknown)', api({
      top: `function makeSaver(): (k: string, v: ItemT) => void { const S = ${MAP}; return (k, v) => { S.set(k, v); }; }\nconst lookups = ${MAP};\n`,
      request: '    const put = makeSaver();',
      lookup: 'lookups.get(key)',
      save: 'put(key, value)',
    })],
    ['store hung on the request object', api({ request: `    const bag = req as unknown as { cache: Map<string, ItemT> };\n    bag.cache = ${MAP};`, lookup: 'bag.cache.get(key)', save: 'bag.cache.set(key, value)' })],
  ])('%s', async (_label, source) => {
    await neverPasses(source);
  });
});

/**
 * Paired families: [label, broken layout, working control]. The control differs only in the statement that
 * breaks the broken one (or in the object the statement touches).
 */
type Family = [string, string, string];
const FAMILIES: Record<string, Family[]> = {
  'direct': [
    ['factory let re-created per request', api({ factory: `  let S = ${MAP};`, request: `    S = ${MAP};`, ...VIA_S }), api({ factory: `  let S = ${MAP};`, request: '    void S;', ...VIA_S })],
    ['store re-created by ??= after a per-request reset', api({ factory: `  let S: Map<string, ItemT> | undefined = ${MAP};`, request: `    S = undefined;\n    S ??= ${MAP};`, lookup: 'S?.get(key)', save: 'S?.set(key, value)' }),
      api({ factory: `  let S: Map<string, ItemT> | undefined = ${MAP};`, request: '    void S;', lookup: 'S?.get(key)', save: 'S?.set(key, value)' })],
  ],
  'alias chains': [
    ['the reviewer\'s shape: replaced through another name, saved by a nested function',
      api({ factory: HOLDER, request: `    const alias = holder;\n    alias.store = ${MAP};\n    const store = holder.store;\n    function save(k: string, v: ItemT): void { store.set(k, v); }`, lookup: 'store.get(key)', save: 'save(key, value)' }),
      api({ factory: HOLDER, request: '    const alias = holder;\n    void alias;\n    const store = holder.store;\n    function save(k: string, v: ItemT): void { store.set(k, v); }', lookup: 'store.get(key)', save: 'save(key, value)' })],
    ['replaced through the third name of a chain', api({ factory: HOLDER, request: `    const a = holder;\n    const b = a;\n    const c = b;\n    c.store = ${MAP};\n    const S = holder.store;`, ...VIA_S }),
      api({ factory: HOLDER, request: '    const a = holder;\n    const b = a;\n    const c = b;\n    void c;\n    const S = holder.store;', ...VIA_S })],
    ['replaced through the middle name, read through the last', api({ factory: HOLDER, request: `    const a = holder;\n    const b = a;\n    b.store = ${MAP};\n    const S = a.store;`, ...VIA_S }),
      api({ factory: HOLDER, request: '    const a = holder;\n    const b = a;\n    const S = b.store;', ...VIA_S })],
    ['module-level alias replaced per request', api({ top: `const holder = { store: ${MAP} };\nconst shared = holder;\n`, request: `    shared.store = ${MAP};`, ...VIA_HOLDER }),
      api({ top: `const holder = { store: ${MAP} };\nconst shared = holder;\n`, request: '    void shared.store.size;', ...VIA_HOLDER })],
  ],
  'property paths and nested holders': [
    ['the outer member replaced', api({ ...NESTED, request: `    holder.a = { b: { store: ${MAP} } };` }), api({ ...NESTED, request: '    void holder.a;' })],
    ['the middle member replaced through an alias of the outer one', api({ ...NESTED, request: `    const inner = holder.a;\n    inner.b = { store: ${MAP} };` }), api({ ...NESTED, request: '    const inner = holder.a;\n    void inner.b;' })],
    ['the store itself replaced at the end of the path', api({ ...NESTED, request: `    holder.a.b.store = ${MAP};` }), api({ ...NESTED, request: '    void holder.a.b.store.size;' })],
    ['a computed member write on a holder', api({ factory: HOLDER, request: `    const name = 'store' as 'store';\n    holder[name] = ${MAP};`, ...VIA_HOLDER }),
      api({ factory: `  const holder: { store: Map<string, ItemT>; [k: string]: unknown } = { store: ${MAP} };`, request: "    holder['seen'] = true;", ...VIA_HOLDER })],
  ],
  'destructuring': [
    ['destructured after holder.store is replaced', api({ factory: HOLDER, request: `    holder.store = ${MAP};\n    const { store: S } = holder;`, ...VIA_S }), api({ factory: HOLDER, request: '    const { store: S } = holder;', ...VIA_S })],
    ['the holder member replaced by a destructuring assignment', api({ factory: HOLDER, request: `    ({ store: holder.store } = { store: ${MAP} });\n    const { store } = holder;`, lookup: 'store.get(key)', save: 'store.set(key, value)' }),
      api({ factory: HOLDER, request: `    let other: Map<string, ItemT>;\n    ({ store: other } = { store: ${MAP} });\n    void other;\n    const { store } = holder;`, lookup: 'store.get(key)', save: 'store.set(key, value)' })],
  ],
  'helper parameters': [
    ['the holder passed to a helper that replaces its store', api({ top: `function renew(h: { store: Map<string, ItemT> }): void { h.store = ${MAP}; }\n`, factory: HOLDER, request: '    renew(holder);\n    const S = holder.store;', ...VIA_S }),
      api({ top: 'function size(h: { store: Map<string, ItemT> }): number { return h.store.size; }\n', factory: HOLDER, request: '    void size(holder);\n    const S = holder.store;', ...VIA_S })],
    ['the store passed to a helper that clears it', api({ top: 'function wipe(m: Map<string, ItemT>): void { m.clear(); }\n', factory: `  const S = ${MAP};`, request: '    wipe(S);', ...VIA_S }),
      api({ top: 'function count(m: Map<string, ItemT>): number { return m.size; }\n', factory: `  const S = ${MAP};`, request: '    void count(S);', ...VIA_S })],
    ['the holder destructured by a helper that replaces through its own alias', api({ top: `function renew({ box }: { box: { store: Map<string, ItemT> } }): void { const b = box; b.store = ${MAP}; }\n`, factory: HOLDER, request: '    renew({ box: holder });\n    const S = holder.store;', ...VIA_S }),
      api({ top: 'function peek({ box }: { box: { store: Map<string, ItemT> } }): number { const b = box; return b.store.size; }\n', factory: HOLDER, request: '    void peek({ box: holder });\n    const S = holder.store;', ...VIA_S })],
  ],
  'nested closures': [
    ['a closure in the request function replaces the store', api({ factory: HOLDER, request: `    const renew = (): void => { holder.store = ${MAP}; };\n    renew();\n    const S = holder.store;`, ...VIA_S }),
      api({ factory: HOLDER, request: '    const peek = (): number => holder.store.size;\n    void peek();\n    const S = holder.store;', ...VIA_S })],
    ['a closure two levels down replaces the store', api({ factory: HOLDER, request: `    function outer(): void { function inner(): void { holder.store = ${MAP}; } inner(); }\n    outer();\n    const S = holder.store;`, ...VIA_S }),
      api({ factory: HOLDER, request: '    function outer(): number { function inner(): number { return holder.store.size; } return inner(); }\n    void outer();\n    const S = holder.store;', ...VIA_S })],
  ],
  'methods and this': [
    ['a method replacing this.items, called per request', api({ top: `${RESETTABLE}const cache = new Cache();\n`, request: '    cache.reset();', lookup: 'cache.find(key)', save: 'cache.save(key, value)' }),
      api({ top: `${CLASS}const cache = new Cache();\n`, request: '    void cache;', lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
    ['a method of the store object replaced per request', api({ top: `${CLASS}const cache = new Cache();\n`, request: '    cache.find = (): ItemT | undefined => undefined;', lookup: 'cache.find(key)', save: 'cache.save(key, value)' }),
      api({ top: `${CLASS}const cache = new Cache();\n`, request: '    void cache.find;', lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
    ['an instance created per request vs once in the factory', api({ top: CLASS, request: '    const cache = new Cache();', lookup: 'cache.find(key)', save: 'cache.save(key, value)' }),
      api({ top: CLASS, factory: '  const cache = new Cache();', lookup: 'cache.find(key)', save: 'cache.save(key, value)' })],
  ],
  'clearing vs single-key cleanup': [
    ['.clear() per request', api({ factory: `  const S = ${MAP};`, request: '    S.clear();', ...VIA_S }),
      api({ factory: `  const S = ${MAP};`, request: '    res.on(\'finish\', () => { if (res.statusCode >= 400 && key !== undefined) S.delete(key); });', ...VIA_S })],
    ['every entry deleted per request', api({ factory: `  const S = ${MAP};`, request: '    for (const k of [...S.keys()]) S.delete(k);', ...VIA_S }),
      api({ factory: `  const S = ${MAP};`, request: '    for (const k of [...S.keys()]) void k;', ...VIA_S })],
  ],
  'Object.assign / Reflect / defineProperty': [
    ['Object.assign(holder, { store: new Map() }) per request', api({ factory: `  const holder = { store: ${MAP}, hits: 0 };`, request: `    Object.assign(holder, { store: ${MAP} });`, ...VIA_HOLDER }),
      api({ factory: `  const holder = { store: ${MAP}, hits: 0 };`, request: '    Object.assign(holder, { hits: holder.hits + 1 });', ...VIA_HOLDER })],
    ['Reflect.set(holder, \'store\', …) per request', api({ factory: HOLDER, request: `    Reflect.set(holder, 'store', ${MAP});`, ...VIA_HOLDER }),
      api({ factory: `  const holder = { store: ${MAP}, hits: 0 };`, request: "    Reflect.set(holder, 'hits', 1);", ...VIA_HOLDER })],
    ['Object.defineProperty(holder, \'store\', …) per request', api({ factory: HOLDER, request: `    Object.defineProperty(holder, 'store', { value: ${MAP}, writable: true });`, ...VIA_HOLDER }),
      api({ factory: `  const holder = { store: ${MAP}, hits: 0 };`, request: "    Object.defineProperty(holder, 'hits', { value: 1, writable: true });", ...VIA_HOLDER })],
  ],
  'one store written, another replayed': [
    ['written to one persistent store, replayed from a different one', api({ factory: `  const A = ${MAP};\n  const B = ${MAP};`, lookup: 'B.get(key)', save: 'A.set(key, value)' }),
      api({ factory: `  const A = ${MAP};\n  const B = ${MAP};\n  void B;`, lookup: 'A.get(key)', save: 'A.set(key, value)' })],
    ['written to a persistent store, never read for the replay', api({ factory: `  const A = ${MAP};`, lookup: '(undefined as ItemT | undefined)', save: 'A.set(key, value)' }),
      api({ factory: `  const A = ${MAP};`, lookup: 'A.get(key)', save: 'A.set(key, value)' })],
  ],
};

/** A handler that hands req/res to a nested helper; `store` declares S (in the handler, or at module scope). */
const viaHelper = (inHandler: boolean): string => `${HEAD}${inHandler ? '' : `const S = ${MAP};\n`}export const r = Router();
r.post('/v1/items', (req, res) => {
${inHandler ? `  const S = ${MAP};\n` : ''}  const handle = (rq: typeof req, rs: typeof res): void => {
    const key = Headers.parse(rq.headers)['idempotency-key'];
    const hit = key !== undefined ? S.get(key) : undefined;
    if (hit !== undefined) {
      rs.status(201).location(\`/v1/items/\${hit.id}\`).json(Item.parse(hit));
      return;
    }
    created += 1;
    const body = Item.parse({ id: \`\${Item.parse(rq.body).id}-\${String(created)}\` });
    if (key !== undefined) S.set(key, body);
    rs.status(201).location(\`/v1/items/\${body.id}\`).json(Item.parse(body));
  };
  handle(req, res);
});
`;
/** The route registered by a router factory: built once (control) or per request (broken). */
const routerFactory = (perRequest: boolean): string => {
  const base = api({ factory: `  const S = ${MAP};`, ...VIA_S }).replace('export const r = Router();\nr.post(', 'function build(): Router {\n  const inner = Router();\n  inner.post(');
  const closed = base.replace(/\n\}\);\n$/, '\n  });\n  return inner;\n}\n');
  return `${closed}export const r = Router();\n${perRequest ? 'r.use((req, res, next) => { build()(req, res, next); });' : 'const built = build();\nr.use(built);'}\n`;
};
FAMILIES['registration and callers'] = [
  ['a store declared in a handler that hands req to a nested helper', viaHelper(true), viaHelper(false)],
  ['a router (and its middleware factory) built per request', routerFactory(true), routerFactory(false)],
];

describe.each(Object.entries(FAMILIES))('paired family: %s', (_family, rows) => {
  it.each(rows)('%s: broken never passes, control passes', async (_label, broken, control) => {
    await neverPasses(broken);
    await passes(control);
  });
});

/** A program module whose implementation the analysis cannot see (a `.d.ts` next to plain JavaScript, as a package ships). */
const VENDOR = (body: string): Record<string, string> => ({
  'src/vendor/mystery.d.ts': 'export declare function mystery(h: unknown): void;\n',
  'src/vendor/mystery.js': `export function mystery(h) { ${body} }\n`,
});

describe('objects handed to code the analysis cannot see → UNPROVEN, never pass', () => {
  it('a holder passed to a package function that replaces its store: unproven, and indeed never replays', async () => {
    const source = `import { mystery } from './vendor/mystery.js';\n${api({ factory: HOLDER, request: '    mystery(holder);', ...VIA_HOLDER })}`;
    expect(await outcome(source, VENDOR('h.store = new Map();'))).toEqual({ verdict: 'not pass', unproven: true, replays: false });
  });
  it('the same package function doing nothing: still unproven (it cannot be established), though it replays', async () => {
    const source = `import { mystery } from './vendor/mystery.js';\n${api({ factory: HOLDER, request: '    mystery(holder);', ...VIA_HOLDER })}`;
    expect(await outcome(source, VENDOR('void h;'))).toEqual({ verdict: 'not pass', unproven: true, replays: true });
  });
  it('a holder passed to a `declare function` (implemented elsewhere at runtime): unproven, and never replays', async () => {
    const top = `declare function mystery(h: unknown): void;\n(globalThis as Record<string, unknown>)['mystery'] = (h: { store: unknown }): void => { h.store = new Map(); };\n`;
    expect(await outcome(api({ top, factory: HOLDER, request: '    mystery(holder);', ...VIA_HOLDER }))).toEqual({ verdict: 'not pass', unproven: true, replays: false });
  });
  it('the store passed to an unknown function and its control without it', async () => {
    const source = `import { mystery } from './vendor/mystery.js';\n${api({ factory: `  const S = ${MAP};`, request: '    mystery(S);', ...VIA_S })}`;
    expect(await outcome(source, VENDOR('h.clear();'))).toEqual({ verdict: 'not pass', unproven: true, replays: false });
    await passes(api({ factory: `  const S = ${MAP};`, request: '    void S.size;', ...VIA_S }));
  });
});
