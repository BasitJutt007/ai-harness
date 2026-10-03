/**
 * Child-process side of the problem+json probes (spawned with tsx by probe.ts).
 *
 *   tsx probe-runtime.ts <apiRoot> <probes.json> <port> <stopFile>
 *
 * Imports createApp from <apiRoot>/src/app.ts, injects the throwing route of the internal-error
 * probe, listens on 127.0.0.1:<port> (chosen by the harness) and keeps serving until <stopFile>
 * exists. That is ALL it does: it reports nothing. The harness parent sends every request and
 * judges every response itself, because this process runs agent code (createApp), which could
 * rewrite anything this process prints.
 * Runs inside the OS sandbox (probe.ts passes the policy): agent code may write only the
 * per-call temp dir and reach only loopback.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

/** The child never outlives this, even if the harness never writes the stop file. */
const MAX_LIFETIME_MS = 55_000;

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

async function main(): Promise<void> {
  const [apiRoot, probesFile, portArg, stopFile] = process.argv.slice(2);
  if (apiRoot === undefined || probesFile === undefined || portArg === undefined || stopFile === undefined) {
    throw new Error('usage: probe-runtime <apiRoot> <probes.json> <port> <stopFile>');
  }
  const probes = readProbes(JSON.parse(await readFile(probesFile, 'utf8')));
  const mod: unknown = await import(pathToFileURL(join(apiRoot, 'src', 'app.ts')).href);
  const createApp = typeof mod === 'object' && mod !== null && 'createApp' in mod ? mod.createApp : undefined;
  if (typeof createApp !== 'function') throw new Error('src/app.ts does not export createApp()');
  const app: unknown = await Promise.resolve(createApp());
  if (!isListenable(app)) throw new Error('createApp() did not return an app with listen()');
  for (const p of probes) if (p.throwMarker !== undefined) injectThrowingRoute(app, p.path, p.throwMarker);
  await new Promise<Server>((resolveServer, reject) => {
    const s = app.listen(Number(portArg), '127.0.0.1', () => resolveServer(s));
    s.on('error', reject);
  });
  const started = Date.now();
  // Exit explicitly: the app may hold open handles (timers, pools) we do not own.
  setInterval(() => {
    if (existsSync(stopFile) || Date.now() - started > MAX_LIFETIME_MS) process.exit(0);
  }, 50);
}

main().catch((e: unknown) => {
  process.stderr.write(`probe runtime: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exit(1);
});
