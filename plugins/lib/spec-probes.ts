/**
 * Spec conformance, derived only from the task's structured data (resources × operations, field
 * specs, basePath, declared `Endpoint:` lines), never from resource or field names:
 *
 *   expectedEndpoints(task)   the endpoints the task asks for: list GET <base>/<plural>, create POST
 *                             <base>/<plural>, get / update (PATCH or PUT) / delete on <base>/<plural>/:param
 *   coverRoutes(...)          each expected endpoint against the static route table, with the runtime
 *                             evidence the scenario recorded (statuses the harness itself received)
 *   runScenario(client, ...)  behavioural probes generated from the field specs. The harness sends every
 *                             request (`client`) and judges every response here; the app only serves.
 *
 * Each behaviour is one unit: pass, fail, or unproven (it could not be decided: the API answered
 * 401/403, a request failed, no valid body can be built from the spec, a unit it depends on failed).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FieldSpec, GreenfieldTask, Operation, ResourceSpec } from '../../src/core/plugin-api.ts';
import { request } from './probe.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type UnitStatus = 'pass' | 'fail' | 'unproven';

export interface SpecUnit {
  /** Resource name (singular). */
  resource: string;
  /** `route GET /v1/users`, `create`, `get`, `list`, `update`, `delete`, `idempotency`, `idempotency after update`, `required email`, `enum role`, `max name`, `min name`, `unique email`. */
  name: string;
  status: UnitStatus;
  /** Pass: what was shown. Fail / unproven: why. */
  detail: string;
}

export interface ExpectedEndpoint {
  resource: string;
  op: Operation;
  /** Methods that satisfy it (update: PATCH or PUT). */
  methods: Method[];
  /** Candidate paths (`:param` for the item id), the task's declared ones first, then <base>/<plural>[/:id]. */
  paths: string[];
}

const OP_METHODS: Record<Operation, Method[]> = { list: ['GET'], create: ['POST'], get: ['GET'], update: ['PATCH', 'PUT'], delete: ['DELETE'] };
const ITEM_OPS = new Set<Operation>(['get', 'update', 'delete']);

function isParamSegment(s: string): boolean {
  return /^[:{<*]/.test(s) || /[}>?]$/.test(s);
}

/** `/V1/Users/{id}/` → `/v1/users/:` (param names, case and trailing slashes do not matter to Express). */
export function pathShape(path: string): string {
  const segs = path.split('?')[0]?.split('/').filter((s) => s !== '') ?? [];
  return `/${segs.map((s) => (isParamSegment(s) ? ':' : s.toLowerCase())).join('/')}`;
}

function joinBase(base: string, plural: string): string {
  return `${base === '/' ? '' : base.replace(/\/+$/, '')}/${plural}`;
}

/** `Endpoint: GET /api/users/{id} - …` lines the task front end recorded in behaviours. */
function declaredEndpoints(behaviours: string[]): Array<{ method: Method; path: string }> {
  const out: Array<{ method: Method; path: string }> = [];
  for (const b of behaviours) {
    const m = /^Endpoint:\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/i.exec(b.trim());
    if (m === null) continue;
    const method = (m[1] ?? '').toUpperCase();
    if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') out.push({ method, path: m[2] ?? '/' });
  }
  return out;
}

/** The CRUD operation and resource segment of a declared path, or undefined for nested/custom routes. */
function declaredOp(method: Method, path: string): { op: Operation; segment: string } | undefined {
  const segs = path.split('?')[0]?.split('/').filter((s) => s !== '') ?? [];
  const last = segs[segs.length - 1];
  if (last === undefined) return undefined;
  if (isParamSegment(last)) {
    const before = segs[segs.length - 2];
    if (before === undefined || isParamSegment(before) || segs.slice(0, -2).some(isParamSegment)) return undefined;
    const op: Operation | undefined = method === 'GET' ? 'get' : method === 'DELETE' ? 'delete' : method === 'PATCH' || method === 'PUT' ? 'update' : undefined;
    return op === undefined ? undefined : { op, segment: before };
  }
  if (segs.slice(0, -1).some(isParamSegment)) return undefined;
  const op: Operation | undefined = method === 'GET' ? 'list' : method === 'POST' ? 'create' : undefined;
  return op === undefined ? undefined : { op, segment: last };
}

/** resources × operations → the endpoints the API must expose (only the operations each resource asks for). */
export function expectedEndpoints(task: Pick<GreenfieldTask, 'basePath' | 'resources' | 'behaviours'>): ExpectedEndpoint[] {
  const declared = declaredEndpoints(task.behaviours);
  const out: ExpectedEndpoint[] = [];
  for (const r of task.resources) {
    const collection = joinBase(task.basePath, r.plural);
    for (const op of r.operations) {
      const fallback = ITEM_OPS.has(op) ? `${collection}/:id` : collection;
      const own = declared
        .map((d) => ({ d, o: declaredOp(d.method, d.path) }))
        .filter(({ d, o }) => o !== undefined && o.op === op && OP_METHODS[op].includes(d.method) && [r.plural, r.name].includes(o.segment.toLowerCase()))
        .map(({ d }) => d.path);
      const paths = [...new Set([...own, fallback].map((p) => p.split('?')[0] ?? p))];
      out.push({ resource: r.name, op, methods: OP_METHODS[op], paths });
    }
  }
  return out;
}

export function endpointLabel(e: ExpectedEndpoint): string {
  return `${e.methods.join('|')} ${e.paths[0] ?? ''}`;
}

/** A route of the static table, reduced to what coverage needs. */
export interface StaticRoute {
  method: string;
  path: string;
  /** "src/routes/users.ts:12" */
  at: string;
}

/** Static routes that satisfy `e` (method and path shape), best (declared path order) first. */
export function staticMatches(e: ExpectedEndpoint, routes: StaticRoute[]): Array<StaticRoute & { path: string }> {
  const out: StaticRoute[] = [];
  for (const p of e.paths) {
    const shape = pathShape(p);
    for (const r of routes) if (e.methods.includes(r.method.toUpperCase() as Method) && pathShape(r.path) === shape) out.push(r);
  }
  return out;
}

/** Statuses the harness received on an endpoint while it addressed an existing route/resource. */
export type Evidence = Map<string, number[]>;

export function evidenceKey(resource: string, op: Operation): string {
  return `${resource}|${op}`;
}

/**
 * One route unit per expected endpoint: registered in the source (static table), else proven or
 * disproven by what the running app answered on it (statuses the harness received), else fail when
 * the static table is complete and UNPROVEN when some route paths could not be resolved statically.
 */
export function coverRoutes(
  expected: ExpectedEndpoint[],
  table: { routes: StaticRoute[]; unresolved: number } | { error: string },
  evidence: Evidence,
  runtime: string | undefined,
): SpecUnit[] {
  return expected.map((e): SpecUnit => {
    const label = endpointLabel(e);
    const name = `route ${label}`;
    const base = { resource: e.resource, name };
    const hit = 'routes' in table ? staticMatches(e, table.routes)[0] : undefined;
    if (hit !== undefined) return { ...base, status: 'pass', detail: `registered: ${hit.method.toUpperCase()} ${hit.path} (${hit.at})` };
    const seen = evidence.get(evidenceKey(e.resource, e.op)) ?? [];
    const answered = seen.filter((s) => ![404, 405, 401, 403, 501].includes(s));
    if (answered.length > 0) return { ...base, status: 'pass', detail: `not in the static route table, but the running app answers it (status ${answered[0] ?? ''})` };
    if (seen.some((s) => s === 404 || s === 405 || s === 501)) {
      return { ...base, status: 'fail', detail: `missing endpoint ${label} (${e.op} ${e.resource}): not registered in the source and the running app answers ${seen.find((s) => s === 404 || s === 405 || s === 501) ?? ''}` };
    }
    const why = runtime ?? (seen.length > 0 ? `the running app answered ${seen.join(', ')} (credentials required)` : 'no request reached it');
    if ('error' in table) return { ...base, status: 'unproven', detail: `${table.error}; runtime: ${why}` };
    if (table.unresolved > 0) {
      return { ...base, status: 'unproven', detail: `not among the resolved routes (${table.unresolved} route(s) have paths that cannot be resolved statically); runtime: ${why}` };
    }
    return { ...base, status: 'fail', detail: `missing endpoint ${label} (${e.op} ${e.resource}): not registered in the source (runtime: ${why})` };
  });
}

// ───────────────────────────── values from field specs ─────────────────────────────

const SIMPLE_ITEM = /^(string|text|email|uuid|integer|int|number|boolean|bool)$/i;
const URLISH = /^(url|uri|link|href|website)$/i;
const PHONEISH = /^(phone|tel|telephone|phonenumber)$/i;
/** Write-only by convention: a correct API need not echo these back. */
const SECRETISH = /(password|passcode|secret|token|hash|salt)/i;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Fit `s` into [min, max] characters: keep its distinctive tail, pad with 'x'. */
function fit(s: string, min: number | undefined, max: number | undefined): string {
  let t = s;
  if (max !== undefined && t.length > max) t = t.slice(t.length - Math.max(0, Math.floor(max)));
  if (min !== undefined && t.length < min) t += 'x'.repeat(Math.ceil(min) - t.length);
  return t;
}

/** Element type of an array field's declared type (`string[]`, `array<int>`), when simple. */
function itemType(f: FieldSpec): string | undefined {
  const raw = f.rawType ?? '';
  const m = /^(\w+)\[\]$/.exec(raw) ?? /^(?:array|list|set)\s*[<(]\s*(\w+)\s*[>)]$/i.exec(raw) ?? /^(?:array|list|set)\s+of\s+(\w+)$/i.exec(raw);
  const t = m?.[1];
  return t !== undefined && SIMPLE_ITEM.test(t) ? t.toLowerCase() : undefined;
}

/** Numeric range a value must fall in: [lo, hi]. */
function range(f: FieldSpec): { lo: number; hi: number } {
  const lo = f.min ?? (f.max !== undefined ? Math.min(1, f.max) : 1);
  const hi = f.max ?? lo + 1_000_000;
  return { lo, hi };
}

/**
 * A valid value for `f`, distinct per `n` wherever the type allows (so unique fields never collide):
 * string within min/max, email, enum default (else first value), integer/number within bounds, ISO
 * dates, boolean, uuid, url/phone for those declared types. undefined: the spec gives no way to build one.
 */
export function valueFor(f: FieldSpec, n: number, nonce: string): unknown {
  const tag = `p${nonce}${n}`;
  switch (f.type) {
    case 'string':
      return fit(tag, f.min, f.max);
    case 'email': {
      const domain = '@example.com';
      const local = fit(tag, f.min !== undefined ? f.min - domain.length : undefined, f.max !== undefined ? Math.max(1, f.max - domain.length) : undefined);
      return `${local}${domain}`;
    }
    case 'uuid':
      return randomUUID();
    case 'enum': {
      const values = f.values ?? [];
      if (f.unique) return values[n % Math.max(1, values.length)];
      return typeof f.default === 'string' && values.includes(f.default) ? f.default : values[0];
    }
    case 'integer': {
      const { lo, hi } = range(f);
      const a = Math.ceil(lo);
      const b = Math.floor(hi);
      if (b < a) return undefined;
      return a + (n % (b - a + 1));
    }
    case 'number':
    case 'decimal': {
      const { lo, hi } = range(f);
      if (hi < lo) return undefined;
      const v = Math.round((lo + ((hi - lo) * ((n % 89) + 1)) / 91) * 100) / 100;
      return Math.min(hi, Math.max(lo, v));
    }
    case 'boolean':
      return n % 2 === 1;
    case 'datetime':
      return new Date(Date.UTC(2030, 0, 1) + n * 60_000).toISOString();
    case 'date':
      return new Date(Date.UTC(2030, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
    case 'time':
      return `${pad2(n % 24)}:${pad2(n % 60)}:00`;
    case 'array': {
      const t = itemType(f);
      const count = Math.max(0, Math.ceil(f.min ?? 0));
      if (count === 0) return [];
      if (t === undefined || count > 1000) return undefined;
      const item: FieldSpec = { name: f.name, type: t === 'int' ? 'integer' : t === 'bool' ? 'boolean' : t === 'text' ? 'string' : (t as FieldSpec['type']), required: true, unique: false, readOnly: false };
      return Array.from({ length: count }, (_, i) => valueFor(item, n * 1000 + i, nonce));
    }
    case 'object':
      return {};
    case 'unknown': {
      const raw = f.rawType ?? '';
      if (URLISH.test(raw)) return `https://example.com/${tag}`;
      if (PHONEISH.test(raw)) return `+1555${String(1_000_000 + (n % 8_999_999)).slice(-7)}`;
      return undefined;
    }
  }
}

/** A valid value for `f` different from `current` (an update), or undefined when the spec allows only one. */
export function otherValue(f: FieldSpec, current: unknown, n: number, nonce: string): unknown {
  if (f.type === 'enum') return (f.values ?? []).find((v) => v !== current);
  if (f.type === 'boolean') return typeof current === 'boolean' ? !current : true;
  for (let k = 0; k < 4; k++) {
    const v = valueFor(f, n + k * 7919, nonce);
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(current)) return v;
  }
  return undefined;
}

/** Values that break exactly one constraint of `f`: outside the enum, above max, below min. */
export function invalidValues(f: FieldSpec): Array<{ rule: 'enum' | 'max' | 'min'; value: unknown; what: string }> {
  const out: Array<{ rule: 'enum' | 'max' | 'min'; value: unknown; what: string }> = [];
  if (f.type === 'enum' && f.values !== undefined) {
    let bad = 'harness-not-allowed';
    while (f.values.includes(bad)) bad += '-x';
    out.push({ rule: 'enum', value: bad, what: `"${bad}" (not one of ${f.values.join('|')})` });
  }
  if (f.type === 'string') {
    if (f.max !== undefined && f.max >= 0 && f.max < 100_000) out.push({ rule: 'max', value: 'x'.repeat(Math.floor(f.max) + 1), what: `${Math.floor(f.max) + 1} characters (max ${f.max})` });
    if (f.min !== undefined && f.min >= 1) out.push({ rule: 'min', value: 'x'.repeat(Math.ceil(f.min) - 1), what: `${Math.ceil(f.min) - 1} characters (min ${f.min})` });
  }
  if (f.type === 'email' && f.max !== undefined && f.max >= 0 && f.max < 100_000) {
    const domain = '@example.com';
    const local = 'x'.repeat(Math.max(1, Math.floor(f.max) + 1 - domain.length));
    out.push({ rule: 'max', value: `${local}${domain}`, what: `an email of ${local.length + domain.length} characters (max ${f.max})` });
  }
  if (f.type === 'integer') {
    if (f.max !== undefined) out.push({ rule: 'max', value: Math.floor(f.max) + 1, what: `${Math.floor(f.max) + 1} (max ${f.max})` });
    if (f.min !== undefined) out.push({ rule: 'min', value: Math.ceil(f.min) - 1, what: `${Math.ceil(f.min) - 1} (min ${f.min})` });
  }
  if (f.type === 'number' || f.type === 'decimal') {
    if (f.max !== undefined) out.push({ rule: 'max', value: f.max + 1, what: `${f.max + 1} (max ${f.max})` });
    if (f.min !== undefined) out.push({ rule: 'min', value: f.min - 1, what: `${f.min - 1} (min ${f.min})` });
  }
  return out;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The task resource a uuid field refers to by name (`<resource>Id`, `<resource>_id`), if any. */
export function referenceOf(f: FieldSpec, resources: ResourceSpec[]): ResourceSpec | undefined {
  if (f.type !== 'uuid') return undefined;
  const m = /^(.+?)[_-]?id$/i.exec(f.name);
  if (m === null) return undefined;
  const stem = squash(m[1] ?? '');
  return resources.find((r) => squash(r.name) === stem || squash(r.plural) === stem);
}

/** Whether a sent value and a returned one are the same value of the field's type. */
export function sameValue(f: FieldSpec, sent: unknown, got: unknown): boolean {
  if (got === undefined) return false;
  switch (f.type) {
    case 'email':
      return typeof got === 'string' && typeof sent === 'string' && got.toLowerCase() === sent.toLowerCase();
    case 'integer':
    case 'number':
    case 'decimal':
      return (typeof got === 'number' || typeof got === 'string') && Number(got) === Number(sent);
    case 'datetime':
      return typeof got === 'string' && typeof sent === 'string' && Date.parse(got) === Date.parse(sent);
    case 'date':
      return typeof got === 'string' && typeof sent === 'string' && (got === sent || got.startsWith(`${sent}T`));
    default:
      return JSON.stringify(got) === JSON.stringify(sent);
  }
}

/** Structural equality of two parsed JSON values (object key order ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `obj[name]`, else the key equal to it ignoring case, `_` and `-` (camelCase vs snake_case). */
function prop(obj: Record<string, unknown>, name: string): unknown {
  if (name in obj) return obj[name];
  const k = Object.keys(obj).find((x) => squash(x) === squash(name));
  return k === undefined ? undefined : obj[k];
}

// ───────────────────────────── the scenario ─────────────────────────────

export interface SpecRequest {
  method: Method;
  path: string;
  body?: unknown;
  /** Idempotency-Key to send; a fresh uuid on POST/PUT/PATCH/DELETE when absent. */
  idempotencyKey?: string;
}

export interface SpecResponse {
  status: number;
  contentType: string;
  text: string;
  /** Parsed body; undefined when it is not JSON. */
  json: unknown;
  location?: string;
}

export type Client = (req: SpecRequest) => Promise<SpecResponse | { error: string }>;

/** Bytes of a response body kept (list pages must stay parseable). */
const MAX_SPEC_BODY = 1_000_000;

/** A Client that sends from this (the harness) process to `base`, appending one line per exchange to `log`. */
export function httpClient(base: string, log: string[]): Client {
  return async (req) => {
    const res = await request(base, {
      method: req.method,
      path: req.path,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      headers: req.idempotencyKey !== undefined ? { 'idempotency-key': req.idempotencyKey } : {},
    }, MAX_SPEC_BODY);
    const sent = `${req.method} ${req.path}${req.body !== undefined ? ` ${JSON.stringify(req.body).slice(0, 300)}` : ''}${req.idempotencyKey !== undefined ? ` [key ${req.idempotencyKey}]` : ''}`;
    if ('error' in res) {
      log.push(`${sent} -> ERROR ${res.error}`);
      return res;
    }
    log.push(`${sent} -> ${res.status} ${res.contentType} ${res.body.slice(0, 300)}`);
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      json = undefined;
    }
    return { status: res.status, contentType: res.contentType, text: res.body, json, ...(res.location !== undefined ? { location: res.location } : {}) };
  };
}

export interface ScenarioOptions {
  /** Epoch ms after which no request is sent (the remaining units are UNPROVEN). */
  deadline?: number;
  /** Per resource: the collection path to use (a matched static route or the task's), and the update methods registered. */
  paths?: Map<string, { collection: string; updateMethods: Method[] }>;
  nonce?: string;
}

export interface ScenarioResult {
  units: SpecUnit[];
  evidence: Evidence;
}

class Verdict extends Error {
  constructor(readonly status: 'fail' | 'unproven', message: string) {
    super(message);
  }
}
const fail = (m: string): Verdict => new Verdict('fail', m);
const unproven = (m: string): Verdict => new Verdict('unproven', m);

const PROBLEM_CT = /^application\/problem\+json\b/i;
const JSON_CT = /^application\/(?:[\w.+-]+\+)?json\b/i;

function excerpt(res: SpecResponse): string {
  const t = res.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t === '' ? '' : `: ${t.length > 160 ? `${t.slice(0, 160)}…` : t}`;
}

interface Instance {
  id: string;
  /** Field values this instance was created with (or read with). */
  sent: Record<string, unknown>;
}

/** The resource object of a response body: itself, or the object it wraps (`{ data: {...} }`). */
function resourceOf(json: unknown): Record<string, unknown> | undefined {
  if (!isRecord(json)) return undefined;
  if ('id' in json) return json;
  const inner = json['data'] ?? json['item'] ?? json['result'];
  if (isRecord(inner)) return inner;
  const objects = Object.values(json).filter(isRecord);
  return objects.length === 1 && Object.keys(json).length === 1 ? objects[0] : json;
}

function idOf(r: ResourceSpec, obj: Record<string, unknown> | undefined, location: string | undefined): string | undefined {
  const keys = ['id', `${r.name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}Id`, `${r.name.replace(/-/g, '_')}_id`, '_id', 'uuid'];
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  const last = location?.split('?')[0]?.split('/').filter((s) => s !== '').pop();
  return last === undefined ? undefined : decodeURIComponent(last);
}

/** The items of a list page and the next page's request path, if it has one. */
function pageOf(json: unknown, collection: string): { items: unknown[]; next?: string } | undefined {
  if (Array.isArray(json)) return { items: json };
  if (!isRecord(json)) return undefined;
  const arrays = Object.entries(json).filter(([, v]) => Array.isArray(v));
  const preferred = arrays.find(([k]) => ['data', 'items', 'results', 'records'].includes(k.toLowerCase())) ?? arrays[0];
  if (preferred === undefined) return undefined;
  const items = preferred[1];
  if (!Array.isArray(items)) return undefined;
  const holders = [json, ...Object.values(json).filter(isRecord)];
  for (const h of holders) {
    for (const [k, v] of Object.entries(h)) {
      if (typeof v !== 'string' || v === '' || !/cursor|^next/i.test(k)) continue;
      if (v.startsWith('/') || /^https?:\/\//i.test(v)) {
        try {
          const u = new URL(v, 'http://harness.invalid');
          return { items, next: `${u.pathname}${u.search}` };
        } catch {
          continue;
        }
      }
      const stripped = k.replace(/^next[_-]?/i, '');
      const param = stripped === '' ? 'cursor' : stripped.charAt(0).toLowerCase() + stripped.slice(1);
      return { items, next: `${collection}?${encodeURIComponent(param.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()))}=${encodeURIComponent(v)}` };
    }
  }
  return { items };
}

const MAX_PAGES = 50;

/**
 * Run every behavioural unit of every resource, in task order, through `client`. Requests on an
 * existing endpoint record the status the harness received as route evidence (coverRoutes).
 */
export async function runScenario(client: Client, task: Pick<GreenfieldTask, 'basePath' | 'resources'>, opts: ScenarioOptions = {}): Promise<ScenarioResult> {
  const nonce = opts.nonce ?? randomBytes(3).toString('hex');
  const evidence: Evidence = new Map();
  const units: SpecUnit[] = [];
  let seq = 0;
  const instances = new Map<string, Promise<Instance>>();

  const collectionOf = (r: ResourceSpec): string => opts.paths?.get(r.name)?.collection ?? joinBase(task.basePath, r.plural);
  const itemOf = (r: ResourceSpec, id: string): string => `${collectionOf(r)}/${encodeURIComponent(id)}`;

  const call = async (req: SpecRequest, endpoint?: { resource: string; op: Operation }): Promise<SpecResponse> => {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) throw unproven('the probe time budget ran out before this request');
    const keyed = req.method !== 'GET';
    const res = await client(keyed && req.idempotencyKey === undefined ? { ...req, idempotencyKey: randomUUID() } : req);
    if ('error' in res) throw unproven(`${req.method} ${req.path}: request failed (${res.error})`);
    if (endpoint !== undefined) {
      const key = evidenceKey(endpoint.resource, endpoint.op);
      evidence.set(key, [...(evidence.get(key) ?? []), res.status]);
    }
    return res;
  };

  /** The status must be one of `want`; 401/403 instead is UNPROVEN (the probes carry no credentials). */
  const expectStatus = (res: SpecResponse, want: number[], what: string): void => {
    if (want.includes(res.status)) return;
    if (res.status === 401 || res.status === 403) throw unproven(`${what} answered ${res.status}: the API requires credentials the probes do not send`);
    throw fail(`${what}: expected ${want.join(' or ')}, got ${res.status}${excerpt(res)}`);
  };
  const expectProblem = (res: SpecResponse, status: number, what: string): void => {
    expectStatus(res, [status], what);
    if (!PROBLEM_CT.test(res.contentType)) throw fail(`${what}: ${status} sent as "${res.contentType || '(no Content-Type)'}", expected application/problem+json`);
  };
  const expectResource = (res: SpecResponse, what: string): Record<string, unknown> => {
    if (PROBLEM_CT.test(res.contentType) || !JSON_CT.test(res.contentType)) throw fail(`${what}: Content-Type is "${res.contentType || '(none)'}", expected application/json`);
    const obj = resourceOf(res.json);
    if (obj === undefined) throw fail(`${what}: the body is not a JSON object${excerpt(res)}`);
    return obj;
  };
  /** Every sent field the response carries has the sent value; a missing one fails unless write-only by convention. */
  const expectFields = (r: ResourceSpec, obj: Record<string, unknown>, sent: Record<string, unknown>, what: string): void => {
    const wrong: string[] = [];
    for (const f of r.fields) {
      if (!(f.name in sent)) continue;
      const got = prop(obj, f.name);
      if (got === undefined && SECRETISH.test(f.name)) continue;
      if (!sameValue(f, sent[f.name], got)) wrong.push(`${f.name} ${got === undefined ? 'missing' : `is ${JSON.stringify(got)}`}, expected ${JSON.stringify(sent[f.name])}`);
    }
    if (wrong.length > 0) throw fail(`${what}: ${wrong.join('; ')}`);
  };

  const unit = async (r: ResourceSpec, name: string, body: () => Promise<string>): Promise<void> => {
    try {
      units.push({ resource: r.name, name, status: 'pass', detail: await body() });
    } catch (e) {
      if (e instanceof Verdict) units.push({ resource: r.name, name, status: e.status, detail: e.message });
      else units.push({ resource: r.name, name, status: 'unproven', detail: `probe error: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  /** A valid create body: every writable required field, and the optional ones the spec lets us build. */
  const validBody = async (r: ResourceSpec, depth: number): Promise<Record<string, unknown>> => {
    const n = ++seq;
    const body: Record<string, unknown> = {};
    for (const f of r.fields) {
      if (f.readOnly) continue;
      const target = referenceOf(f, task.resources);
      if (target !== undefined && target !== r) {
        if (!target.operations.includes('create') || depth > 3) {
          if (f.required) throw unproven(`no valid ${r.name} can be built: ${f.name} refers to ${target.name}, which the probes cannot create`);
          continue;
        }
        try {
          body[f.name] = (await shared(target, depth + 1)).id;
        } catch (e) {
          if (f.required) throw unproven(`no valid ${r.name} can be built: ${f.name} refers to ${target.name}, which could not be created (${e instanceof Error ? e.message : String(e)})`);
        }
        continue;
      }
      if (target === r && !f.required) continue; // a self-reference needs an existing instance: leave it out
      if (!f.required && (f.type === 'uuid' || f.type === 'array' || f.type === 'object')) continue; // a value the API may reject for reasons the spec does not state
      const v = valueFor(f, n, nonce);
      if (v === undefined) {
        if (f.required) throw unproven(`no valid ${r.name} can be built: required field ${f.name} has type ${f.rawType ?? f.type}, for which the spec gives no valid value`);
        continue;
      }
      body[f.name] = v;
    }
    return body;
  };

  /** POST a fresh valid instance; fails (Verdict) unless 201 with an id. */
  const create = async (r: ResourceSpec, depth = 0, key?: string): Promise<Instance & { res: SpecResponse; obj: Record<string, unknown> }> => {
    const sent = await validBody(r, depth);
    const what = `POST ${collectionOf(r)}`;
    const res = await call({ method: 'POST', path: collectionOf(r), body: sent, ...(key !== undefined ? { idempotencyKey: key } : {}) }, { resource: r.name, op: 'create' });
    expectStatus(res, [201], what);
    const obj = expectResource(res, what);
    const id = idOf(r, obj, res.location);
    if (id === undefined) throw fail(`${what}: the 201 response has no id and no Location header`);
    return { id, sent, res, obj };
  };

  /** An instance created once per resource (references and read-only units share it). */
  const shared = (r: ResourceSpec, depth = 0): Promise<Instance> => {
    let p = instances.get(r.name);
    if (p === undefined) {
      p = r.operations.includes('create') ? create(r, depth) : fromList(r);
      instances.set(r.name, p);
    }
    return p;
  };

  /** Without a create operation: the first item the list returns. */
  const fromList = async (r: ResourceSpec): Promise<Instance> => {
    if (!r.operations.includes('list')) throw unproven(`no ${r.name} to work on: the task has no create or list operation for it`);
    const res = await call({ method: 'GET', path: collectionOf(r) }, { resource: r.name, op: 'list' });
    expectStatus(res, [200], `GET ${collectionOf(r)}`);
    const first = pageOf(res.json, collectionOf(r))?.items.find(isRecord);
    const id = first === undefined ? undefined : idOf(r, first, undefined);
    if (first === undefined || id === undefined) throw unproven(`no ${r.name} to work on: the task has no create operation and the list is empty`);
    const sent: Record<string, unknown> = {};
    for (const f of r.fields) {
      const v = prop(first, f.name);
      if (v !== undefined) sent[f.name] = v;
    }
    return { id, sent };
  };

  /** A fresh instance when the resource can be created (units that change or delete it), else the shared one. */
  const fresh = async (r: ResourceSpec): Promise<Instance> => {
    if (!r.operations.includes('create')) return shared(r);
    try {
      return await create(r);
    } catch (e) {
      throw unproven(`could not create a ${r.name} to work on (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  const depends = async (r: ResourceSpec): Promise<Instance> => {
    try {
      return await shared(r);
    } catch (e) {
      throw unproven(`depends on a created ${r.name}, which failed (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  /** Change one field of `inst` to another valid value: PATCH with that field only, or PUT with the whole body (the registered method first). */
  const update = async (r: ResourceSpec, inst: Instance): Promise<{ res: SpecResponse; what: string; used: Method; after: Record<string, unknown>; path: string }> => {
    const candidates = r.fields.filter((f) => !f.readOnly && f.name in inst.sent && referenceOf(f, task.resources) === undefined);
    const pick = [...candidates.filter((f) => !f.unique && !SECRETISH.test(f.name)), ...candidates.filter((f) => f.unique && !SECRETISH.test(f.name))]
      .map((f) => ({ f, v: otherValue(f, inst.sent[f.name], ++seq, nonce) }))
      .find((c) => c.v !== undefined);
    if (pick === undefined) throw unproven(`no field of ${r.name} can be changed to another valid value`);
    const path = itemOf(r, inst.id);
    const registered = opts.paths?.get(r.name)?.updateMethods ?? [];
    const methods: Method[] = registered.length > 0 ? registered : ['PATCH', 'PUT'];
    const after = { ...inst.sent, [pick.f.name]: pick.v };
    let res: SpecResponse | undefined;
    let used: Method = 'PATCH';
    for (const m of methods) {
      used = m;
      res = await call({ method: m, path, body: m === 'PATCH' ? { [pick.f.name]: pick.v } : after }, { resource: r.name, op: 'update' });
      if (res.status !== 404 && res.status !== 405) break;
    }
    if (res === undefined) throw unproven('no update request was sent');
    return { res, what: `${used} ${path} ${used === 'PATCH' ? `{${pick.f.name}} only` : `(${pick.f.name} changed)`}`, used, after, path };
  };

  for (const r of task.resources) {
    const ops = new Set(r.operations);
    const collection = collectionOf(r);

    if (ops.has('create')) {
      await unit(r, 'create', async () => {
        const made = await create(r);
        instances.set(r.name, Promise.resolve({ id: made.id, sent: made.sent }));
        expectFields(r, made.obj, made.sent, `POST ${collection}`);
        return `POST ${collection} -> 201 with id ${made.id} and every sent field`;
      });
    }

    if (ops.has('get')) {
      await unit(r, 'get', async () => {
        const inst = await depends(r);
        const path = itemOf(r, inst.id);
        const res = await call({ method: 'GET', path }, { resource: r.name, op: 'get' });
        expectStatus(res, [200], `GET ${path}`);
        expectFields(r, expectResource(res, `GET ${path}`), inst.sent, `GET ${path}`);
        return `GET ${path} -> 200 with the created fields`;
      });
    }

    if (ops.has('list')) {
      await unit(r, 'list', async () => {
        const inst = ops.has('create') || ops.has('get') ? await depends(r) : undefined;
        let path: string | undefined = collection;
        let pages = 0;
        let count = 0;
        const visited = new Set<string>();
        while (path !== undefined && pages < MAX_PAGES && !visited.has(path)) {
          visited.add(path);
          const res = await call({ method: 'GET', path }, pages === 0 ? { resource: r.name, op: 'list' } : undefined);
          expectStatus(res, [200], `GET ${path}`);
          if (PROBLEM_CT.test(res.contentType) || !JSON_CT.test(res.contentType)) throw fail(`GET ${path}: Content-Type is "${res.contentType || '(none)'}", expected application/json`);
          const page = pageOf(res.json, collection);
          if (page === undefined) throw fail(`GET ${path}: the body has no array of items${excerpt(res)}`);
          pages++;
          count += page.items.length;
          if (inst === undefined) return `GET ${collection} -> 200 with ${page.items.length} item(s)`;
          if (page.items.some((it) => isRecord(it) && idOf(r, it, undefined) === inst.id)) return `GET ${collection} -> 200; the created ${r.name} is listed (page ${pages})`;
          path = page.next;
        }
        throw fail(`GET ${collection}: the created ${r.name} (id ${inst?.id ?? '?'}) is not in the list (${count} item(s) over ${pages} page(s)${pages >= MAX_PAGES ? ', page limit reached' : ''})`);
      });
    }

    if (ops.has('update')) {
      await unit(r, 'update', async () => {
        const inst = await fresh(r);
        const { res, what, used, after, path } = await update(r, inst);
        expectStatus(res, [200], what);
        expectFields(r, expectResource(res, what), after, `${what}${used === 'PATCH' ? ' (a partial update keeps the other fields)' : ''}`);
        if (ops.has('get')) {
          const again = await call({ method: 'GET', path });
          expectStatus(again, [200], `GET ${path} after the update`);
          expectFields(r, expectResource(again, `GET ${path} after the update`), after, `GET ${path} after the update`);
        }
        return `${what} -> 200 with the change${used === 'PATCH' ? ', other fields kept' : ''}`;
      });
    }

    if (ops.has('create')) {
      for (const f of r.fields.filter((x) => x.required && !x.readOnly && x.default === undefined)) {
        await unit(r, `required ${f.name}`, async () => {
          const body = await validBody(r, 0);
          delete body[f.name];
          const res = await call({ method: 'POST', path: collection, body }, { resource: r.name, op: 'create' });
          expectProblem(res, 422, `POST ${collection} without required ${f.name}`);
          return `POST ${collection} without ${f.name} -> 422 problem`;
        });
      }
      for (const f of r.fields.filter((x) => !x.readOnly)) {
        for (const bad of invalidValues(f)) {
          await unit(r, `${bad.rule} ${f.name}`, async () => {
            const body = { ...(await validBody(r, 0)), [f.name]: bad.value };
            const res = await call({ method: 'POST', path: collection, body }, { resource: r.name, op: 'create' });
            expectProblem(res, 422, `POST ${collection} with ${f.name} = ${bad.what}`);
            return `POST ${collection} with ${f.name} = ${bad.what} -> 422 problem`;
          });
        }
      }
      for (const f of r.fields.filter((x) => x.unique && !x.readOnly)) {
        await unit(r, `unique ${f.name}`, async () => {
          const first = await fresh(r);
          if (!(f.name in first.sent)) throw unproven(`the probes sent no ${f.name} (no valid value can be built)`);
          const body = { ...(await validBody(r, 0)), [f.name]: first.sent[f.name] };
          const res = await call({ method: 'POST', path: collection, body }, { resource: r.name, op: 'create' });
          expectProblem(res, 409, `POST ${collection} with a duplicate ${f.name}`);
          return `POST ${collection} with a duplicate ${f.name} -> 409 problem`;
        });
      }
      await unit(r, 'idempotency', async () => {
        const key = randomUUID();
        const body = await validBody(r, 0);
        const send = (): Promise<SpecResponse> => call({ method: 'POST', path: collection, body, idempotencyKey: key }, { resource: r.name, op: 'create' });
        const one = await send();
        if (one.status !== 201) {
          if (one.status === 401 || one.status === 403) throw unproven(`the first POST answered ${one.status}: the API requires credentials the probes do not send`);
          throw unproven(`the first POST ${collection} answered ${one.status}, not 201 (see the create unit)`);
        }
        const two = await send();
        const id1 = idOf(r, resourceOf(one.json), one.location);
        const id2 = idOf(r, resourceOf(two.json), two.location);
        if (two.status !== one.status) throw fail(`POST ${collection} repeated with the same Idempotency-Key and body: expected ${one.status} again, got ${two.status}${excerpt(two)}`);
        if (id1 === undefined || id1 !== id2) throw fail(`POST ${collection} repeated with the same Idempotency-Key and body created another ${r.name} (id ${id1 ?? '?'} then ${id2 ?? '?'})`);
        return `the same Idempotency-Key and body twice -> ${two.status} with the same id (no duplicate)`;
      });
      if (ops.has('update')) {
        // A replay returns the response first sent, not the resource's current state: a cache that holds the
        // sent object by reference (and an update that mutates it in place) replays the updated resource.
        await unit(r, 'idempotency after update', async () => {
          const plain = units.find((u) => u.resource === r.name && u.name === 'idempotency');
          if (plain?.status !== 'pass') throw unproven('depends on a plain replay, which did not pass (see the idempotency unit)');
          const key = randomUUID();
          const body = await validBody(r, 0);
          const send = (): Promise<SpecResponse> => call({ method: 'POST', path: collection, body, idempotencyKey: key }, { resource: r.name, op: 'create' });
          const one = await send();
          if (one.status !== 201) {
            if (one.status === 401 || one.status === 403) throw unproven(`the first POST answered ${one.status}: the API requires credentials the probes do not send`);
            throw unproven(`the first POST ${collection} answered ${one.status}, not 201 (see the create unit)`);
          }
          const id = idOf(r, resourceOf(one.json), one.location);
          if (id === undefined) throw unproven(`the first POST ${collection} returned no id (see the create unit)`);
          const changed = await update(r, { id, sent: body });
          if (changed.res.status !== 200) throw unproven(`${changed.what} answered ${changed.res.status}, not 200 (see the update unit)`);
          const two = await send();
          if (two.status !== one.status) throw fail(`POST ${collection} replayed after ${changed.what}: expected the original ${one.status}, got ${two.status}${excerpt(two)}`);
          if (!deepEqual(one.json, two.json)) {
            throw fail(`POST ${collection} replayed after ${changed.what} returned a different body than the original response (expected the response first sent, not the updated ${r.name})${excerpt(two)}`);
          }
          return `POST, ${changed.what}, then the same Idempotency-Key and body -> the original ${one.status} response, unchanged`;
        });
      }
    }

    if (ops.has('delete')) {
      await unit(r, 'delete', async () => {
        const inst = await fresh(r);
        const path = itemOf(r, inst.id);
        const res = await call({ method: 'DELETE', path }, { resource: r.name, op: 'delete' });
        expectStatus(res, [204], `DELETE ${path}`);
        if (res.text !== '') throw fail(`DELETE ${path}: 204 with a body${excerpt(res)}`);
        if (ops.has('get')) {
          const gone = await call({ method: 'GET', path });
          expectStatus(gone, [404], `GET ${path} after DELETE`);
          return `DELETE ${path} -> 204, then GET -> 404`;
        }
        const again = await call({ method: 'DELETE', path });
        expectStatus(again, [404], `DELETE ${path} again`);
        return `DELETE ${path} -> 204, then DELETE again -> 404`;
      });
    }
  }
  return { units, evidence };
}
