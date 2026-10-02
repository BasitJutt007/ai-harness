/**
 * Child-process side of the problem+json probes (spawned with tsx by probe.ts).
 *
 *   tsx probe-runtime.ts <apiRoot> <probes.json>
 *
 * Imports createApp from <apiRoot>/src/app.ts, listens on an ephemeral port,
 * sends each probe with fetch, prints ONE JSON result line and exits.
 */
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ProbeIn {
  method: string;
  path: string;
  body?: string;
  /** Inject a route at `path` (front of the app router) that throws `new Error(throwMarker)`. */
  throwMarker?: string;
}

const MAX_BODY = 4096;

type Result = { __harnessProbe: 1; ok: boolean; error?: string; responses?: unknown[] };

const fail = (error: string): Result => ({ __harnessProbe: 1, ok: false, error });

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function readProbes(raw: unknown): ProbeIn[] {
  if (typeof raw !== 'object' || raw === null || !('probes' in raw) || !Array.isArray(raw.probes)) return [];
  const out: ProbeIn[] = [];
  for (const p of raw.probes as unknown[]) {
    if (typeof p !== 'object' || p === null) continue;
    const method = 'method' in p && typeof p.method === 'string' ? p.method : 'GET';
    const path = 'path' in p && typeof p.path === 'string' ? p.path : '/';
    const probe: ProbeIn = { method, path };
    if ('body' in p && typeof p.body === 'string') probe.body = p.body;
    if ('throwMarker' in p && typeof p.throwMarker === 'string') probe.throwMarker = p.throwMarker;
    out.push(probe);
  }
  return out;
}

function isListenable(v: unknown): v is { listen(port: number, host: string, cb: () => void): Server } {
  return typeof v === 'function' || (typeof v === 'object' && v !== null && 'listen' in v && typeof v.listen === 'function');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null;
}

/**
 * Register `GET path` → throw new Error(marker) on the app, then move that layer to the front of the
 * app router's stack so the request reaches the app's own error middleware (Express 5 `app.router`,
 * Express 4 `app._router`). Returns false when the app is not an Express app we can do this to.
 */
function injectThrowingRoute(app: unknown, path: string, marker: string): boolean {
  if (!isRecord(app) || typeof app['get'] !== 'function') return false;
  try {
    app['get'].call(app, path, () => {
      throw new Error(marker);
    });
    const router = app['_router'] ?? app['router'];
    const stack = isRecord(router) ? router['stack'] : undefined;
    if (!Array.isArray(stack) || stack.length === 0) return false;
    const layer: unknown = stack.pop();
    stack.unshift(layer);
    return true;
  } catch {
    return false;
  }
}

async function start(apiRoot: string, probes: ProbeIn[]): Promise<{ server: Server; injected: Set<ProbeIn> } | string> {
  const mod: unknown = await import(pathToFileURL(join(apiRoot, 'src', 'app.ts')).href);
  const createApp = typeof mod === 'object' && mod !== null && 'createApp' in mod ? mod.createApp : undefined;
  if (typeof createApp !== 'function') return 'src/app.ts does not export createApp()';
  const app: unknown = await Promise.resolve(createApp());
  if (!isListenable(app)) return 'createApp() did not return an app with listen()';
  const injected = new Set<ProbeIn>();
  for (const p of probes) {
    if (p.throwMarker !== undefined && injectThrowingRoute(app, p.path, p.throwMarker)) injected.add(p);
  }
  const server = await new Promise<Server>((resolveServer, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolveServer(s));
    s.on('error', reject);
  });
  return { server, injected };
}

async function main(): Promise<Result> {
  const [apiRoot, probesFile] = process.argv.slice(2);
  if (apiRoot === undefined || probesFile === undefined) return fail('usage: probe-runtime <apiRoot> <probes.json>');
  const probes = readProbes(JSON.parse(await readFile(probesFile, 'utf8')));

  let server: Server;
  let injected: Set<ProbeIn>;
  try {
    const started = await start(apiRoot, probes);
    if (typeof started === 'string') return fail(started);
    ({ server, injected } = started);
  } catch (e) {
    return fail(errorText(e));
  }

  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const responses: unknown[] = [];
  for (const p of probes) {
    if (p.throwMarker !== undefined && !injected.has(p)) {
      responses.push({ skipped: 'could not inject a throwing route into the app' });
      continue;
    }
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (p.body !== undefined) headers['content-type'] = 'application/json';
      const init: RequestInit = { method: p.method, redirect: 'manual', signal: AbortSignal.timeout(5000), headers };
      if (p.body !== undefined) init.body = p.body;
      const res = await fetch(`${base}${p.path}`, init);
      const text = await res.text();
      responses.push({ status: res.status, contentType: res.headers.get('content-type') ?? '', body: text.slice(0, MAX_BODY) });
    } catch (e) {
      responses.push({ error: errorText(e) });
    }
  }
  server.close();
  return { __harnessProbe: 1, ok: true, responses };
}

function emitAndExit(result: Result): void {
  // Exit explicitly: the app may hold open handles (timers, pools) we do not own.
  process.stdout.write(`\n${JSON.stringify(result)}\n`, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

main().then(emitAndExit, (e: unknown) => emitAndExit(fail(errorText(e))));
