/**
 * Property-style tables for the mechanisms behind the standards checks: constant values
 * (paths, prefixes, statuses) by value and type, error-class statuses by behaviour, mounts,
 * hand-written types, permissive schemas, idempotency by behaviour and action routes.
 * Every table mixes passing shapes with shapes that must still fail.
 */
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticProblemFindings } from '../../plugins/checks/problem-json.ts';
import { isActionRoute } from '../../plugins/checks/rest-conventions.ts';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import zodBoundary, { handWrittenTypes, zodEnumValueSets } from '../../plugins/checks/zod-boundary.ts';
import { constString, extractRouteTable, programFile, statusValues } from '../../plugins/lib/api-ast.ts';
import { constString as helperConstString, hasProperty } from '../../plugins/lib/plugin-helpers.ts';
import type { RouteInfo } from '../../plugins/lib/api-ast.ts';
import type { CheckContext, CheckFinding } from '../../src/core/plugin-api.ts';
import { contextFor, removeTempApi, tempApi } from './_ctx.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTempApi(r);
});

async function api(files: Record<string, string>, withLib = false): Promise<CheckContext> {
  const root = await tempApi(files, { withLib });
  roots.push(root);
  return contextFor(root);
}

/** The arguments of every `probe(...)` call in a file, in order. */
function probes(ctx: CheckContext, rel: string): ts.Expression[] {
  const sf = programFile(ctx.program(), ctx.root, rel);
  if (sf === undefined) throw new Error(`${rel} not in program`);
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'probe' && n.arguments[0] !== undefined) out.push(n.arguments[0]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('constant values by value and type', () => {
  const STRINGS: Array<[string, string | undefined]> = [
    ["'/v1/users'", '/v1/users'],
    ['`/v1/${"users"}`', '/v1/users'],
    ["BASE + '/users'", '/v1/users'],
    ['PATHS.users', '/users'],
    ["PATHS['users']", '/users'],
    ['`${BASE}${PATHS.users}/:userId`', '/v1/users/:userId'],
    ['IMPORTED', '/v1/imported'],
    ['Route.Orders', '/orders'],
    ['literal()', '/typed'],
    ['DECLARED', '/declared'],
    ["flag ? '/same' : '/same'", '/same'],
    ["undefined ?? '/fallback'", '/fallback'],
    ["OPTIONAL['missing'] ?? '/default'", '/default'],
    ['NESTED.api.v2', '/v2'],
    // not constants: must stay undetermined
    ["process.env['X'] ?? '/v1'", undefined],
    ['mutable', undefined],
    ['dynamic()', undefined],
    ["flag ? '/a' : '/b'", undefined],
    ["[BASE, 'users'].join('/')", undefined],
  ];
  const STATUSES: Array<[string, number[] | null]> = [
    ['201', [201]],
    ['HttpStatus.CREATED', [201]],
    ["HttpStatus['NO_CONTENT']", [204]],
    ['Status.Created', [201]],
    ['CREATED_DECLARED', [201]],
    ['flag ? 200 : 201', [200, 201]],
    ['UNION_DECLARED', [404, 409]],
    ["BY_KIND['conflict']", [409]],
    ["BY_KIND['conflict'] ?? 500", [409]],
    ['NUMBER_DECLARED', null],
    ['BY_KIND[kind]', null],
    ['count()', null],
  ];
  let ctx: CheckContext;
  beforeAll(async () => {
    ctx = await api({
      'src/paths.ts': "export const IMPORTED = '/v1/imported';\n",
      'src/values.ts': [
        "import { IMPORTED } from './paths.js';",
        'declare function probe(x: unknown): void;',
        'declare const flag: boolean;',
        'declare const kind: string;',
        "declare const DECLARED: '/declared';",
        'declare const CREATED_DECLARED: 201;',
        'declare const UNION_DECLARED: 404 | 409;',
        'declare const NUMBER_DECLARED: number;',
        "const BASE = '/v1';",
        "const PATHS = { users: '/users' } as const;",
        "const NESTED = { api: { v2: '/v2' } } as const;",
        'const OPTIONAL: Record<string, string> = {};',
        "let mutable = '/mutable';",
        "mutable = mutable + '';",
        "enum Route { Orders = '/orders' }",
        'enum Status { Created = 201 }',
        'const HttpStatus = { CREATED: 201, NO_CONTENT: 204 } as const;',
        'const BY_KIND: Record<string, number> = { conflict: 409 };',
        "function literal(): '/typed' { return '/typed'; }",
        'function dynamic(): string { return String(Date.now()); }',
        'function count(): number { return 1; }',
        ...STRINGS.map(([e]) => `probe(${e});`),
        ...STATUSES.map(([e]) => `probe(${e});`),
        '',
      ].join('\n'),
    });
  });

  it('constString resolves every constant path shape and nothing else', () => {
    const checker = ctx.program().getTypeChecker();
    const got = probes(ctx, 'src/values.ts').slice(0, STRINGS.length).map((e) => [e.getText(), constString(checker, e)]);
    expect(got).toEqual(STRINGS);
  });

  it('statusValues reads literals, `as const` members, enums, literal types and unions as sets', () => {
    const checker = ctx.program().getTypeChecker();
    const got = probes(ctx, 'src/values.ts').slice(STRINGS.length).map((e) => [e.getText(), statusValues(checker, e)]);
    expect(got).toEqual(STATUSES);
  });
});

describe('error classes are problems by behaviour (the error middleware), statuses from the class', () => {
  let routes: RouteInfo[];
  beforeAll(async () => {
    const ctx = await api({
      'src/errors.ts': `import type { ErrorRequestHandler } from 'express';
export class ParamStatusError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export class Gone extends ParamStatusError {
  constructor() { super(410, 'gone'); }
}
export class FieldStatusError extends Error {
  readonly statusCode: number = 500;
}
export class Missing extends FieldStatusError {
  override readonly statusCode = 404;
}
export class InitStatusError extends Error {
  readonly status: number;
  constructor(init: { status: number; detail: string }) { super(init.detail); this.status = init.status; }
}
export class CodeError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
export class Duplicate extends CodeError {
  constructor() { super('dup', 'duplicate'); }
}
export class Unhandled extends Error {
  readonly status = 404;
}
const BY_CODE: Record<string, number> = { duplicate: 409 };
export const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof ParamStatusError || err instanceof InitStatusError) {
    res.status(err.status).type('application/problem+json').json({ type: 'about:blank', title: 'Error', status: err.status, detail: err.message, instance: '' });
    return;
  }
  if (err instanceof FieldStatusError) {
    res.status(err.statusCode).type('application/problem+json').json({ type: 'about:blank', title: 'Error', status: err.statusCode, detail: err.message, instance: '' });
    return;
  }
  if (err instanceof CodeError) {
    const status = BY_CODE[err.code] ?? 500;
    res.status(status).type('application/problem+json').json({ type: 'about:blank', title: 'Error', status, detail: err.message, instance: '' });
  }
};
`,
      'src/app.ts': `import express from 'express';
import { z } from 'zod';
import { Duplicate, Gone, InitStatusError, Missing, Unhandled, onError } from './errors.js';
const P = z.object({ id: z.string() });
export const app = express();
const gone = (): Gone => new Gone();
app.get('/v1/a/:id', (req) => { P.parse(req.params); throw new Gone(); });
app.get('/v1/b/:id', (req) => { P.parse(req.params); throw new Missing(); });
app.get('/v1/c/:id', (req) => { P.parse(req.params); throw new InitStatusError({ status: 422, detail: 'x' }); });
app.get('/v1/d/:id', (req) => { P.parse(req.params); throw new Duplicate(); });
app.get('/v1/e/:id', (req) => { P.parse(req.params); throw gone(); });
app.get('/v1/f/:id', (req) => { P.parse(req.params); throw new Unhandled(); });
app.use(onError);
`,
    });
    routes = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes;
  });

  it.each([
    ['/v1/a/:id', 'param property bound through super(410, …)', 410],
    ['/v1/b/:id', 'field initializer overriding the base', 404],
    ['/v1/c/:id', 'this.status = init.status from an object argument', 422],
    ['/v1/d/:id', "the error middleware's code → status mapping", 409],
    ['/v1/e/:id', 'a helper returning the instance', 410],
  ])('%s: %s → %d', (path, _how, status) => {
    const r = routes.find((x) => x.path === path);
    expect(r?.problemSites.map((p) => p.status)).toEqual([status]);
  });

  it('a class the error middleware does not handle is not a problem producer', () => {
    const r = routes.find((x) => x.path === '/v1/f/:id');
    expect(r?.problemSites).toEqual([]);
  });
});

describe('mounts and prefixes compose by value', () => {
  it('const, template and array prefixes, path-less and nested mounts; a non-constant prefix is unresolved', async () => {
    const ctx = await api({
      'src/app.ts': `import express, { Router } from 'express';
const V1 = '/v1';
const inner = Router();
inner.get('/leaves', (_req, res) => { res.end(); });
const middle = Router();
middle.use(\`/\${'trees'}\`, inner);
export const app = express();
app.use(V1, middle);
const both = Router();
both.get('/items', (_req, res) => { res.end(); });
app.use(['/v1', '/v2'], both);
const bare = Router();
bare.get('/v1/bare', (_req, res) => { res.end(); });
app.use(bare);
const lost = Router();
lost.get('/things', (_req, res) => { res.end(); });
app.use(process.env['PREFIX'] ?? '/v1', lost);
`,
    });
    const table = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles);
    expect(table.routes.map((r) => r.path).sort()).toEqual(['/v1/bare', '/v1/items', '/v1/trees/leaves', '/v2/items']);
    expect(table.unresolved.map((r) => [r.path, r.unresolvedPath?.reason])).toEqual([
      ["<process.env['PREFIX'] ?? '/v1'>/things", "mount prefix process.env['PREFIX'] ?? '/v1' is not a constant string"],
    ]);
  });
});

describe('hand-written types', () => {
  const FLAGGED = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];
  it('data shapes are flagged; ports, services, errors, function types and inferred types are not', async () => {
    const ctx = await api({
      'src/types.ts': `import { z } from 'zod';
const X = z.object({ id: z.string() });
export const Kind = z.enum(['a', 'b']);
export interface A { id: string }
export interface B { id: string; save(): void }
export interface C { [k: string]: string }
export type D = { id: string };
export type E = { id: string }[];
export type F = Array<{ id: string }>;
export type G = ReadonlyArray<{ id: string }>;
export type H = [{ id: string }, number];
export type I = { a: string } & { b: number };
export type J = Promise<{ id: string }>;
export type K = Record<string, { id: string }>;
export class L { id = ''; }
export class M { constructor(public id: string, public name: string) {} }
export class N { id!: string; }
export enum O { A = 'a', B = 'b' }
export interface P { find(id: string): Promise<string> }
export interface Q { find: (id: string) => Promise<string> }
export interface R {}
export type S = { run(): void };
export type T = z.infer<typeof X>;
export type U = string;
export type V = 'a' | 'b';
export type W = (x: { id: string }) => void;
export class Svc { constructor(private readonly repo: P) {} find(): Promise<string> { return this.repo.find('x'); } }
export class HttpErr extends Error { constructor(public status: number) { super('x'); } }
export class Store { private rows = new Map<string, string>(); get(id: string): string | undefined { return this.rows.get(id); } }
export class Ctl { list = (): void => undefined; }
export enum Y { A = 'x', B = 'y' }
export enum Z { One = 1 }
declare global { interface Window { x: string } }
`,
    });
    const program = ctx.program();
    const checker = program.getTypeChecker();
    const sf = programFile(program, ctx.root, 'src/types.ts');
    if (sf === undefined) throw new Error('no source');
    const flagged = handWrittenTypes(ctx.root, sf, checker, zodEnumValueSets(checker, [sf])).map((v) => v.message.split(':')[0]?.split(' ')[1]);
    expect(flagged).toEqual(FLAGGED);
  });
});

/** The rule findings for one route label. */
function forRoute(findings: CheckFinding[], label: string): string[] {
  return findings.flatMap((f) => f.violations).filter((v) => v.message.startsWith(`${label}:`)).map((v) => v.message);
}

describe('permissive schemas never validate a request or a response', () => {
  const SCHEMAS: Array<[string, boolean]> = [
    ['z.any()', true],
    ['z.unknown()', true],
    ['z.custom()', true],
    ['z.record(z.string(), z.unknown())', true],
    ['z.record(z.string(), z.any())', true],
    ['z.object({}).passthrough()', true],
    ['z.object({}).loose()', true],
    ['z.looseObject({})', true],
    ['z.array(z.unknown())', true],
    ['z.object({ a: z.string() }).nullable().optional()', false],
    ['z.custom<{ a: string }>()', false],
    ['z.record(z.string(), z.string())', false],
    ['z.object({ a: z.string() }).passthrough()', false],
    ['z.array(z.object({ a: z.string() }))', false],
    ['z.object({})', false],
  ];
  let findings: CheckFinding[];
  beforeAll(async () => {
    const lines = SCHEMAS.map(([s], i) => `r.put('/v1/things-${i}', (req, res) => {\n  const body = (${s}).parse(req.body);\n  res.json((${s}).parse(body));\n});`);
    const ctx = await api({ 'src/routes.ts': `import { Router } from 'express';\nimport { z } from 'zod';\nexport const r = Router();\n${lines.join('\n')}\n` });
    findings = await zodBoundary.run(ctx);
  });
  it.each(SCHEMAS.map(([s, bad], i) => [s, bad, i] as const))('%s → permissive: %s', (_s, bad, i) => {
    const msgs = forRoute(findings, `PUT /v1/things-${i}`);
    expect(msgs.filter((m) => m.includes('accepts anything')).length).toBe(bad ? 2 : 0);
    if (bad) expect(msgs.some((m) => m.includes('request body is not parsed'))).toBe(true);
  });
});

describe('idempotency is recognised by behaviour (the chain reads the Idempotency-Key header, stores a response keyed by it and replays it)', () => {
  /** Remembers the JSON a request answered under its key and replays it for the same key. */
  const STORE = "if (key === undefined) { next(); return; } const hit = done.get(key); if (hit !== undefined) { res.status(201).json(hit); return; } const json = res.json.bind(res); res.json = (b: unknown) => { done.set(key, b); return json(b); }; next();";
  const DONE = 'const done = new Map<unknown, unknown>();';
  const CASES: Array<[string, string, boolean | undefined]> = [
    ['req.get', `${DONE}\nconst keyed: RequestHandler = (req, res, next) => { const key = req.get('Idempotency-Key'); ${STORE} };`, true],
    ['req.header', `${DONE}\nconst keyed: RequestHandler = (req, res, next) => { const key = req.header('idempotency-key'); ${STORE} };`, true],
    ['req.headers[...]', `${DONE}\nconst keyed: RequestHandler = (req, res, next) => { const key = req.headers['idempotency-key']; ${STORE} };`, true],
    ['a header schema parse', `const H = z.object({ 'idempotency-key': z.string().optional() });\n${DONE}\nconst keyed: RequestHandler = (req, res, next) => { const key = H.parse(req.headers)['idempotency-key']; ${STORE} };`, true],
    ['a callee that receives req', `function readKey(r: Request): string | undefined { return r.get('Idempotency-Key'); }\n${DONE}\nconst keyed: RequestHandler = (req, res, next) => { const key = readKey(req); ${STORE} };`, true],
    ['a factory with the header name bound', `${DONE}\nconst requireHeader = (name: string): RequestHandler => (req, res, next) => { const key = req.get(name); ${STORE} };\nconst keyed = requireHeader('Idempotency-Key');`, true],
    ['store helpers the key is passed to', `const done = new Map<string, unknown>();\nconst recall = (k: string): unknown => done.get(k);\nfunction remember(k: string, body: unknown): void { done.set(k, body); }\nconst keyed: RequestHandler = (req, res, next) => { const key = req.get('Idempotency-Key'); if (key === undefined) { next(); return; } const hit = recall(key); if (hit !== undefined) { res.status(201).json(hit); return; } const json = res.json.bind(res); res.json = (b: unknown) => { remember(key, b); return json(b); }; next(); };`, true],
    ['a key only tested, then next()', "const keyed: RequestHandler = (req, _res, next) => { if (req.get('Idempotency-Key') === undefined) next(); else next(); };", false],
    ['a header schema parse alone', "const H = z.object({ 'idempotency-key': z.string().optional() });\nconst keyed: RequestHandler = (req, _res, next) => { H.parse(req.headers); next(); };", false],
    ['a key stored but never replayed', `${DONE}\nconst keyed: RequestHandler = (req, _res, next) => { const key = req.get('Idempotency-Key'); if (key !== undefined) done.set(key, true); next(); };`, undefined],
    ['a name alone', 'const idempotency = (): RequestHandler => (_req, _res, next) => { next(); };\nconst keyed = idempotency();', false],
    ['another header', `${DONE}\nconst keyed: RequestHandler = (req, res, next) => { const key = req.get('x-request-id'); ${STORE} };`, false],
  ];
  it.each(CASES)('%s → idempotent (undefined: UNPROVEN): %s', async (_name, middleware, ok) => {
    const ctx = await api({
      'src/routes.ts': `import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
${middleware}
export const r = Router();
r.post('/v1/items', keyed, (req, res) => {
  res.status(201).location('/v1/items/1').json(Item.parse(Item.parse(req.body)));
});
`,
    });
    const findings = await restConventions.run(ctx);
    const msgs = forRoute(findings, 'POST /v1/items');
    expect(msgs.some((m) => m.includes('no idempotency')), msgs.join('\n')).toBe(ok === false);
    const unproven = findings.some((f) => f.status === 'skip' && (f.skipReason ?? '').includes('POST /v1/items reads the Idempotency-Key header'));
    expect(unproven, JSON.stringify(findings)).toBe(ok === undefined);
  });

  it('router.use(middleware) counts only for routes registered after it', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
const done = new Map<string, unknown>();
const keyed: RequestHandler = (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return next();
  const hit = done.get(key);
  if (hit !== undefined) return void res.status(201).json(hit);
  const json = res.json.bind(res);
  res.json = (b: unknown) => { done.set(key, b); return json(b); };
  next();
};
export const r = Router();
r.post('/v1/early', (req, res) => { res.status(201).json(Item.parse(req.body)); });
r.use(keyed);
r.post('/v1/late', (req, res) => { res.status(201).json(Item.parse(req.body)); });
`,
    });
    const findings = await restConventions.run(ctx);
    expect(forRoute(findings, 'POST /v1/early').some((m) => m.includes('no idempotency'))).toBe(true);
    expect(forRoute(findings, 'POST /v1/late').some((m) => m.includes('no idempotency'))).toBe(false);
  });
});

describe('action sub-resources', () => {
  it.each([
    ['post', '/v1/orders/:orderId/cancel', true],
    ['post', '/v1/users/:userId/reset-password', true],
    ['post', '/v1/orders/:orderId/items', false],
    ['post', '/v1/orders/:orderId/line-items', false],
    ['get', '/v1/orders/:orderId/cancel', false],
    ['post', '/v1/orders/cancel', false],
    ['post', '/v1/orders/:orderId', false],
  ] as const)('%s %s → action: %s', (method, path, action) => {
    expect(isActionRoute({ method, path })).toBe(action);
  });

  it('an action responds 200/202/204 without a plural segment; anything else stays strict', async () => {
    const ctx = await api(
      {
        'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
import { idempotency } from './lib/idempotency.js';
import { notFound } from './lib/problem.js';
const P = z.object({ orderId: z.string() });
const B = z.object({ reason: z.string().optional() });
const Order = z.object({ id: z.string() });
export const r = Router();
r.post('/v1/orders/:orderId/cancel', idempotency(), (req, res) => {
  const { orderId } = P.parse(req.params);
  B.parse(req.body);
  if (orderId === '') throw notFound('order');
  res.status(202).json(Order.parse({ id: orderId }));
});
r.post('/v1/orders/:orderId/ship', idempotency(), (req, res) => {
  const { orderId } = P.parse(req.params);
  B.parse(req.body);
  if (orderId === '') throw notFound('order');
  res.status(204).end();
});
r.post('/v1/orders/:orderId/refund', idempotency(), (req, res) => {
  const { orderId } = P.parse(req.params);
  B.parse(req.body);
  if (orderId === '') throw notFound('order');
  res.status(304).end();
});
`,
      },
      true,
    );
    const findings = await restConventions.run(ctx);
    expect(forRoute(findings, 'POST /v1/orders/:orderId/cancel')).toEqual([]);
    expect(forRoute(findings, 'POST /v1/orders/:orderId/ship')).toEqual([]);
    expect(forRoute(findings, 'POST /v1/orders/:orderId/refund')).toEqual(['POST /v1/orders/:orderId/refund: an action responds 200, 201, 202 or 204']);
  });
});

describe('routes whose path cannot be resolved', () => {
  it('are checked for everything path-independent and are UNPROVEN, never passed or dropped', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
const Params = z.object({ id: z.string() });
const where = (): string => process.env['WHERE'] ?? '/v1/items';
export const r = Router();
r.get(where(), (_req, res) => { res.json(Item.parse({ id: 'x' })); });
r.get(where() + '/:id', (req, res) => { res.json(Item.parse(Params.parse(req.params))); });
r.post(where(), (req, res) => { res.status(201).json(Item.parse({ ...req.body })); });
`,
    });
    const zod = await zodBoundary.run(ctx);
    // no :params parse → unproven; params parsed and clean → passes; a raw read → fails at the read
    expect(zod.filter((f) => f.status === 'skip').map((f) => f.skipReason?.split(': ').slice(0, 2).join(': '))).toEqual([`src/routes.ts:7:7: GET route`]);
    const routes = zod.find((f) => f.status !== 'skip');
    expect(routes?.units).toEqual({ passed: 1, total: 2 });
    expect(routes?.violations.map((v) => `${v.location.split(':')[1] ?? ''} ${v.message.split(';')[0] ?? ''}`)).toEqual([
      '9 POST <where()>: req.body is read without <ZodSchema>.parse()',
      '9 POST <where()>: request body is not parsed',
    ]);
    const rest = await restConventions.run(ctx);
    expect(rest.filter((f) => f.status === 'skip')).toHaveLength(2);
    expect(rest.find((f) => f.status !== 'skip')?.violations.map((v) => v.message.split(':')[0])).toEqual(['POST <where()>']);
    expect(extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes).toEqual([]);
  });
});

describe('only serialising a whole raw part is exempt from parsing', () => {
  const USES: Array<[string, boolean]> = [
    ['void JSON.stringify(req.body);', true],
    ['void JSON.stringify([req.method, req.body ?? null]);', true],
    ['void JSON.stringify({ at: req.originalUrl, body: req.body });', true],
    ['void hash(req.body);', true],
    ['void JSON.stringify(req.body.items);', false],
    ['void `${req.body}`;', false],
    ['void launder(req.body);', false],
    ['void JSON.parse(JSON.stringify(req.body));', false],
    ['void Object.assign({}, req.body);', false],
  ];
  let routes: RouteInfo[];
  beforeAll(async () => {
    const lines = USES.map(([use], i) => `r.get('/v1/uses-${i}', (req, res) => {\n  ${use}\n  res.status(204).end();\n});`);
    const ctx = await api({
      'src/routes.ts': `import { createHash } from 'node:crypto';
import { Router } from 'express';
function hash(v: unknown): string { return createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function launder(v: unknown): unknown { return v; }
export const r = Router();
${lines.join('\n')}
`,
    });
    routes = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes;
  });
  it.each(USES.map(([use, ok], i) => [use, ok, i] as const))('%s → exempt: %s', (_use, ok, i) => {
    const r = routes.find((x) => x.path === `/v1/uses-${i}`);
    expect(r?.unparsedReads.map((u) => u.target)).toEqual(ok ? [] : ['body']);
  });
});

describe('error responses are judged by status value and body type', () => {
  // [send statement, expected: null = not an error path, '' = passing error path, else a message fragment]
  const SENDS: Array<[string, string | null]> = [
    ["res.setHeader('Content-Type', 'application/problem+json');\n  res.status(404).json({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'x', instance: '/x' });", ''],
    ["res.status(404).json({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'x', instance: '/x' });", "missing .type('application/problem+json')"],
    ["res.status(404).type('application/problem+json').json({ type: 'about:blank', title: 'Not Found', status: 404 });", 'missing detail, instance'],
    // A typed problem body still needs the problem media type, however it is built.
    ["res.status(code).json(ProblemSchema.parse({ type: 'about:blank', title: 'x', status: code, detail: 'x', instance: '/x' }));", "missing .type('application/problem+json')"],
    ["res.status(409).json(ProblemSchema.parse({ type: 'about:blank', title: 'x', status: 409, detail: 'x', instance: '/x' }));", "status 409 is sent with a non-problem body (missing .type('application/problem+json'))"],
    ["res.status(code).type('application/problem+json').json(ProblemSchema.parse({ type: 'about:blank', title: 'x', status: code, detail: 'x', instance: '/x' }));", ''],
    ["useProblemType(res);\n  res.status(409).json(ProblemSchema.parse({ type: 'about:blank', title: 'x', status: 409, detail: 'x', instance: '/x' }));", ''],
    ["res.status(code).json(Loose.parse({ reason: 'x' }));", 'status code is not a constant'],
    ['res.status(rec.status).json(rec.body);', null],
    ['res.sendStatus(code);', 'status code is not a constant'],
    ['res.status(flag ? 201 : 409).json(Loose.parse({ reason: \'x\' }));', 'status 201|409 is sent with a non-problem body'],
    ['res.status(flag ? 200 : 201).json(Loose.parse({ reason: \'x\' }));', null],
    ['res.status(Codes.Conflict).json(Loose.parse({ reason: \'x\' }));', 'status 409 is sent with a non-problem body'],
  ];
  let findings: CheckFinding[];
  beforeAll(async () => {
    const fns = SENDS.map(([send], i) => `export function send${i}(res: Response): void {\n  ${send}\n}`);
    const ctx = await api({
      'src/sends.ts': `import type { Response } from 'express';
import { z } from 'zod';
const ProblemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string(), instance: z.string() });
const Loose = z.object({ reason: z.string() });
enum Codes { Conflict = 409 }
declare const code: number;
declare const flag: boolean;
declare const rec: { status: number; body: unknown };
function useProblemType(r: Response): void { r.set('Content-Type', 'application/problem+json'); }
${fns.join('\n')}
`,
    });
    findings = staticProblemFindings(ctx).filter((f) => f.file === 'src/sends.ts');
  });
  it.each(SENDS.map(([send, want], i) => [i, send, want] as const))('send%i: %s → %s', (i, _send, want) => {
    const inFn = findings.flatMap((f) => f.violations).filter((v) => lineInSends(i, Number(v.location.split(':')[1])));
    if (want === null || want === '') expect(inFn, JSON.stringify(inFn)).toEqual([]);
    else expect(inFn.some((v) => v.message.includes(want)), JSON.stringify(inFn)).toBe(true);
  });
  it('counts one unit per error path and none for success-only or replayed sends', () => {
    // + the two app-level units (no error middleware / not-found handler in this file-only API)
    const total = findings.reduce((n, f) => n + f.units.total, 0);
    expect(total).toBe(SENDS.filter(([, w]) => w !== null).length + 2);
  });

  /** Whether line `line` of src/sends.ts belongs to send<i> (each function is 3 lines, the first one is 2 lines longer). */
  function lineInSends(i: number, line: number): boolean {
    const header = 10; // lines before the first function
    let start = header + 1;
    for (let k = 0; k < i; k++) start += 3 + ((SENDS[k]?.[0] ?? '').split('\n').length - 1);
    const len = 3 + ((SENDS[i]?.[0] ?? '').split('\n').length - 1);
    return line >= start && line < start + len;
  }
});

describe('routes registered with a computed method', () => {
  it('are UNPROVEN with their location; a constant computed method is a normal route', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router, type RequestHandler } from 'express';
const table: Array<{ method: 'get' | 'post'; path: string; handler: RequestHandler }> = [];
const VERB = 'get';
export const r = Router();
for (const row of table) {
  r[row.method](row.path, row.handler);
}
r[VERB]('/v1/pings', (_req, res) => { res.status(204).end(); });
`,
    });
    const table = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles);
    expect(table.routes.map((x) => `${x.method} ${x.path}`)).toEqual(['get /v1/pings']);
    for (const check of [zodBoundary, restConventions]) {
      const skips = (await check.run(ctx)).filter((f) => f.status === 'skip').map((f) => f.skipReason ?? '');
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatch(/^src\/routes\.ts:6:3: route registered with a computed method \(row\.method\)/);
    }
  });
});

describe('handler lists in every Express shape', () => {
  it('route() chains with .all() middleware, path arrays and spread handler lists', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
const Body = z.object({ name: z.string() });
const parseBody: RequestHandler = (req, _res, next) => { req.body = Body.parse(req.body); next(); };
const keyed: RequestHandler = (req, _res, next) => { void req.get('Idempotency-Key'); next(); };
const createChain: RequestHandler[] = [keyed, parseBody];
export const r = Router();
r.route('/v1/widgets')
  .get((_req, res) => { res.json(Item.parse({ id: 'w' })); })
  .all(keyed, parseBody)
  .post((req, res) => { res.status(201).json(Item.parse({ id: String(req.body.name) })); });
r.get(['/v1/gadgets', '/v1/gizmos'], (_req, res) => { res.json(Item.parse({ id: 'g' })); });
r.post('/v1/parts', ...createChain, (req, res) => { res.status(201).json(Item.parse({ id: String(req.body.name) })); });
`,
    });
    const routes = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes;
    const view = routes.map((x) => [`${x.method} ${x.path}`, x.parses.map((p) => p.target).join(','), x.unparsedReads.map((u) => u.target).join(','), x.readsIdempotencyKey]).sort((p, q) => String(p[0]).localeCompare(String(q[0])));
    expect(view).toEqual([
      ['get /v1/gadgets', '', '', false],
      ['get /v1/gizmos', '', '', false],
      ['get /v1/widgets', '', '', false],
      // req.body in the handler follows the write-back; the raw req.get() in `keyed` is still a boundary read
      ['post /v1/parts', 'body', 'headers', true],
      ['post /v1/widgets', 'body', 'headers', true],
    ]);
  });
});

describe('request-wide schemas', () => {
  it('S.parse({ body: req.body, params: req.params }) and S.parse(req) count per declared member; a member read builds no parse', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
const Req = z.object({ body: z.object({ name: z.string() }), params: z.object({ id: z.string() }) });
const validateRequest = (schema: typeof Req): RequestHandler => (req, _res, next) => {
  const parsed = schema.parse({ body: req.body, query: req.query, params: req.params });
  req.body = parsed.body;
  next();
};
const validateAll = (schema: typeof Req): RequestHandler => (req, _res, next) => {
  schema.parse(req);
  next();
};
export const r = Router();
r.put('/v1/things/:id', validateRequest(Req), (req, res) => { res.json(Item.parse({ id: String(req.body.name) })); });
r.patch('/v1/things/:id', validateAll(Req), (req, res) => { res.json(Item.parse({ id: String(req.body.name) })); });
r.post('/v1/things', (req, res) => { res.status(201).json(Item.parse({ id: req.body.id })); });
`,
    });
    const routes = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes;
    const view = Object.fromEntries(routes.map((x) => [`${x.method} ${x.path}`, [x.parses.map((p) => `${p.target}:${p.schema.member ?? ''}`).join(','), x.unparsedReads.map((u) => u.target).join(',')]]));
    expect(view).toEqual({
      // written back from parsed.body: the handler's req.body read is covered; the stripped query is not read
      'put /v1/things/:id': ['body:body,params:params', ''],
      // validation only (no write-back): the handler's raw req.body read stays a violation
      'patch /v1/things/:id': ['params:params,body:body', 'body'],
      // { id: req.body.id } builds a value from raw input: not a parse of the body
      'post /v1/things': ['', 'body'],
    });
  });
});

describe('a parsed response body must not change between the parse and the send', () => {
  // [handler body after `const u = Item.parse(src);`, expected: ok | mutated | unproven]
  const BODIES: Array<[string, 'ok' | 'mutated' | 'unproven']> = [
    ['res.json(u);', 'ok'],
    ['process.stdout.write(JSON.stringify(u));\n  res.json(u);', 'ok'],
    ['u.tags.map((t) => t.toUpperCase());\n  res.json(u);', 'ok'],
    ['stored.push(u);\n  res.json(u);', 'ok'], // kept in a collection, unchanged before the send
    ['const copy = { ...u, name: "x" };\n  res.json(Item.parse(copy));', 'ok'],
    ['u.name = "x";\n  res.json(Item.parse(u));', 'ok'], // re-parsed at the send
    ['res.json(u);\n  u.name = "late";', 'ok'],
    ['u.name = "x";\n  res.json(u);', 'mutated'],
    ['u["name"] += "!";\n  res.json(u);', 'mutated'],
    ['delete u.note;\n  res.json(u);', 'mutated'],
    ['Object.assign(u, { extra: 1 });\n  res.json(u);', 'mutated'],
    ['u.tags.push("x");\n  res.json(u);', 'mutated'],
    ['const tags = u.tags;\n  tags.splice(0, 1);\n  res.json(u);', 'mutated'],
    ['const { tags } = u;\n  tags.sort();\n  res.json(u);', 'mutated'],
    ['for (const t of u.items) t.qty++;\n  res.json(u);', 'mutated'],
    ['u.items.forEach((it) => { it.qty = 0; });\n  res.json(u);', 'mutated'],
    ['stored.push(u);\n  stored[0]!.name = "x";\n  res.json(u);', 'mutated'],
    ['const holder = { u };\n  holder.u.name = "x";\n  res.json(u);', 'mutated'],
    ['rename(u);\n  res.json(u);', 'mutated'], // a program helper writes to its parameter
    ['describeIt(u);\n  res.json(u);', 'ok'], // a program helper that only reads it
    ['opaque(u);\n  res.json(u);', 'unproven'], // unknown code may change it
    ['registry.current = u;\n  res.json(u);', 'ok'], // stored, unchanged before the send
    ['registry.current = u;\n  opaque(registry);\n  res.json(u);', 'unproven'], // its holder handed to unknown code
  ];
  let findings: CheckFinding[];
  beforeAll(async () => {
    const lines = BODIES.map(([b], i) => `r.get('/v1/m-${i}', (_req, res) => {\n  const u = Item.parse(src);\n  ${b}\n});`);
    const ctx = await api({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
export const r = Router();
const Item = z.object({ name: z.string(), note: z.string().optional(), tags: z.array(z.string()), items: z.array(z.object({ qty: z.number() })) });
type ItemT = z.infer<typeof Item>;
declare const src: unknown;
declare function opaque(x: object): void;
declare const registry: { current: object | undefined };
const stored: ItemT[] = [];
function rename(x: ItemT): void { x.name = 'renamed'; }
function describeIt(x: ItemT): string { return \`\${x.name} (\${x.tags.length})\`; }
${lines.join('\n')}
`,
    });
    findings = await zodBoundary.run(ctx);
  });
  it.each(BODIES.map(([b, want], i) => [i, b, want] as const))('m-%i: %s → %s', (i, _b, want) => {
    const label = `GET /v1/m-${i}`;
    const msgs = forRoute(findings, label);
    const unproven = findings.filter((f) => f.status === 'skip' && (f.skipReason ?? '').includes(`${label}:`));
    if (want === 'ok') expect([...msgs, ...unproven.map((f) => f.skipReason)]).toEqual([]);
    if (want === 'mutated') expect(msgs.some((m) => m.includes('is changed after its Zod parse')), JSON.stringify(msgs)).toBe(true);
    if (want === 'unproven') {
      expect(msgs).toEqual([]);
      expect(unproven.length).toBe(1);
    }
  });
});

describe('every function of the route chain that answers is judged', () => {
  it('middleware (factories followed) and helpers given res send parsed 2xx bodies', async () => {
    const ctx = await api({
      'src/routes.ts': `import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
export const r = Router();
const Item = z.object({ id: z.string() });
declare const cache: Map<string, { id: string }>;
const early: RequestHandler = (_req, res, next) => { const hit = cache.get('a'); if (hit) { res.json(hit); return; } next(); };
function guard(): RequestHandler { return (_req, res, next) => { if (cache.size > 9) { res.status(200).send({ id: 'full' }); return; } next(); }; }
const parsedEarly: RequestHandler = (_req, res, next) => { const hit = cache.get('b'); if (hit) { res.json(Item.parse(hit)); return; } next(); };
function reply(res: Response, body: { id: string }): void { res.json(body); }
r.get('/v1/a', early, (_req, res) => { res.json(Item.parse({ id: 'a' })); });
r.get('/v1/b', guard(), (_req, res) => { res.json(Item.parse({ id: 'b' })); });
r.get('/v1/c', parsedEarly, (_req, res) => { res.json(Item.parse({ id: 'c' })); });
r.get('/v1/d', (_req, res) => { reply(res, { id: 'd' }); });
`,
    });
    const findings = await zodBoundary.run(ctx);
    expect(forRoute(findings, 'GET /v1/a').some((m) => m.includes('not parsed') && m.includes('middleware/helper'))).toBe(true);
    expect(forRoute(findings, 'GET /v1/b').some((m) => m.includes('not parsed') && m.includes('middleware/helper'))).toBe(true);
    expect(forRoute(findings, 'GET /v1/c')).toEqual([]);
    // `res` passed along (an existing rule) and the helper's own unparsed send
    const d = forRoute(findings, 'GET /v1/d');
    expect(d.some((m) => m.includes('`res` is passed along'))).toBe(true);
    expect(d.some((m) => m.includes('not parsed') && m.includes('middleware/helper'))).toBe(true);
  });
});

describe('middleware runs in Express order', () => {
  it('app-level middleware runs before router-level middleware: a later write-back does not cover an earlier read', async () => {
    const ctx = await api({
      'src/app.ts': `import express, { Router } from 'express';
import { z } from 'zod';
const Body = z.object({ name: z.string() });
const Item = z.object({ id: z.string() });
export const app = express();
app.use((req, _res, next) => { process.stdout.write(String(req.body.trace)); next(); });
const r = Router();
r.use((req, _res, next) => { req.body = Body.parse(req.body); next(); });
r.post('/v1/things', (req, res) => { res.status(201).json(Item.parse({ id: req.body.name })); });
app.use(r);
app.use((req, _res, next) => { process.stdout.write(String(req.query.late)); next(); });
`,
    });
    const [post] = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes;
    expect(post?.parses.map((p) => p.target)).toEqual(['body']);
    // the app-level read (line 6) runs first and stays raw; the handler's read follows the write-back;
    // the middleware registered after the mount (line 11) does not run for the route
    expect(post?.unparsedReads.map((u) => [u.target, u.node.getSourceFile().getLineAndCharacterOfPosition(u.node.getStart()).line + 1])).toEqual([['body', 6]]);
  });
});

describe('the final not-found handler is recognised by behaviour', () => {
  it.each([
    ['path-less', 'app.use((req: Request, _res: Response, next: NextFunction) => { next(notFound(req.path)); });', true],
    ['a catch-all path', "app.use('/{*splat}', (req: Request, _res: Response, next: NextFunction) => { next(notFound(req.path)); });", true],
    ['a status constant', "app.use((_req: Request, res: Response) => { res.status(NOT_FOUND).type('application/problem+json').json(ProblemSchema.parse({ type: 'about:blank', title: 'Not Found', status: NOT_FOUND, detail: 'x', instance: '/' })); });", true],
    ['a prefix-scoped handler', "app.use('/v1', (req: Request, _res: Response, next: NextFunction) => { next(notFound(req.path)); });", false],
    ['a middleware that never produces a 404', 'app.use((_req: Request, _res: Response, next: NextFunction) => { next(); });', false],
  ])('%s → %s', async (_name, line, ok) => {
    const ctx = await api(
      {
        'src/app.ts': `import express, { type NextFunction, type Request, type Response } from 'express';
import { errorHandler } from './lib/errors.js';
import { ProblemSchema, notFound } from './lib/problem.js';
const NOT_FOUND = 404;
export const app = express();
${line}
app.use(errorHandler);
`,
      },
      true,
    );
    const app = staticProblemFindings(ctx).find((f) => f.file === 'src/app.ts');
    const missing = (app?.violations ?? []).some((v) => v.message.startsWith('no final not-found handler'));
    expect(missing, JSON.stringify(app?.violations)).toBe(!ok);
  });
});

describe('plugin-helpers conveniences', () => {
  it('hasProperty sees every spelling of a key; constString is available to plugin authors', () => {
    const sf = ts.createSourceFile('x.ts', "const o = { a: 1, 'b': 2, ['c']: 3, d, e() { return 1; }, ...rest };", ts.ScriptTarget.ES2022, true);
    let obj: ts.ObjectLiteralExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) obj = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (obj === undefined) throw new Error('no object');
    const o = obj;
    expect(['a', 'b', 'c', 'd', 'e', 'rest', 'f'].map((k) => hasProperty(o, k))).toEqual([true, true, true, true, true, false, false]);
    expect(helperConstString).toBe(constString);
  });
});
