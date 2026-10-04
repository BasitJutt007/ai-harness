/**
 * Runtime problem+json probes. Builds the probe list from the extracted routes, finds the API's
 * app (app-entry.ts lists the candidate modules; the confined child `probe-runtime.ts`, tsx, loads
 * them and serves the first app it finds), sends every request from the harness process itself and
 * judges each response here. If no app can be started the caller reports UNPROVEN, never pass.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CheckContext } from '../../src/core/plugin-api.ts';
import { hasPathParams } from './api-ast.ts';
import type { RouteInfo } from './api-ast.ts';
import { annotateTypedExports, describeSearch, discoverEntries } from './app-entry.ts';
import type { AppEntry } from './app-entry.ts';

export const PROBE_UUID = '00000000-0000-4000-8000-000000000000';
export const PROBE_TIMEOUT_MS = 60_000;
/** Path of the throwing route the runtime injects at the front of the app's router (internal-error probe). */
export const INTERNAL_ERROR_PATH = '/__harness_probe__/internal-error';
/**
 * Path of the control route injected next to it (answers 200 with a per-call nonce): when the harness
 * cannot reach it, the throwing route was not injected either and the internal-error probe is UNPROVEN.
 */
export const CONTROL_PATH = '/__harness_probe__/control';

export interface Probe {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Raw request body (sent with Content-Type: application/json). */
  body?: string;
  expect: number[];
  /**
   * 'problem' (default): the response must be application/problem+json.
   * 'success': a 2xx must be a JSON body that is NOT problem+json (401/403 must be problems).
   */
  kind?: 'problem' | 'success';
  /**
   * The runtime injects a route at `path` that throws `new Error(<marker>)` before the request;
   * the response must not contain the marker or a stack trace. UNPROVEN if injection is impossible.
   */
  throwMarker?: string;
  /** Send no Idempotency-Key header (every other POST/PUT/PATCH probe carries a fresh random one). */
  omitIdempotencyKey?: boolean;
}

export const ProbeResponseSchema = z.object({ status: z.number().int(), contentType: z.string(), body: z.string() });
export type ProbeResponse = z.infer<typeof ProbeResponseSchema>;

/** Bytes of each response body kept for judging and the log. */
const MAX_BODY = 4096;
/** Per-request budget (generous: a busy machine can stall the app or this process for seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

export interface ProbeOutcome {
  probe: Probe;
  ok: boolean;
  status: number | null;
  problems: string[];
  /** Set when the probe could not be carried out (not judged): why it is UNPROVEN. */
  unproven?: string;
}

export type ProbeRun =
  | {
      ok: true;
      outcomes: ProbeOutcome[];
      /** Candidate module the runtime says it served (informational: printed by a process running agent code). */
      entryModule?: string;
      /** How the runtime says it found the app, e.g. "src/app.ts: export createApp()" (informational). */
      entry?: string;
      logPath?: string;
    }
  | { ok: false; reason: string; logPath?: string };

export interface ProbeOptions {
  /** Explicit app entry (e.g. from the task); tried before every discovered candidate. */
  entry?: AppEntry;
}

/** Replace `:param` segments (Express syntax, optional `?` suffix) with the probe uuid. */
export function substituteParams(path: string): string {
  return path
    .split('/')
    .map((s) => (s.startsWith(':') ? PROBE_UUID : s))
    .join('/');
}

function versionBase(routes: RouteInfo[]): string {
  for (const r of routes) {
    const m = /^\/v\d+(?=\/|$)/.exec(r.path);
    if (m) return m[0];
  }
  return '';
}

/**
 * The probe set of the problem-json rule doc (plugins/checks/problem-json.ts; docs/design.md §5), deduplicated and in a stable order, plus (additions) a success
 * probe per collection GET (2xx must not be problem+json), a missing-Idempotency-Key probe per POST
 * collection route, and an internal-error probe (a thrown non-HTTP error must become a 500 problem
 * that leaks neither its message nor a stack trace).
 */
export function buildProbes(routes: RouteInfo[], marker = `harness-probe-secret-${randomBytes(6).toString('hex')}`): Probe[] {
  const probes: Probe[] = [];
  const seen = new Set<string>();
  const add = (p: Probe): void => {
    const key = `${p.name}|${p.method}|${p.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(p);
  };
  add({ name: 'unknown route', method: 'GET', path: `${versionBase(routes)}/__harness_probe__/does-not-exist`, expect: [404] });
  for (const r of routes) {
    if (/[*()?+[\]]/.test(r.path)) continue; // patterns we cannot instantiate deterministically
    const method = r.method.toUpperCase() as Probe['method'];
    const path = substituteParams(r.path);
    const params = hasPathParams(r.path);
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      add({ name: 'malformed JSON body', method, path, body: '{"__harness_probe__": ', expect: [400] });
      add({ name: 'invalid body', method, path, body: '[]', expect: params ? [422, 404] : [422] });
    }
    if (method === 'POST' && !(r.path.split('/').pop() ?? '').startsWith(':')) {
      // A create without Idempotency-Key (and with an invalid body, so nothing is created): an API that
      // requires the key answers 400/428, one that does not answers 422; either way a problem.
      add({ name: 'missing Idempotency-Key', method, path, body: '[]', expect: params ? [400, 422, 428, 404] : [400, 422, 428], omitIdempotencyKey: true });
    }
    if (params && (method === 'GET' || method === 'PATCH' || method === 'DELETE')) {
      add({ name: 'unknown id', method, path, ...(method === 'PATCH' ? { body: '{}' } : {}), expect: [404, 422] });
    }
    if (method === 'GET' && !params) {
      add({ name: 'collection success', method, path, expect: [200, 401, 403], kind: 'success' });
    }
  }
  add({ name: 'internal error', method: 'GET', path: INTERNAL_ERROR_PATH, expect: [500], throwMarker: marker });
  return probes;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const PROBLEM_CT = /^application\/problem\+json\b/i;
const STACK_FRAME = /\bat \S.*:\d+:\d+\)?/;

/** Judge one response: problem probes against the problem+json contract, success probes against "JSON, not a problem". */
export function evaluateProbe(probe: Probe, res: ProbeResponse): ProbeOutcome {
  if (probe.kind === 'success' && res.status >= 200 && res.status < 300) {
    const problems: string[] = [];
    if (!probe.expect.includes(res.status)) problems.push(`expected status ${probe.expect.join(' or ')}, got ${res.status}`);
    if (PROBLEM_CT.test(res.contentType)) problems.push('a successful response is sent as application/problem+json');
    else if (!/^application\/json\b/i.test(res.contentType)) problems.push(`Content-Type is "${res.contentType || '(none)'}", expected application/json`);
    try {
      JSON.parse(res.body);
    } catch {
      problems.push('body is not JSON');
    }
    return { probe, ok: problems.length === 0, status: res.status, problems };
  }
  const problems: string[] = [];
  if (!probe.expect.includes(res.status)) problems.push(`expected status ${probe.expect.join(' or ')}, got ${res.status}`);
  if (probe.throwMarker !== undefined && res.body.includes(probe.throwMarker)) problems.push('body leaks the internal error message');
  if (probe.throwMarker !== undefined && STACK_FRAME.test(res.body)) problems.push('body leaks a stack trace');
  if (!PROBLEM_CT.test(res.contentType)) {
    problems.push(`Content-Type is "${res.contentType || '(none)'}", expected application/problem+json`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    problems.push('body is not JSON');
  }
  if (parsed !== undefined) {
    if (!isRecord(parsed)) {
      problems.push('body is not a JSON object');
    } else {
      for (const key of ['type', 'title', 'detail', 'instance']) {
        if (typeof parsed[key] !== 'string') problems.push(`body.${key} is not a string`);
      }
      const st = parsed['status'];
      if (typeof st !== 'number' || !Number.isInteger(st)) problems.push('body.status is not an integer');
      else if (st !== res.status) problems.push(`body.status ${st} differs from HTTP status ${res.status}`);
    }
  }
  return { probe, ok: problems.length === 0, status: res.status, problems };
}

/** A loopback port nobody listens on right now (the OS picks it; we release it for the child to bind). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

/** Send one probe from the harness process and record the raw response. */
async function send(base: string, p: Probe): Promise<ProbeResponse | { error: string }> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (p.body !== undefined) headers['content-type'] = 'application/json';
    if ((p.method === 'POST' || p.method === 'PUT' || p.method === 'PATCH') && p.omitIdempotencyKey !== true) headers['idempotency-key'] = randomUUID();
    const init: RequestInit = { method: p.method, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers };
    if (p.body !== undefined) init.body = p.body;
    const res = await fetch(`${base}${p.path}`, init);
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: text.slice(0, MAX_BODY) };
  } catch (e) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** Poll until something accepts HTTP on `base`, the child exits, or the deadline passes. */
async function waitForServer(base: string, exited: () => boolean, deadline: number): Promise<boolean> {
  while (!exited() && Date.now() < deadline) {
    try {
      await fetch(`${base}/__harness_probe__/ready`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

/** Last line the runtime printed with its prefix, control characters blanked (a process running agent code: informational only). */
function runtimeLine(stderr: string, prefix: string): string | undefined {
  const lines = stderr.split('\n').filter((l) => l.startsWith(`probe runtime: ${prefix}`));
  return lines[lines.length - 1]?.slice('probe runtime: '.length).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** Bytes of a runtime-reported reason kept in an UNPROVEN finding. */
const MAX_REASON = 1600;

/**
 * Find and start the app in a confined child (probe-runtime.ts) on a port the harness picked, then
 * send every probe FROM THIS PROCESS and judge the responses here. The child only serves: nothing it
 * prints is trusted, since it runs agent code that could rewrite its own output. The internal-error
 * probe counts only when the harness itself reaches the injected control route; otherwise it is UNPROVEN.
 */
export async function runProbe(ctx: CheckContext, routes: RouteInfo[], opts: ProbeOptions = {}): Promise<ProbeRun> {
  const discovery = discoverEntries(ctx.root, opts.entry, ctx.layout?.sourceRoots);
  if (discovery.candidates.length === 0) return { ok: false, reason: `no app entry found: ${describeSearch(discovery)}` };
  try {
    annotateTypedExports(ctx.program(), ctx.root, discovery.candidates);
  } catch {
    // types only rank exports; the runtime still tries names and shapes
  }
  const entries = discovery.candidates.map((c) => ({ module: c.module, typedExports: c.typedExports ?? [], ...(c.export !== undefined ? { export: c.export } : {}) }));
  const probes = buildProbes(routes);
  const control = { path: CONTROL_PATH, body: `harness-probe-control-${randomBytes(6).toString('hex')}` };
  // Short per-call dir under the OS temp dir: it becomes the confined child's TMPDIR, and tsx puts a
  // unix socket there whose path must stay under the 104-byte limit (a .harness/tmp path can exceed it).
  const dir = await mkdtemp(join(tmpdir(), 'harness-probe-'));
  const file = join(dir, 'probes.json');
  const stop = join(dir, 'stop');
  try {
    await writeFile(file, JSON.stringify({ probes, entries, control }), 'utf8');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const tsx = join(ctx.harnessRoot, 'node_modules', '.bin', 'tsx');
    const runtime = join(ctx.harnessRoot, 'plugins', 'lib', 'probe-runtime.ts');
    // The candidate modules are agent code: confined, the API source read-only (the runtime only imports it),
    // writes only to this per-call dir (the sandbox points TMPDIR, hence tsx's cache, here), loopback only.
    let exited = false;
    const child = ctx.exec(tsx, [runtime, ctx.root, file, String(port), stop], {
      cwd: ctx.root,
      timeoutMs: PROBE_TIMEOUT_MS,
      sandbox: { writable: [dir], network: 'localhost' },
    }).finally(() => {
      exited = true;
    });
    const up = await waitForServer(base, () => exited, Date.now() + PROBE_TIMEOUT_MS - 5_000);
    const controlProbe: Probe = { name: 'control', method: 'GET', path: control.path, expect: [200] };
    let reached: ProbeResponse | { error: string } = { error: 'not served' };
    // A transport error is retried once: only an answer decides whether the routes were injected.
    for (let attempt = 0; up && attempt < 2 && 'error' in reached; attempt++) reached = await send(base, controlProbe);
    const injected = !('error' in reached) && reached.status === 200 && reached.body === control.body;
    const responses: Array<ProbeResponse | { error: string }> = [];
    if (up) for (const p of probes) responses.push(await send(base, p));
    await writeFile(stop, '', 'utf8');
    const res = await child;
    const entry = runtimeLine(res.stderr, 'serving ')?.replace(/^serving /, '').replace(/; probe routes .*$/, '');
    const logPath = await ctx.logs.write(
      'problem-json-probe.txt',
      [`$ tsx probe-runtime.ts ${ctx.root} (port ${port})`, `exit=${String(res.code)} timedOut=${String(res.timedOut)} served=${String(up)}`,
        `candidates: ${discovery.candidates.map((c) => `${c.module}${c.export !== undefined ? `#${c.export}` : ''} (${c.why})`).join(', ')}`,
        `app (as reported by the runtime): ${entry ?? '(none)'}`,
        `control ${control.path} -> ${JSON.stringify(reached)} injected=${String(injected)}`,
        '--- responses (sent and recorded by the harness)', ...responses.map((r, i) => `${probes[i]?.method ?? ''} ${probes[i]?.path ?? ''} -> ${JSON.stringify(r)}`),
        '--- stdout', res.stdout, '--- stderr', res.stderr].join('\n'),
    );
    if (!up) {
      if (res.timedOut) return { ok: false, reason: `probe runtime timed out after ${PROBE_TIMEOUT_MS / 1000}s (candidates: ${entries.map((e) => e.module).join(', ')})`, logPath };
      const said = runtimeLine(res.stderr, '');
      if (said?.startsWith('no HTTP app found') === true) return { ok: false, reason: said.slice(0, MAX_REASON), logPath };
      const err = said ?? `${(res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' | ')} (candidates: ${entries.map((e) => e.module).join(', ')})`;
      return { ok: false, reason: `app could not be started (exit ${String(res.code)}): ${err.slice(0, MAX_REASON)}`, logPath };
    }
    const outcomes: ProbeOutcome[] = [];
    probes.forEach((probe, i) => {
      const r = responses[i];
      if (r === undefined) outcomes.push({ probe, ok: false, status: null, problems: ['no response recorded'] });
      else if ('error' in r) outcomes.push({ probe, ok: false, status: null, problems: [`request failed: ${r.error}`] });
      else if (probe.throwMarker !== undefined && !injected) {
        const got = 'error' in reached ? `failed: ${reached.error}` : `answered ${reached.status}`;
        outcomes.push({
          probe, ok: false, status: r.status, problems: [],
          unproven: `the harness could not inject its throwing route into the served app (control request GET ${control.path} ${got}; only an Express app can be injected into), so whether a thrown error becomes a 500 problem without leaking is unproven`,
        });
      } else outcomes.push(evaluateProbe(probe, r));
    });
    const entryModule = entry === undefined ? undefined : entries.find((e) => entry.startsWith(`${e.module}:`))?.module;
    return { ok: true, outcomes, logPath, ...(entry !== undefined ? { entry: entry.slice(0, 300) } : {}), ...(entryModule !== undefined ? { entryModule } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
