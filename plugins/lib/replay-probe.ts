/**
 * Runtime replay probe for idempotency (rest-conventions): independent evidence for the routes the static
 * analysis accepts as idempotent. For each such POST (and PATCH, when a resource to patch can be created
 * trivially) the harness serves the app (probe.ts serveApp: confined child, the harness sends every request
 * and judges every response itself), sends the same request twice with the same Idempotency-Key and
 * compares the two responses. A second response that differs from the first (status or body) is a definite
 * failure: a keyed retry was not replayed. When no valid body can be generated, the app cannot be served, or
 * the first request is not a 2xx, the probe is inconclusive and the static verdict stands (a note is logged).
 *
 * Request bodies come from the route's body schema: converted to JSON Schema by the contract runtime when the
 * schema is an exported const (converted in a confined child, contract.ts), else translated
 * statically from a supported subset of Zod; then a valid instance is generated (every property, optional
 * ones included, so object-level refinements such as "at least one field" hold).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { constInitializer, resolveSymbol, routeLabel, unwrap } from './api-ast.ts';
import type { RouteInfo, SchemaRef } from './api-ast.ts';
import { convertAtRuntime } from './contract.ts';
import { request, serveApp } from './probe.ts';
import type { HttpResponse, ProbeHost } from './probe.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

export interface ReplayOutcome {
  route: RouteInfo;
  /** replayed: the second response equals the first; not-replayed: it differs (a FAIL); inconclusive: not judged. */
  result: 'replayed' | 'not-replayed' | 'inconclusive';
  detail: string;
}

export interface ReplayRun {
  outcomes: ReplayOutcome[];
  /** Why the app could not be served at all (every outcome is then inconclusive). */
  unserved?: string;
  logPath?: string;
}

/** Budget for serving the app and sending the probes. */
const REPLAY_BUDGET_MS = 45_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ───────────── static Zod → JSON Schema (a supported subset; anything else: undefined) ─────────────

const STRING_FORMATS: Record<string, string> = { email: 'email', uuid: 'uuid', guid: 'uuid', url: 'uri', datetime: 'date-time', date: 'date', time: 'time', cuid: 'cuid', ulid: 'ulid' };

function numberArg(e: ts.Expression | undefined): number | undefined {
  if (e === undefined) return undefined;
  const x = unwrap(e);
  if (ts.isNumericLiteral(x)) return Number(x.text);
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand)) return -Number(x.operand.text);
  return undefined;
}

function literalValue(e: ts.Expression): Json | undefined {
  const x = unwrap(e);
  if (ts.isStringLiteralLike(x)) return x.text;
  if (ts.isNumericLiteral(x)) return Number(x.text);
  if (x.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (x.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (x.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(x)) {
    const out: Json[] = [];
    for (const el of x.elements) {
      const v = literalValue(el);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(x)) {
    const out: { [k: string]: Json } = {};
    for (const p of x.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return undefined;
      const v = literalValue(p.initializer);
      if (v === undefined) return undefined;
      out[p.name.text] = v;
    }
    return out;
  }
  return undefined;
}

/** `z.object({...})`, `S.extend({...})` shapes: property name → member schema expression. */
function shapeOf(checker: ts.TypeChecker, e: ts.Expression | undefined, depth: number): Map<string, ts.Expression> | undefined {
  if (e === undefined || depth > 8) return undefined;
  let x = unwrap(e);
  if (ts.isIdentifier(x)) {
    const init = constInitializer(checker, x);
    if (init === undefined) return undefined;
    x = unwrap(init);
  }
  if (!ts.isObjectLiteralExpression(x)) return undefined;
  const out = new Map<string, ts.Expression>();
  for (const p of x.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.set(p.name.text, p.initializer);
    else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, p.name);
    else return undefined;
  }
  return out;
}

/** `z`, `z.iso`, `z.coerce` (any local name) when it is the zod package's export, by declaration. */
function isZodNamespace(checker: ts.TypeChecker, e: ts.Expression): boolean {
  const head = ts.isPropertyAccessExpression(e) && ['iso', 'coerce'].includes(e.name.text) ? unwrap(e.expression) : e;
  if (!ts.isIdentifier(head)) return false;
  const sym = resolveSymbol(checker, head);
  return (sym?.declarations ?? []).some((d) => /[\\/]node_modules[\\/]zod[\\/]/.test(d.getSourceFile().fileName));
}

/** A JSON Schema for the Zod schema `e` evaluates to, or undefined when it uses anything outside the subset. */
export function zodToSchema(checker: ts.TypeChecker, e0: ts.Expression, depth = 0): Schema | undefined {
  if (depth > 12) return undefined;
  const e = unwrap(e0);
  if (ts.isIdentifier(e)) {
    const init = constInitializer(checker, e);
    return init !== undefined ? zodToSchema(checker, init, depth + 1) : undefined;
  }
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return undefined;
  const method = e.expression.name.text;
  const recv = unwrap(e.expression.expression);
  const args = e.arguments;
  // Constructors: <zod>.<kind>(…), <zod>.iso.<kind>(), <zod>.coerce.<kind>() — the receiver is the zod package itself.
  if (isZodNamespace(checker, recv)) {
    switch (method) {
      case 'string':
        return { type: 'string' };
      case 'number':
        return { type: 'number' };
      case 'int':
        return { type: 'integer' };
      case 'boolean':
        return { type: 'boolean' };
      case 'null':
        return { type: 'null' };
      case 'unknown':
      case 'any':
        return {};
      case 'literal': {
        const v = args[0] !== undefined ? literalValue(args[0]) : undefined;
        return v === undefined ? undefined : { const: v };
      }
      case 'enum': {
        const v = args[0] !== undefined ? literalValue(args[0]) : undefined;
        if (Array.isArray(v)) return { enum: v };
        if (isRecord(v)) return { enum: Object.values(v) };
        return undefined;
      }
      case 'array': {
        const items = args[0] !== undefined ? zodToSchema(checker, args[0], depth + 1) : undefined;
        return items === undefined ? undefined : { type: 'array', items };
      }
      case 'object':
      case 'strictObject':
      case 'looseObject': {
        const shape = shapeOf(checker, args[0], depth);
        if (shape === undefined) return undefined;
        return objectSchema(checker, shape, depth);
      }
      case 'optional':
      case 'nullable': {
        const inner = args[0] !== undefined ? zodToSchema(checker, args[0], depth + 1) : undefined;
        return inner === undefined ? undefined : method === 'optional' ? { ...inner, optional: true } : inner;
      }
      case 'union': {
        const first = args[0] !== undefined ? unwrap(args[0]) : undefined;
        if (first === undefined || !ts.isArrayLiteralExpression(first)) return undefined;
        const options = first.elements.map((el) => zodToSchema(checker, el, depth + 1));
        const ok = options.filter((o): o is Schema => o !== undefined);
        return ok.length > 0 ? { anyOf: ok } : undefined;
      }
      default: {
        const format = STRING_FORMATS[method];
        return format !== undefined ? { type: 'string', format } : undefined;
      }
    }
  }
  // Methods on a schema.
  const base = zodToSchema(checker, recv, depth + 1);
  if (base === undefined) return undefined;
  const n = numberArg(args[0]);
  switch (method) {
    case 'min':
    case 'gte':
      return base['type'] === 'string' ? { ...base, minLength: n } : base['type'] === 'array' ? { ...base, minItems: n } : { ...base, minimum: n };
    case 'max':
    case 'lte':
      return base['type'] === 'string' ? { ...base, maxLength: n } : base['type'] === 'array' ? { ...base, maxItems: n } : { ...base, maximum: n };
    case 'gt':
      return { ...base, exclusiveMinimum: n };
    case 'lt':
      return { ...base, exclusiveMaximum: n };
    case 'length':
      return base['type'] === 'string' ? { ...base, minLength: n, maxLength: n } : { ...base, minItems: n, maxItems: n };
    case 'nonempty':
      return base['type'] === 'string' ? { ...base, minLength: 1 } : { ...base, minItems: 1 };
    case 'positive':
      return { ...base, exclusiveMinimum: 0 };
    case 'nonnegative':
      return { ...base, minimum: 0 };
    case 'int':
      return { ...base, type: 'integer' };
    case 'optional':
      return { ...base, optional: true };
    case 'default':
    case 'catch': {
      const v = args[0] !== undefined ? literalValue(args[0]) : undefined;
      return v === undefined ? { ...base, optional: true } : { ...base, optional: true, default: v };
    }
    case 'nullable':
    case 'nullish':
    case 'trim':
    case 'toLowerCase':
    case 'toUpperCase':
    case 'describe':
    case 'meta':
    case 'brand':
    case 'readonly':
    case 'strict':
    case 'passthrough':
    case 'strip':
    case 'refine':
    case 'superRefine':
    case 'check':
      return method === 'nullish' ? { ...base, optional: true } : base;
    case 'partial':
      return base['type'] === 'object' && isRecord(base['properties']) ? { ...base, required: [] } : undefined;
    case 'extend':
    case 'safeExtend': {
      const shape = shapeOf(checker, args[0], depth);
      const more = shape !== undefined ? objectSchema(checker, shape, depth) : undefined;
      if (more === undefined || base['type'] !== 'object' || !isRecord(base['properties']) || !isRecord(more['properties'])) return undefined;
      const required = [...(Array.isArray(base['required']) ? base['required'] : []), ...(Array.isArray(more['required']) ? more['required'] : [])];
      return { ...base, properties: { ...base['properties'], ...more['properties'] }, required };
    }
    default: {
      const format = STRING_FORMATS[method];
      if (format !== undefined && base['type'] === 'string') return { ...base, format };
      return undefined; // regex, transform, pipe, …: not generatable statically
    }
  }
}

function objectSchema(checker: ts.TypeChecker, shape: Map<string, ts.Expression>, depth: number): Schema | undefined {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const [k, v] of shape) {
    const s = zodToSchema(checker, v, depth + 1);
    if (s === undefined) return undefined;
    const { optional, ...rest } = s;
    properties[k] = rest;
    if (optional !== true) required.push(k);
  }
  return { type: 'object', properties, required };
}

// ───────────── JSON Schema → a valid instance ─────────────

/** A valid instance of `s` (every property, optional ones too), or undefined when `s` is outside what this can satisfy. */
export function instanceOf(s: unknown, root: unknown, nonce: string, depth = 0): Json | undefined {
  if (!isRecord(s) || depth > 12) return undefined;
  const ref = s['$ref'];
  if (typeof ref === 'string') {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    const defs = m !== null && isRecord(root) ? root[m[1] ?? ''] : undefined;
    return m !== null && isRecord(defs) ? instanceOf(defs[m[2] ?? ''], root, nonce, depth + 1) : undefined;
  }
  if ('const' in s) return s['const'] as Json;
  const en = s['enum'];
  if (Array.isArray(en)) return en.length > 0 ? (en[0] as Json) : undefined;
  if ('default' in s && s['default'] !== undefined) return s['default'] as Json;
  for (const k of ['anyOf', 'oneOf']) {
    const opts = s[k];
    if (Array.isArray(opts)) {
      for (const o of opts) {
        const v = instanceOf(o, root, nonce, depth + 1);
        if (v !== undefined) return v;
      }
      return undefined;
    }
  }
  if (Array.isArray(s['allOf'])) return undefined;
  const type = Array.isArray(s['type']) ? s['type'].find((t) => t !== 'null') : s['type'];
  const num = (k: string): number | undefined => (typeof s[k] === 'number' ? s[k] : undefined);
  switch (type) {
    case 'string': {
      if (typeof s['pattern'] === 'string' && s['format'] === undefined) return undefined;
      const fmt = s['format'];
      if (fmt === 'email') return `probe-${nonce}@example.com`;
      if (fmt === 'uuid') return randomUUID();
      if (fmt === 'date-time') return new Date(Date.UTC(2030, 0, 1)).toISOString();
      if (fmt === 'date') return '2030-01-01';
      if (fmt === 'time') return '12:00:00';
      if (fmt === 'uri' || fmt === 'url') return `https://example.com/${nonce}`;
      if (fmt !== undefined) return undefined;
      const min = num('minLength') ?? 1;
      const max = num('maxLength') ?? Math.max(min, 24);
      if (max < min) return undefined;
      const base = `probe${nonce}`;
      const text = base.length >= min ? base : base.padEnd(min, 'x');
      return text.slice(0, max);
    }
    case 'integer':
    case 'number': {
      const lo = num('minimum') ?? (num('exclusiveMinimum') !== undefined ? (num('exclusiveMinimum') ?? 0) + 1 : 1);
      const hi = num('maximum') ?? (num('exclusiveMaximum') !== undefined ? (num('exclusiveMaximum') ?? 0) - 1 : lo + 1000);
      const v = Math.ceil(lo);
      return v <= hi ? v : undefined;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const min = num('minItems') ?? 0;
      if (min === 0) return [];
      const item = instanceOf(s['items'], root, nonce, depth + 1);
      return item === undefined || min > 50 ? undefined : Array.from({ length: min }, () => item);
    }
    case 'object':
    case undefined: {
      const props = s['properties'];
      if (type === undefined && !isRecord(props)) return Object.keys(s).length === 0 ? 'probe' : undefined;
      const out: { [k: string]: Json } = {};
      const required = Array.isArray(s['required']) ? s['required'].filter((r): r is string => typeof r === 'string') : [];
      if (isRecord(props)) {
        for (const [k, v] of Object.entries(props)) {
          const value = instanceOf(v, root, nonce, depth + 1);
          if (value === undefined) {
            if (required.includes(k)) return undefined;
            continue;
          }
          out[k] = value;
        }
      }
      return required.every((k) => k in out) ? out : undefined;
    }
    default:
      return undefined;
  }
}

// ───────────── the probe ─────────────

/** The route's request-body schema, if it parses one (and reads the body no other way). */
function bodySchemaOf(r: RouteInfo): SchemaRef | 'none' | undefined {
  const parse = r.parses.find((p) => p.target === 'body');
  if (parse !== undefined) return parse.schema;
  return r.unparsedReads.some((u) => u.target === 'body' || u.target === 'req' || u.target.startsWith('req[')) ? undefined : 'none';
}

interface Prepared {
  route: RouteInfo;
  body?: string;
  why?: string;
}

/** Bodies for `routes`: JSON Schema from the contract runtime (importable exported schemas) or the static subset. */
async function bodiesFor(ctx: ProbeHost, routes: RouteInfo[]): Promise<Map<RouteInfo, (salt: string) => { body?: string; why?: string }>> {
  const checker = ctx.program().getTypeChecker();
  const wanted = new Map<string, { module: string; exportName: string }>();
  for (const r of routes) {
    const s = bodySchemaOf(r);
    // No purity gate here (unlike Contract Lock): the schema only shapes an INPUT. A module that lied about
    // it would get a body the real app rejects, an inconclusive probe, and UNPROVEN, never a pass; the
    // conversion itself runs confined (no network, writes only to its own temp dir).
    if (s !== undefined && s !== 'none' && s.module !== undefined && s.exportName !== undefined) {
      wanted.set(`${s.module}#${s.exportName}`, { module: s.module, exportName: s.exportName });
    }
  }
  const converted = new Map<string, unknown>();
  if (wanted.size > 0) {
    try {
      for (const c of await convertAtRuntime({ apiRoot: ctx.root, harnessRoot: ctx.harnessRoot, exec: ctx.exec, refs: [...wanted.values()] })) {
        if (c.input !== undefined) converted.set(`${c.module}#${c.exportName}`, c.input);
      }
    } catch {
      // static subset below
    }
  }
  const out = new Map<RouteInfo, (salt: string) => { body?: string; why?: string }>();
  for (const r of routes) {
    const s = bodySchemaOf(r);
    if (s === undefined) {
      out.set(r, () => ({ why: 'the body is read without a schema' }));
      continue;
    }
    if (s === 'none') {
      out.set(r, () => ({ body: '{}' }));
      continue;
    }
    let schema: unknown = s.module !== undefined && s.exportName !== undefined ? converted.get(`${s.module}#${s.exportName}`) : undefined;
    schema ??= zodToSchema(checker, s.expr);
    if (schema !== undefined && s.member !== undefined) schema = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'][s.member] : undefined;
    // Each body gets its own salt, so values a route requires to be unique (an email) never collide.
    out.set(r, (salt) => {
      const value = schema !== undefined ? instanceOf(schema, schema, salt) : undefined;
      return value === undefined ? { why: `no valid body can be generated from ${s.text}` } : { body: JSON.stringify(value) };
    });
  }
  return out;
}

function show(r: HttpResponse | { error: string }): string {
  return 'error' in r ? `error (${r.error})` : String(r.status);
}

/** The path of a Location header (absolute or relative), or undefined. */
function locationPath(loc: string | undefined): string | undefined {
  if (loc === undefined) return undefined;
  try {
    return new URL(loc, 'http://probe.invalid').pathname;
  } catch {
    return undefined;
  }
}

/** The file in the API root where a person can supply valid request bodies for the replay probe. */
export const PROBE_INPUT_FILE = 'harness.probe.json';

/**
 * Request bodies supplied by a person in PROBE_INPUT_FILE, keyed "METHOD /path" exactly as the route is
 * registered (e.g. "POST /v1/items", "PATCH /v1/items/:itemId"): `{ "POST /v1/items": { "body": { … } } }`.
 * Every "{{unique}}" inside a string value is replaced with a fresh value per request, so fields a route
 * requires to be unique never collide. The model cannot write this file (only .ts files are writable during a
 * run), so it is evidence a person supplied, not something the run produced. Absent file: an empty map;
 * a file that is not valid: an error, and every route that would use it is inconclusive.
 */
export function suppliedBodies(root: string): { bodies: Map<string, unknown>; error?: string } {
  const file = join(root, PROBE_INPUT_FILE);
  if (!existsSync(file)) return { bodies: new Map() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { bodies: new Map(), error: `${PROBE_INPUT_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(raw)) return { bodies: new Map(), error: `${PROBE_INPUT_FILE} must be an object keyed "METHOD /path"` };
  const bodies = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) {
    if (!/^(POST|PATCH) \/\S*$/.test(k) || !isRecord(v) || !('body' in v)) {
      return { bodies: new Map(), error: `${PROBE_INPUT_FILE}: entry "${k}" must be keyed "POST /path" or "PATCH /path" and hold { "body": … }` };
    }
    bodies.set(k, v['body']);
  }
  return { bodies };
}

function withUnique(v: unknown, unique: string): unknown {
  if (typeof v === 'string') return v.split('{{unique}}').join(unique);
  if (Array.isArray(v)) return v.map((x) => withUnique(x, unique));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withUnique(x, unique)]));
  return v;
}

/**
 * Probe `routes` (POST/PATCH routes rest-conventions accepts as idempotent). `all` is every route of the API
 * (a PATCH /x/:id needs the POST /x that creates its resource).
 */
export async function runReplayProbe(ctx: ProbeHost, routes: RouteInfo[], all: RouteInfo[]): Promise<ReplayRun> {
  const nonce = randomBytes(3).toString('hex');
  // Every `:param` of a path is filled by creating that resource first, through the POST of its collection
  // (the path up to the parameter), left to right: PATCH /x/:id, POST /x/:id/action, /a/:aId/b/:bId/c alike.
  const creators = new Map<RouteInfo, RouteInfo[]>();
  const prepared: Prepared[] = [];
  const needBodies = new Set<RouteInfo>();
  for (const r of routes) {
    const segs = r.path.split('/');
    const chain: RouteInfo[] = [];
    let missing: string | undefined;
    segs.forEach((seg, i) => {
      if (missing !== undefined || !seg.startsWith(':')) return;
      const collection = segs.slice(0, i).join('/');
      const creator = all.find((x) => x.method === 'post' && x.path === collection);
      if (creator === undefined) missing = `no POST ${collection} to create the resource for ${seg}`;
      else chain.push(creator);
    });
    if (missing !== undefined) {
      prepared.push({ route: r, why: missing });
      continue;
    }
    creators.set(r, chain);
    prepared.push({ route: r });
    needBodies.add(r);
    for (const c of chain) needBodies.add(c);
  }
  const bodies = await bodiesFor(ctx, [...needBodies]);
  let salt = 0;
  const supplied = suppliedBodies(ctx.root);
  const bodyOf = (r: RouteInfo): { body?: string; why?: string } | undefined => {
    const unique = `${nonce}${String(++salt)}`;
    const key = `${r.method.toUpperCase()} ${r.path}`;
    if (supplied.error !== undefined) return { why: supplied.error };
    if (supplied.bodies.has(key)) return { body: JSON.stringify(withUnique(supplied.bodies.get(key), unique)) };
    return bodies.get(r)?.(unique);
  };
  const made = new Map<RouteInfo, string[]>();
  for (const p of prepared) {
    if (p.why !== undefined) continue;
    const own = bodyOf(p.route);
    const chain = creators.get(p.route) ?? [];
    const creates = chain.map((c) => ({ creator: c, made: bodyOf(c) }));
    const failed = creates.find((c) => c.made?.body === undefined);
    if (own?.body === undefined) p.why = own?.why ?? 'no body';
    else if (failed !== undefined) p.why = `the resource for its path cannot be created (POST ${failed.creator.path}): ${failed.made?.why ?? 'no body'}`;
    else {
      p.body = own.body;
      made.set(p.route, creates.map((c) => c.made?.body ?? ''));
    }
  }
  const runnable = prepared.filter((p) => p.body !== undefined);
  const outcomes: ReplayOutcome[] = prepared.filter((p) => p.body === undefined).map((p) => ({ route: p.route, result: 'inconclusive', detail: p.why ?? 'not probed' }));
  if (runnable.length === 0) return { outcomes };
  const served = await serveApp(ctx, { logName: 'rest-conventions-replay-probe.txt', budgetMs: REPLAY_BUDGET_MS }, async (app, log) => {
    const results: ReplayOutcome[] = [];
    for (const p of runnable) {
      const label = routeLabel(p.route);
      if (Date.now() > app.deadline) {
        results.push({ route: p.route, result: 'inconclusive', detail: 'the probe ran out of time' });
        continue;
      }
      // Fill the path: literal segments as they are, each parameter by creating its resource first.
      const segs = p.route.path.split('/');
      const chain = creators.get(p.route) ?? [];
      const bodiesForChain = made.get(p.route) ?? [];
      let path = '';
      let step = 0;
      let unfilled: string | undefined;
      for (const seg of segs) {
        if (seg === '') continue;
        if (!seg.startsWith(':')) {
          path += `/${seg}`;
          continue;
        }
        const creator = chain[step];
        const body = bodiesForChain[step];
        step += 1;
        if (creator === undefined) {
          unfilled = `no resource could be created for ${seg}`;
          break;
        }
        const collection = path;
        const created = await request(app.base, { method: 'POST', path: collection, ...(body !== undefined ? { body } : {}), headers: { 'idempotency-key': randomUUID() } });
        log.push(`${label}: create POST ${collection} ${body ?? ''} -> ${JSON.stringify(created)}`);
        const ok = !('error' in created) && created.status >= 200 && created.status <= 299;
        const at = ok ? locationPath(created.location) : undefined;
        let id: unknown;
        if (ok && at === undefined) {
          try {
            const parsed: unknown = JSON.parse(created.body);
            id = isRecord(parsed) ? parsed['id'] : undefined;
          } catch {
            id = undefined;
          }
        }
        const resolved = at !== undefined && at.startsWith(`${collection}/`) && !at.slice(collection.length + 1).includes('/') ? at
          : typeof id === 'string' || typeof id === 'number' ? `${collection}/${encodeURIComponent(String(id))}` : undefined;
        if (resolved === undefined) {
          unfilled = `creating the resource for ${seg} (POST ${collection}) answered ${show(created)} without a usable Location or id`;
          break;
        }
        path = resolved;
      }
      if (unfilled !== undefined) {
        results.push({ route: p.route, result: 'inconclusive', detail: unfilled });
        continue;
      }
      // A bare UUID: the most widely accepted Idempotency-Key format (APIs often validate it as a uuid).
      const key = randomUUID();
      const method = p.route.method === 'post' ? 'POST' : 'PATCH';
      const send = (): Promise<HttpResponse | { error: string }> => request(app.base, { method, path, ...(p.body !== undefined ? { body: p.body } : {}), headers: { 'idempotency-key': key } });
      const first = await send();
      const second = await send();
      log.push(`${label}: ${method} ${path} ${p.body ?? ''} (Idempotency-Key ${key})`, `  first  -> ${JSON.stringify(first)}`, `  second -> ${JSON.stringify(second)}`);
      if ('error' in first || first.status < 200 || first.status > 299) {
        results.push({ route: p.route, result: 'inconclusive', detail: `the first keyed request answered ${show(first)} (not a 2xx), so the replay could not be judged` });
      } else if ('error' in second) {
        results.push({ route: p.route, result: 'inconclusive', detail: `the retry failed: ${second.error}` });
      } else if (second.status !== first.status || second.body !== first.body) {
        const how = second.status !== first.status ? `${first.status} then ${second.status}` : `${first.status} then ${second.status} with a different body`;
        results.push({ route: p.route, result: 'not-replayed', detail: `keyed retry was not replayed: ${how}` });
      } else results.push({ route: p.route, result: 'replayed', detail: `the retry replayed ${first.status}` });
    }
    return results;
  });
  if (!served.ok) {
    return { outcomes: [...outcomes, ...runnable.map((p): ReplayOutcome => ({ route: p.route, result: 'inconclusive', detail: `the app could not be served: ${served.reason}` }))], unserved: served.reason, ...(served.logPath !== undefined ? { logPath: served.logPath } : {}) };
  }
  return { outcomes: [...outcomes, ...served.value], ...(served.logPath !== undefined ? { logPath: served.logPath } : {}) };
}
