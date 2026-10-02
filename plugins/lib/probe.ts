/**
 * Runtime problem+json probes. Builds the probe list from the extracted routes,
 * runs `probe-runtime.ts` in a child process (tsx) against the API's createApp,
 * and judges each response. If the app cannot be started the caller reports
 * UNPROVEN, never pass.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CheckContext } from '../../src/core/plugin-api.ts';
import { hasPathParams } from './api-ast.ts';
import type { RouteInfo } from './api-ast.ts';

export const PROBE_UUID = '00000000-0000-4000-8000-000000000000';
export const PROBE_TIMEOUT_MS = 60_000;
/** Path of the throwing route the runtime injects at the front of the app's router (internal-error probe). */
export const INTERNAL_ERROR_PATH = '/__harness_probe__/internal-error';

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
   * the response must not contain the marker or a stack trace. Not counted if injection is impossible.
   */
  throwMarker?: string;
}

export const ProbeResponseSchema = z.object({ status: z.number().int(), contentType: z.string(), body: z.string() });
export type ProbeResponse = z.infer<typeof ProbeResponseSchema>;

export const RuntimeOutputSchema = z.object({
  __harnessProbe: z.literal(1),
  ok: z.boolean(),
  error: z.string().optional(),
  responses: z.array(z.union([ProbeResponseSchema, z.object({ error: z.string() }), z.object({ skipped: z.string() })])).default([]),
});

export interface ProbeOutcome {
  probe: Probe;
  ok: boolean;
  status: number | null;
  problems: string[];
}

export type ProbeRun = { ok: true; outcomes: ProbeOutcome[]; logPath?: string } | { ok: false; reason: string; logPath?: string };

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
 * probe per collection GET (2xx must not be problem+json) and an internal-error probe (a thrown
 * non-HTTP error must become a 500 problem that leaks neither its message nor a stack trace).
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

function parseRuntimeOutput(stdout: string): z.infer<typeof RuntimeOutputSchema> | undefined {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('__harnessProbe')) continue;
    try {
      const r = RuntimeOutputSchema.safeParse(JSON.parse(t));
      if (r.success) return r.data;
    } catch {
      // not our line
    }
  }
  return undefined;
}

export async function runProbe(ctx: CheckContext, routes: RouteInfo[]): Promise<ProbeRun> {
  const probes = buildProbes(routes);
  const dir = join(ctx.harnessRoot, '.harness', 'tmp', `probe-${process.pid}-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'probes.json');
  try {
    await writeFile(file, JSON.stringify({ probes }), 'utf8');
    const tsx = join(ctx.harnessRoot, 'node_modules', '.bin', 'tsx');
    const runtime = join(ctx.harnessRoot, 'plugins', 'lib', 'probe-runtime.ts');
    const res = await ctx.exec(tsx, [runtime, ctx.root, file], { cwd: ctx.root, timeoutMs: PROBE_TIMEOUT_MS });
    const logPath = await ctx.logs.write(
      'problem-json-probe.txt',
      `$ tsx probe-runtime.ts ${ctx.root}\nexit=${String(res.code)} timedOut=${String(res.timedOut)}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`,
    );
    if (res.timedOut) return { ok: false, reason: `probe runtime timed out after ${PROBE_TIMEOUT_MS / 1000}s`, logPath };
    const out = parseRuntimeOutput(res.stdout);
    if (out === undefined) {
      const err = res.stderr.trim().split('\n').slice(-3).join(' | ');
      return { ok: false, reason: `probe runtime produced no result (exit ${String(res.code)}): ${err.slice(0, 300)}`, logPath };
    }
    if (!out.ok) return { ok: false, reason: `app could not be started: ${(out.error ?? 'unknown error').slice(0, 300)}`, logPath };
    const outcomes: ProbeOutcome[] = [];
    probes.forEach((probe, i) => {
      const r = out.responses[i];
      if (r === undefined) outcomes.push({ probe, ok: false, status: null, problems: ['no response recorded'] });
      else if ('skipped' in r) return; // e.g. the internal-error route could not be injected: not a unit
      else if ('error' in r) outcomes.push({ probe, ok: false, status: null, problems: [`request failed: ${r.error}`] });
      else outcomes.push(evaluateProbe(probe, r));
    });
    return { ok: true, outcomes, logPath };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
