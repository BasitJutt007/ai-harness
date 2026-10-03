/**
 * Child-process side of the problem+json probes (spawned with tsx by probe.ts).
 *
 *   tsx probe-runtime.ts <apiRoot> <probes.json> <port> <stopFile>
 *
 * Finds the API's HTTP app in the candidate modules the harness listed (app-entry.ts), in order:
 * per module, an exported factory (create*, build*, make*, start/main/bootstrap, anything named
 * *App/*Server, or typed to return an app) called with no arguments, the default export, an exported
 * app instance; or a server the module starts itself with listen() while it loads. It injects the
 * internal-error probe's throwing route and a control route at the front of the app's router, serves
 * on 127.0.0.1:<port> (chosen by the harness) and keeps serving until <stopFile> exists. That is ALL
 * it does: the harness parent sends every request and judges every response itself, because this
 * process runs agent code, which could rewrite anything this process prints (its "serving …" line
 * is informational only).
 *
 * listen() is guarded before any agent module loads: the first plain HTTP server to listen is bound
 * to the harness port, any other server to an OS-chosen loopback port, whatever the code asked for.
 * Runs inside the OS sandbox (probe.ts passes the policy): agent code may write only the per-call
 * temp dir and reach only loopback; the process exits on the stop file or after MAX_LIFETIME_MS.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ProbeIn {
  method: string;
  path: string;
  body?: string;
  /** Inject a route at `path` (front of the app router) that throws `new Error(throwMarker)`. */
  throwMarker?: string;
}

interface EntryIn {
  module: string;
  export?: string;
  /** Exports the harness found typed as returning something with listen(). */
  typedExports: string[];
}

/** A route the harness asks for in front of everything: GET path → 200 text/plain body. */
interface ControlIn {
  path: string;
  body: string;
}

interface RuntimeIn {
  probes: ProbeIn[];
  entries: EntryIn[];
  control?: ControlIn;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type ListenFn = (this: net.Server, ...args: unknown[]) => net.Server;
interface Servable {
  listen(...args: unknown[]): unknown;
}

/** The child never outlives this, even if the harness never writes the stop file. */
const MAX_LIFETIME_MS = 55_000;
/** Budget for loading one candidate module, and for one factory or listen() call. */
const IMPORT_MS = 15_000;
const CALL_MS = 5_000;
/** Export names worth calling with no arguments: factories, start/main entry points, app/server/api getters. */
const CALLABLE = /^(?:create|build|make|start|main|bootstrap|run|serve|listen|init|setup)(?![a-z])|^(?:[Aa]pp|[Aa]pplication|[Ss]erver|[Aa]pi)(?![a-z])|[a-z](?:App|Server|Api)/;
/** Properties that commonly hold the app on an object a factory returns (`{ app, close }`, a class instance). */
const HOLDERS = ['app', 'server', 'application', 'express', 'http'];
/** Express 4's own first layers (they set up req/res): our routes go right after them. */
const INIT_LAYERS = new Set(['query', 'expressInit']);
const SERVED = Symbol('served');

function isRecord(v: unknown): v is Record<string, unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function readInput(raw: unknown): RuntimeIn {
  const out: RuntimeIn = { probes: [], entries: [] };
  if (!isRecord(raw)) return out;
  for (const p of Array.isArray(raw['probes']) ? (raw['probes'] as unknown[]) : []) {
    if (!isRecord(p)) continue;
    const probe: ProbeIn = { method: str(p['method']) ?? 'GET', path: str(p['path']) ?? '/' };
    const body = str(p['body']);
    const marker = str(p['throwMarker']);
    if (body !== undefined) probe.body = body;
    if (marker !== undefined) probe.throwMarker = marker;
    out.probes.push(probe);
  }
  for (const e of Array.isArray(raw['entries']) ? (raw['entries'] as unknown[]) : []) {
    const module = isRecord(e) ? str(e['module']) : undefined;
    if (!isRecord(e) || module === undefined) continue;
    const typed = Array.isArray(e['typedExports']) ? (e['typedExports'] as unknown[]).filter((n): n is string => typeof n === 'string') : [];
    const exp = str(e['export']);
    out.entries.push(exp === undefined ? { module, typedExports: typed } : { module, export: exp, typedExports: typed });
  }
  const c = raw['control'];
  const path = isRecord(c) ? str(c['path']) : undefined;
  const body = isRecord(c) ? str(c['body']) : undefined;
  if (path !== undefined && body !== undefined) out.control = { path, body };
  return out;
}

function errText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.split('\n')[0]?.slice(0, 300) ?? '';
}

interface Guard {
  /** The HTTP server given the harness port, once one called listen(). */
  served(): http.Server | undefined;
  /** Resolves once that server is bound. */
  whenServed: Promise<void>;
}

/**
 * Replace net.Server.prototype.listen (http.Server inherits it) before any agent module loads. The
 * first plain HTTP server to listen is handed to `prepare` and bound to 127.0.0.1:<port>; every other
 * server (https, raw TCP, a second app) goes to an OS-chosen loopback port. The port, host, path or
 * handle the code asked for is ignored; its listen callback still runs.
 */
function guardListen(port: number, prepare: (server: http.Server) => void): Guard {
  const proto = net.Server.prototype as unknown as { listen: ListenFn };
  const original = proto.listen;
  let served: http.Server | undefined;
  let markServed: () => void = () => undefined;
  const whenServed = new Promise<void>((resolveServed) => {
    markServed = resolveServed;
  });
  proto.listen = function guardedListen(this: net.Server, ...args: unknown[]): net.Server {
    const last = args[args.length - 1];
    const callback = typeof last === 'function' ? [last] : [];
    if (served === undefined && this instanceof http.Server) {
      served = this;
      prepare(this);
      this.once('listening', markServed);
      return original.call(this, port, '127.0.0.1', ...callback);
    }
    return original.call(this, 0, '127.0.0.1', ...callback);
  };
  return { served: () => served, whenServed };
}

/** `p`, unless a server got bound first (SERVED) or `ms` pass (rejects). */
function race<T>(p: Promise<T>, guard: Guard, ms: number): Promise<Awaited<T> | typeof SERVED> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, guard.whenServed.then((): typeof SERVED => SERVED), timeout]).finally(() => clearTimeout(timer));
}

function layerName(layer: unknown): string {
  return isRecord(layer) && typeof layer['name'] === 'string' ? layer['name'] : '';
}

/**
 * Register `GET path` routes on an Express app and move them to the front of its router (after
 * Express 4's init layers): Express 5 `app.router`, Express 4 `app._router`. They then run before any
 * agent route or middleware, and a throw reaches the app's own error middleware. False when the
 * served request handler is not an Express app we can do this to.
 */
function injectFront(app: unknown, routes: Array<{ path: string; handler: Handler }>): boolean {
  if (!isRecord(app) || typeof app['get'] !== 'function' || routes.length === 0) return false;
  try {
    for (const r of routes) app['get'].call(app, r.path, r.handler);
    const router = app['_router'] ?? app['router'];
    const stack = isRecord(router) ? router['stack'] : undefined;
    if (!Array.isArray(stack) || stack.length < routes.length) return false;
    const ours: unknown[] = stack.splice(stack.length - routes.length, routes.length);
    let at = 0;
    while (at < stack.length && INIT_LAYERS.has(layerName(stack[at]))) at++;
    stack.splice(at, 0, ...ours);
    return true;
  } catch {
    return false;
  }
}

/** An Express/connect Router: a request handler with a layer stack but no listen(): not an app. */
function isRouter(v: unknown): boolean {
  return typeof v === 'function' && isRecord(v) && Array.isArray(v['stack']) && typeof v['handle'] === 'function' && typeof v['listen'] !== 'function';
}

function isServable(v: unknown): v is Servable {
  return isRecord(v) && typeof v['listen'] === 'function';
}

/** `v` when it can listen() (an app, an http.Server), else an app it holds (`{ app }`, an instance's `.server`). */
function appIn(v: unknown): Servable | undefined {
  if (isServable(v)) return v;
  if (!isRecord(v) || typeof v === 'function') return undefined;
  for (const key of [...HOLDERS, ...Object.keys(v)]) {
    let inner: unknown;
    try {
      inner = v[key];
    } catch {
      continue;
    }
    if (isServable(inner)) return inner;
  }
  return undefined;
}

/** Call an exported function with no arguments (`new` for a class). */
function invoke(fn: unknown): unknown {
  if (typeof fn !== 'function') return undefined;
  if (/^class[\s{]/.test(Function.prototype.toString.call(fn))) return new (fn as new () => unknown)();
  return (fn as () => unknown)();
}

/** The export names to try, best first: the declared export, factories, the default export, app instances, typed factories. */
function exportOrder(mod: Record<string, unknown>, entry: EntryIn): string[] {
  const names = Object.keys(mod);
  const named = names.filter((n) => n !== 'default');
  return [
    ...new Set([
      ...(entry.export !== undefined ? [entry.export] : []),
      ...named.filter((n) => CALLABLE.test(n) && typeof mod[n] === 'function' && !isServable(mod[n])),
      ...(names.includes('default') ? ['default'] : []),
      ...named.filter((n) => appIn(mod[n]) !== undefined),
      ...entry.typedExports,
    ]),
  ].filter((n) => names.includes(n));
}

/** listen() on an app (the guard binds it to the harness port); the label when that served it. */
async function serveApp(app: Servable, label: string, guard: Guard, notes: string[]): Promise<string | undefined> {
  if (guard.served() === undefined) {
    try {
      await race(Promise.resolve().then(() => app.listen()), guard, CALL_MS);
    } catch (e) {
      if (guard.served() === undefined) {
        notes.push(`${label}.listen() failed (${errText(e)})`);
        return undefined;
      }
    }
  }
  if (guard.served() === undefined) {
    notes.push(`${label}.listen() started no plain HTTP server`);
    return undefined;
  }
  return label;
}

async function tryExport(value: unknown, label: string, guard: Guard, notes: string[]): Promise<string | undefined> {
  const direct = appIn(value);
  if (direct !== undefined) return serveApp(direct, label, guard, notes);
  if (isRouter(value)) {
    notes.push(`${label} is a Router, not an app`);
    return undefined;
  }
  if (typeof value !== 'function') return undefined;
  let out: unknown;
  try {
    out = await race(Promise.resolve().then(() => invoke(value)), guard, CALL_MS);
  } catch (e) {
    if (guard.served() !== undefined) return `${label}() (it called listen())`;
    notes.push(`${label}() threw (${errText(e)})`);
    return undefined;
  }
  if (guard.served() !== undefined) return `${label}() (it called listen())`;
  const app = appIn(out);
  if (app === undefined) {
    notes.push(`${label}() returned no app`);
    return undefined;
  }
  return serveApp(app, `${label}()`, guard, notes);
}

/** Load one candidate module and look for the app in it; how it was found, or undefined (with a note in `tried`). */
async function tryEntry(root: string, entry: EntryIn, guard: Guard, tried: string[]): Promise<string | undefined> {
  const where = entry.module;
  let mod: unknown;
  try {
    mod = await race(import(pathToFileURL(join(root, entry.module)).href), guard, IMPORT_MS);
  } catch (e) {
    if (guard.served() !== undefined) return `${where}: the server it starts with listen() while loading`;
    tried.push(`${where}: import failed (${errText(e)})`);
    return undefined;
  }
  if (guard.served() !== undefined) return `${where}: the server it starts with listen() while loading`;
  if (!isRecord(mod)) {
    tried.push(`${where}: not a module`);
    return undefined;
  }
  const notes: string[] = [];
  if (entry.export !== undefined && !(entry.export in mod)) notes.push(`declared export ${entry.export} not found`);
  for (const name of exportOrder(mod, entry)) {
    const how = await tryExport(mod[name], name === 'default' ? 'default export' : `export ${name}`, guard, notes);
    if (how !== undefined) return `${where}: ${how}`;
  }
  const names = Object.keys(mod);
  tried.push(`${where}: no app among its exports (${names.length > 0 ? names.join(', ') : 'none'})${notes.length > 0 ? ` [${notes.join('; ')}]` : ''}`);
  return undefined;
}

async function main(): Promise<void> {
  const [apiRoot, inputFile, portArg, stopFile] = process.argv.slice(2);
  if (apiRoot === undefined || inputFile === undefined || portArg === undefined || stopFile === undefined) {
    throw new Error('usage: probe-runtime <apiRoot> <probes.json> <port> <stopFile>');
  }
  const started = Date.now();
  // Exit explicitly: the app may hold open handles (timers, pools) we do not own, or never finish loading.
  setInterval(() => {
    if (existsSync(stopFile) || Date.now() - started > MAX_LIFETIME_MS) process.exit(0);
  }, 50);
  const input = readInput(JSON.parse(await readFile(inputFile, 'utf8')));
  const routes: Array<{ path: string; handler: Handler }> = [];
  for (const p of input.probes) {
    const marker = p.throwMarker;
    if (marker !== undefined) {
      routes.push({
        path: p.path,
        handler: () => {
          throw new Error(marker);
        },
      });
    }
  }
  const control = input.control;
  if (control !== undefined) {
    routes.push({
      path: control.path,
      handler: (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(control.body);
      },
    });
  }
  let injected = false;
  const guard = guardListen(Number(portArg), (server) => {
    const inject = (): void => {
      if (!injected) injected = injectFront(server.listeners('request')[0], routes);
    };
    inject();
    server.once('listening', inject); // a 'request' listener attached after listen()
  });
  const tried: string[] = [];
  let how: string | undefined;
  for (const entry of input.entries) {
    how = await tryEntry(apiRoot, entry, guard, tried);
    if (how !== undefined) break;
  }
  if (how === undefined && input.entries.length > 0) {
    // A module may start its server after an async step it does not await (`connect().then(() => app.listen())`).
    try {
      await race(guard.whenServed, guard, CALL_MS);
    } catch {
      // nothing listened
    }
    if (guard.served() !== undefined) how = `a server started with listen() after loading (${input.entries.map((e) => e.module).join(', ')})`;
  }
  if (how === undefined) {
    const what = input.entries.length === 0 ? 'no candidate module' : `tried ${tried.join('; ')}`;
    throw new Error(`no HTTP app found: ${what}; nothing called listen()`);
  }
  await race(guard.whenServed, guard, CALL_MS);
  process.stderr.write(`probe runtime: serving ${how}; probe routes ${injected ? 'injected' : 'NOT injected (the served request handler is not an Express app)'}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`probe runtime: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
