/**
 * Runtime probes on ANY Express app layout: the probe runtime finds the app wherever and however the
 * API builds it (factory, instance, default export, a server the entry file starts itself, what
 * package.json names, …), serves it on the harness's own port and the harness judges every response.
 * Negative rows: no app → UNPROVEN with what was tried; a non-problem app → FAIL; a handler the
 * throwing route cannot be injected into → that probe UNPROVEN (never silently dropped).
 */
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import problemJson from '../../plugins/checks/problem-json.ts';
import { extractRoutes } from '../../plugins/lib/api-ast.ts';
import { INTERNAL_ERROR_PATH, runProbe, type ProbeRun } from '../../plugins/lib/probe.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';
import { FIXTURES, memoryLogs, removeTempApi, tempApi } from './_ctx.ts';

/** Problem helpers, an error middleware and a final not-found handler (shared by every layout). */
const PROBLEMS = `import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
export class HttpProblem extends Error {
  constructor(readonly status: number, readonly title: string, readonly type: string, readonly detail: string) {
    super(detail);
  }
}
export const notFound = (detail: string): HttpProblem => new HttpProblem(404, 'Not Found', 'urn:problem:not-found', detail);
export const routeNotFound: RequestHandler = (req, _res, next) => next(notFound(\`no route \${req.method} \${req.path}\`));
export const problemHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const p =
    err instanceof HttpProblem ? { type: err.type, title: err.title, status: err.status, detail: err.detail }
    : err instanceof z.ZodError ? { type: 'urn:problem:validation', title: 'Unprocessable Content', status: 422, detail: 'invalid request' }
    : err instanceof SyntaxError ? { type: 'urn:problem:malformed', title: 'Bad Request', status: 400, detail: 'malformed JSON' }
    : { type: 'urn:problem:internal', title: 'Internal Server Error', status: 500, detail: 'unexpected error' };
  res.status(p.status).type('application/problem+json').json({ ...p, instance: req.originalUrl });
};
`;

/** A small items resource with literal /v1 paths. */
const ITEMS = `import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from './problems.js';
const NewItem = z.object({ name: z.string().min(1) });
const Params = z.object({ itemId: z.uuid() });
export function itemsRouter(): Router {
  const items = new Map<string, { id: string; name: string }>();
  const r = Router();
  r.get('/v1/items', (_req, res) => {
    res.json({ data: [...items.values()], nextCursor: null });
  });
  r.post('/v1/items', (req, res) => {
    const item = { id: randomUUID(), ...NewItem.parse(req.body) };
    items.set(item.id, item);
    res.status(201).json(item);
  });
  r.get('/v1/items/:itemId', (req, res) => {
    const { itemId } = Params.parse(req.params);
    const item = items.get(itemId);
    if (item === undefined) throw notFound(\`item \${itemId} not found\`);
    res.json(item);
  });
  return r;
}
`;

/** Wires json parsing, the routes and the problem handlers onto an app. */
const MOUNT = `import express, { type Express } from 'express';
import { itemsRouter } from './items.js';
import { problemHandler, routeNotFound } from './problems.js';
export function mount(app: Express): Express {
  app.use(express.json());
  app.use(itemsRouter());
  app.use(routeNotFound);
  app.use(problemHandler);
  return app;
}
`;

const SHARED = { 'src/http/problems.ts': PROBLEMS, 'src/http/items.ts': ITEMS, 'src/http/mount.ts': MOUNT };
/** For layouts that do not serve the shared items routes (the probes come from every route in src/). */
const NO_SHARED_ROUTES = { 'src/http/items.ts': 'export {};\n', 'src/http/mount.ts': 'export {};\n' };
const pkg = (o: Record<string, unknown> = {}): string => JSON.stringify({ name: 'layout', private: true, type: 'module', ...o });
/** Placeholder for a loopback port the test process itself holds (binding it for real would fail). */
const HELD = '__HELD_PORT__';

interface Layout {
  name: string;
  files: Record<string, string>;
  /** Substring of how the runtime says it found the app. */
  found: string;
}

const LAYOUTS: Layout[] = [
  {
    name: 'createApp() in src/app.ts (template style)',
    files: { 'src/app.ts': `import express, { type Express } from 'express';\nimport { mount } from './http/mount.js';\nexport function createApp(): Express {\n  return mount(express());\n}\n` },
    found: 'src/app.ts: export createApp()',
  },
  {
    name: 'export const app, src/index.ts listens on a fixed port',
    files: {
      'src/app.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nexport const app = mount(express());\n`,
      'src/index.ts': `import { app } from './app.js';\napp.listen(${HELD}, () => console.log('listening'));\n`,
    },
    found: 'src/app.ts: export app',
  },
  {
    name: 'export default app',
    files: { 'src/app.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nconst app = mount(express());\nexport default app;\n` },
    found: 'src/app.ts: default export',
  },
  {
    name: 'default-exported anonymous factory',
    files: { 'src/app.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nexport default () => mount(express());\n` },
    found: 'src/app.ts: default export()',
  },
  {
    name: 'createApp(config = {}) with defaults',
    files: {
      'src/app.ts': `import express, { type Express } from 'express';\nimport { mount } from './http/mount.js';\nexport interface Config { trustProxy?: boolean }\nexport function createApp(config: Config = {}): Express {\n  const app = express();\n  app.set('trust proxy', config.trustProxy ?? false);\n  return mount(app);\n}\n`,
    },
    found: 'src/app.ts: export createApp()',
  },
  {
    name: 'src/index.ts builds the app and calls app.listen() at import (no exports)',
    files: { 'src/index.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nconst app = mount(express());\napp.listen(Number(process.env['PORT'] ?? ${HELD}));\n` },
    found: 'src/index.ts: the server it starts with listen() while loading',
  },
  {
    name: 'src/server.ts with http.createServer(app).listen() on all interfaces, plus a timer that keeps the process alive',
    files: {
      'src/server.ts': `import { createServer } from 'node:http';\nimport express from 'express';\nimport { mount } from './http/mount.js';\nconst server = createServer(mount(express()));\nserver.listen(${HELD}, '0.0.0.0', () => console.log('up'));\nsetInterval(() => undefined, 1000);\n`,
    },
    found: 'src/server.ts: the server it starts with listen() while loading',
  },
  {
    name: 'top-level await on the listen callback (ESM main)',
    files: {
      'src/main.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nconst app = mount(express());\nawait new Promise<void>((resolve) => {\n  app.listen(${HELD}, resolve);\n});\nconsole.log('ready');\n`,
    },
    found: 'src/main.ts: the server it starts with listen() while loading',
  },
  {
    name: 'listen() after an async startup step the module does not await',
    files: {
      'src/index.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nconst connect = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));\nvoid connect().then(() => mount(express()).listen(${HELD}));\n`,
    },
    found: 'a server started with listen() after loading (src/index.ts)',
  },
  {
    name: 'package.json main dist/index.js with src/index.ts present',
    files: {
      'package.json': pkg({ main: 'dist/index.js' }),
      'src/index.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nexport const api = mount(express());\n`,
    },
    found: 'src/index.ts: export api',
  },
  {
    name: 'package.json main names a non-conventional module whose bootstrap() listens',
    files: {
      'package.json': pkg({ main: 'dist/http/bootstrap.js' }),
      'src/http/bootstrap.ts': `import express from 'express';\nimport { mount } from './mount.js';\nexport async function bootstrap(): Promise<void> {\n  const app = mount(express());\n  await new Promise<void>((resolve) => app.listen(${HELD}, resolve));\n}\n`,
    },
    found: 'src/http/bootstrap.ts: export bootstrap() (it called listen())',
  },
  {
    name: 'scripts.start runs a built file whose source starts the server',
    files: {
      'package.json': pkg({ scripts: { build: 'tsc', start: 'node dist/boot/serve.js' } }),
      'src/boot/serve.ts': `import express from 'express';\nimport { mount } from '../http/mount.js';\nmount(express()).listen(${HELD});\n`,
    },
    found: 'src/boot/serve.ts: the server it starts with listen() while loading',
  },
  {
    name: 'package.json exports + tsconfig rootDir/outDir outside src/, an exported http.Server',
    files: {
      'package.json': pkg({ exports: { '.': { types: './build/entry.d.ts', import: './build/entry.js' } } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, rootDir: 'source', outDir: 'build', skipLibCheck: true } }),
      'source/entry.ts': `import { createServer } from 'node:http';\nimport express from 'express';\nimport { mount } from '../src/http/mount.js';\nexport const server = createServer(mount(express()));\n`,
    },
    found: 'source/entry.ts: export server',
  },
  {
    name: 'Router-mounted structure: nested routers under /v1, built by main()',
    files: {
      ...NO_SHARED_ROUTES,
      'src/routes/items.ts': `import { Router } from 'express';\nimport { notFound } from '../http/problems.js';\nexport const itemRoutes = Router();\nitemRoutes.get('/', (_req, res) => {\n  res.json({ data: [], nextCursor: null });\n});\nitemRoutes.get('/:itemId', (req, _res) => {\n  throw notFound(\`item \${req.params['itemId'] ?? ''} not found\`);\n});\n`,
      'src/routes/index.ts': `import { Router } from 'express';\nimport { itemRoutes } from './items.js';\nexport const apiRouter = Router();\napiRouter.use('/items', itemRoutes);\n`,
      'src/main.ts': `import express from 'express';\nimport { problemHandler, routeNotFound } from './http/problems.js';\nimport { apiRouter } from './routes/index.js';\nexport function main() {\n  const app = express();\n  app.use(express.json());\n  app.use('/v1', apiRouter);\n  app.use(routeNotFound);\n  app.use(problemHandler);\n  return app;\n}\n`,
    },
    found: 'src/main.ts: export main()',
  },
  {
    name: 'a sub-app mounted on the app, default export',
    files: {
      'src/app.ts': `import express from 'express';\nimport { itemsRouter } from './http/items.js';\nimport { problemHandler, routeNotFound } from './http/problems.js';\nconst api = express();\napi.use(express.json());\napi.use(itemsRouter());\nconst app = express();\napp.use(api);\napp.use(routeNotFound);\napp.use(problemHandler);\nexport default app;\n`,
    },
    found: 'src/app.ts: default export',
  },
  {
    name: 'a class that holds the app',
    files: { 'src/app.ts': `import express, { type Express } from 'express';\nimport { mount } from './http/mount.js';\nexport class App {\n  readonly express: Express = mount(express());\n}\n` },
    found: 'src/app.ts: export App()',
  },
  {
    name: 'async factory returning { app, close }',
    files: { 'src/server.ts': `import express from 'express';\nimport { mount } from './http/mount.js';\nexport async function buildServer() {\n  await Promise.resolve();\n  return { app: mount(express()), close: (): void => undefined };\n}\n` },
    found: 'src/server.ts: export buildServer()',
  },
  {
    name: 'an oddly named factory found by its return type; a decoy export is never called',
    files: {
      'src/app.ts': `import express, { type Express } from 'express';\nimport { mount } from './http/mount.js';\nexport function shutdown(): never {\n  process.exit(3);\n}\nexport function configure(): Express {\n  return mount(express());\n}\n`,
    },
    found: 'src/app.ts: export configure()',
  },
  {
    name: 'a factory that needs its dependencies; the entry file that passes them listens',
    files: {
      'src/app.ts': `import express, { type Express } from 'express';\nimport { mount } from './http/mount.js';\nexport function createApp(deps: { clock: () => number }): Express {\n  deps.clock();\n  return mount(express());\n}\n`,
      'src/index.ts': `import { createApp } from './app.js';\ncreateApp({ clock: () => Date.now() }).listen(${HELD});\n`,
    },
    found: 'src/index.ts: the server it starts with listen() while loading',
  },
  {
    name: 'root-level index.ts, no src entry',
    files: { 'index.ts': `import express from 'express';\nimport { mount } from './src/http/mount.js';\nexport default mount(express());\n` },
    found: 'index.ts: default export',
  },
  {
    name: 'harness.template.json entry wins over the conventional files',
    files: {
      'harness.template.json': JSON.stringify({ entry: { module: 'src/alt/entry.ts', export: 'makeAltApp' } }),
      'src/app.ts': `export function createApp(): never {\n  throw new Error('the conventional file must not be used');\n}\n`,
      'src/alt/entry.ts': `import express from 'express';\nimport { mount } from '../http/mount.js';\nexport const makeAltApp = () => mount(express());\n`,
    },
    found: 'src/alt/entry.ts: export makeAltApp()',
  },
];

let held: Server;
let heldPort = 0;
const roots: string[] = [];

beforeAll(async () => {
  held = createServer();
  await new Promise<void>((resolve) => held.listen(0, resolve));
  const addr = held.address();
  heldPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => held.close(() => resolve()));
  for (const r of roots) await removeTempApi(r);
});

async function api(files: Record<string, string>): Promise<string> {
  const withPort = Object.fromEntries(Object.entries({ 'package.json': pkg(), ...SHARED, ...files }).map(([k, v]) => [k, v.replaceAll(HELD, String(heldPort))]));
  const root = await tempApi(withPort);
  roots.push(root);
  return root;
}

async function probe(root: string): Promise<{ run: ProbeRun; log: string }> {
  const logs = memoryLogs();
  const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
  const run = await runProbe(ctx, extractRoutes(ctx.program(), ctx.root, ctx.sourceFiles));
  return { run, log: logs.entries.get('problem-json-probe.txt') ?? '' };
}

async function check(root: string): Promise<CheckFinding[]> {
  const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
  return (await problemJson.run(ctx)).filter((f) => f.file === '(runtime)');
}

describe('app layouts: every one is found, served on the harness port and probed', () => {
  // One at a time: each run builds a TypeScript program (blocking this worker) while another's requests are in flight.
  it.each(LAYOUTS)('$name', async ({ files, found }) => {
    const { run, log } = await probe(await api(files));
    expect(run.ok, 'reason' in run ? run.reason : log).toBe(true);
    if (!run.ok) return;
    expect(run.entry, log).toContain(found);
    // the child exited on the stop file, not on the harness timeout (nothing kept it alive)
    expect(log).toContain('timedOut=false');
    expect(run.outcomes.filter((o) => !o.ok || o.unproven !== undefined), log).toEqual([]);
    // the injected throwing route was reached: the 500 probe was judged, not dropped
    expect(run.outcomes.find((o) => o.probe.path === INTERNAL_ERROR_PATH)?.unproven).toBeUndefined();
    expect(run.outcomes.some((o) => o.probe.path === INTERNAL_ERROR_PATH)).toBe(true);
  });

  it('the audit style-c API (export const app, index.ts listens) is fully probed', async () => {
    const findings = await check(join(FIXTURES, 'style-c-app-instance'));
    expect(findings.map((f) => f.status)).toEqual(['pass']);
    // unknown route, collection success, 2 POST body probes + missing key, 3 unknown ids, PATCH bodies, internal error
    expect(findings[0]?.units.total).toBeGreaterThanOrEqual(10);
    expect(findings[0]?.units.passed).toBe(findings[0]?.units.total);
  });
});

describe('negative layouts', () => {
  it('no module holds an app: UNPROVEN, naming each module tried and why', async () => {
    const { run } = await probe(await api({ 'src/index.ts': `export const VERSION = '1';\nexport function helper(): number {\n  return 1;\n}\n`, 'src/server.ts': `import './missing-module.js';\n` }));
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.reason).toContain('no HTTP app found');
    expect(run.reason).toContain('src/index.ts: no app among its exports (VERSION, helper)');
    expect(run.reason).toMatch(/src\/server\.ts: import failed \(.*missing-module/);
    expect(run.reason).toContain('nothing called listen()');
  });

  it('no candidate module at all: UNPROVEN without starting anything', async () => {
    const { run } = await probe(await api({ 'package.json': pkg({ main: 'dist/gone.js' }) }));
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.reason).toMatch(/^no app entry found: none of src\/app\.ts, src\/index\.ts, src\/server\.ts, src\/main\.ts, app\.ts/);
    expect(run.reason).toContain('dist/gone.js (package.json "main")');
  });

  it('a module that only exports a Router is not taken for an app', async () => {
    const { run } = await probe(await api({ 'src/app.ts': `import { itemsRouter } from './http/items.js';\nexport const router = itemsRouter();\nexport default router;\n` }));
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.reason).toContain('default export is a Router, not an app');
  });

  it('every factory throws: UNPROVEN with the error, never pass', async () => {
    const findings = await check(await api({ 'src/app.ts': `export function createApp(): never {\n  throw new Error('database unavailable');\n}\n` }));
    expect(findings.map((f) => f.status)).toEqual(['skip']);
    expect(findings[0]?.skipReason).toContain('export createApp() threw (Error: database unavailable)');
  });

  it('an app found by capture whose errors are not problem+json: FAIL, naming the app it probed', async () => {
    const findings = await check(
      await api({
        ...NO_SHARED_ROUTES,
        'src/index.ts': `import express from 'express';\nconst app = express();\napp.use(express.json());\napp.get('/v1/things', (_req, res) => {\n  res.json({ data: [] });\n});\napp.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {\n  res.status(500).json({ error: String(err) });\n});\napp.listen(${HELD});\n`,
      }),
    );
    expect(findings.map((f) => f.status)).toEqual(['fail']);
    const messages = findings[0]?.violations.map((v) => v.message) ?? [];
    expect(messages.some((m) => m.includes('expected application/problem+json'))).toBe(true);
    expect(messages.find((m) => m.includes('(internal error)'))).toContain('body leaks the internal error message');
    expect(messages.find((m) => m.includes('(unknown route)'))).toContain('[app: src/index.ts: the server it starts with listen() while loading]');
    expect(findings[0]?.violations.find((v) => v.message.includes('(unknown route)'))?.location).toBe('src/index.ts:1:1');
  });

  it.each([
    ['a plain node handler', `import { createServer } from 'node:http';\ncreateServer((req, res) => {\n  res.statusCode = 404;\n  res.setHeader('content-type', 'application/problem+json');\n  res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'none', instance: req.url ?? '/' }));\n}).listen(${HELD});\n`],
    ['an Express app wrapped in another handler', `import { createServer } from 'node:http';\nimport express from 'express';\nimport { mount } from './http/mount.js';\nconst app = mount(express());\ncreateServer((req, res) => app(req, res)).listen(${HELD});\n`],
  ])('%s: the internal-error probe is UNPROVEN (the throwing route cannot be injected), not dropped', async (name, server) => {
    const findings = await check(await api(name.startsWith('a plain') ? { ...NO_SHARED_ROUTES, 'src/server.ts': server } : { 'src/server.ts': server }));
    expect(findings.map((f) => f.status)).toEqual(['pass', 'skip']);
    expect(findings[1]?.skipReason).toContain(`${INTERNAL_ERROR_PATH} (internal error): the harness could not inject its throwing route`);
    expect(findings[1]?.skipReason).toContain('[app: src/server.ts: the server it starts with listen() while loading]');
  });
});

describe('Idempotency-Key', () => {
  const REQUIRE_KEY = `import type { RequestHandler } from 'express';\nimport { HttpProblem } from './problems.js';\nexport const requireKey: RequestHandler = (req, _res, next) => {\n  if (req.method === 'POST' && req.get('idempotency-key') === undefined) {\n    next(new HttpProblem(428, 'Precondition Required', 'urn:problem:idempotency-key-required', 'Idempotency-Key header is required'));\n    return;\n  }\n  next();\n};\n`;
  const app = (guard: string): string =>
    `import express from 'express';\nimport { itemsRouter } from './http/items.js';\nimport { problemHandler, routeNotFound } from './http/problems.js';\nimport { requireKey } from './http/key.js';\nexport function createApp() {\n  const app = express();\n  app.use(express.json());\n  app.use(${guard});\n  app.use(itemsRouter());\n  app.use(routeNotFound);\n  app.use(problemHandler);\n  return app;\n}\n`;

  it('an API that requires the key passes: every write probe carries one, the missing-key probe gets a 428 problem', async () => {
    const { run, log } = await probe(await api({ 'src/http/key.ts': REQUIRE_KEY, 'src/app.ts': app('requireKey') }));
    expect(run.ok, 'reason' in run ? run.reason : log).toBe(true);
    if (!run.ok) return;
    expect(run.outcomes.filter((o) => !o.ok), log).toEqual([]);
    expect(run.outcomes.find((o) => o.probe.name === 'missing Idempotency-Key')?.status).toBe(428);
    expect(run.outcomes.find((o) => o.probe.name === 'invalid body')?.status).toBe(422);
  });

  it('a missing key answered with a non-problem body fails exactly that probe', async () => {
    const plain = `(req: express.Request, res: express.Response, next: express.NextFunction) => {\n    if (req.method === 'POST' && req.get('idempotency-key') === undefined) {\n      res.status(428).json({ error: 'key required' });\n      return;\n    }\n    next();\n  }`;
    const { run, log } = await probe(await api({ 'src/http/key.ts': REQUIRE_KEY, 'src/app.ts': app(plain) }));
    expect(run.ok, 'reason' in run ? run.reason : log).toBe(true);
    if (!run.ok) return;
    expect(run.outcomes.filter((o) => !o.ok).map((o) => `${o.probe.name}: ${o.problems.join('; ')}`), log).toEqual([
      'missing Idempotency-Key: Content-Type is "application/json; charset=utf-8", expected application/problem+json; body.type is not a string; body.title is not a string; body.detail is not a string; body.instance is not a string; body.status is not an integer',
    ]);
  });
});
