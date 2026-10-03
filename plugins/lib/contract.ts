/**
 * Contract Lock (the harness's own addition): extract an API's public contract
 * and diff two versions of it.
 *
 * Routes and parse/response sites come from the shared route extractor
 * (api-ast.ts). Schemas are converted to JSON Schema at runtime by
 * contract-runtime.ts (spawned with tsx) so the contract is the real Zod shape,
 * not a guess, but only from modules that cannot fake that measurement (unchanged
 * since the base commit, or declarative Zod: schema-purity.ts). When a schema cannot
 * be converted, its source text hash is kept
 * instead (static fallback): an unchanged text is no change, a changed text is
 * an UNPROVEN change, never a silent pass.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { z } from 'zod';
import type { Exec, JsonSchema, RunContext } from '../../src/core/plugin-api.ts';
import { extractRoutes, resolveSymbol } from './api-ast.ts';
import type { RouteInfo, SchemaRef } from './api-ast.ts';
import { notImportable } from './schema-purity.ts';
import type { PurityContext } from './schema-purity.ts';

// ───────────────────────────── types ─────────────────────────────

export type RequestPart = 'params' | 'query' | 'body' | 'headers';
export const REQUEST_PARTS: readonly RequestPart[] = ['params', 'query', 'body', 'headers'];

export interface ContractEndpoint {
  /** Upper-case HTTP method. */
  method: string;
  path: string;
  /**
   * absent = the part is not validated; null = validated but its shape could not be
   * extracted at runtime (see `sources`); object = JSON Schema of what is accepted (io: input).
   */
  request: Partial<Record<RequestPart, JsonSchema | null>>;
  /** 2xx status -> JSON Schema of the body (io: output); null = no body, or a body whose shape is unknown (see `sources`). */
  responses: Record<string, JsonSchema | null>;
  /**
   * sha256 of the schema source tokens per location ("query", "response.200"); whitespace and comments
   * do not count. Used by the static fallback and to see validation JSON Schema cannot show (.refine).
   */
  sources: Record<string, string>;
  /**
   * Every literal status code the handler (or a program function it calls) can produce. Non-2xx codes
   * are diffed as a set: a new 4xx is breaking, anything else is informational.
   */
  statuses: number[];
  /**
   * Request parts the endpoint may consume without a schema the extractor can see: read unparsed in the
   * handler, or (body) possibly read by route-level middleware or by a handler that could not be
   * resolved. Absent = none.
   */
  opaque?: RequestPart[];
}

export interface Contract {
  endpoints: ContractEndpoint[];
  /** 'runtime' iff every schema was converted at runtime. */
  extractedWith: 'runtime' | 'static';
  warnings: string[];
}

export interface Change {
  /** e.g. "GET /v1/projects query.status" */
  location: string;
  message: string;
}

export interface ContractDiff {
  breaking: Change[];
  additive: Change[];
  /**
   * Cannot be proven either way: schema text changed but no runtime shape exists on one side, the source
   * changed in a way JSON Schema cannot show, validation moved out of sight, or a body is not extractable.
   */
  unproven: Change[];
  /** Cannot break a client (a removed error status, a changed response default): reported, never blocking. */
  informational: Change[];
}

// ───────────────────────────── program ─────────────────────────────

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/*.test.ts', '**/*.spec.ts', '**/*.d.ts'];

export async function apiSourceFiles(root: string): Promise<string[]> {
  return (await glob(['src/**/*.ts'], { cwd: root, ignore: IGNORE })).map((f) => f.split('\\').join('/')).sort();
}

/** Same options as the check runner: the API's tsconfig with strict/noUncheckedIndexedAccess/noEmit forced. */
export function apiCompilerOptions(root: string): ts.CompilerOptions {
  const forced: ts.CompilerOptions = { strict: true, noUncheckedIndexedAccess: true, noEmit: true };
  const configPath = join(root, 'tsconfig.json');
  if (existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
    if (read.error === undefined) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
      return { ...parsed.options, ...forced };
    }
  }
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    ...forced,
  };
}

export function createApiProgram(root: string, files: string[]): ts.Program {
  return ts.createProgram({ rootNames: files.map((f) => join(root, f)), options: apiCompilerOptions(root) });
}

// ───────────────────────────── extraction ─────────────────────────────

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Token texts of `node` joined by single spaces: whitespace, comments and line breaks do not change it. */
export function tokenText(node: ts.Node): string {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren();
    if (kids.length === 0) {
      const t = n.getText();
      if (t !== '') out.push(t);
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(node);
  return out.join(' ');
}

/** Source tokens of a schema expression plus the initialisers of the consts it references (transitively). */
export function schemaSourceText(checker: ts.TypeChecker, expr: ts.Expression): string {
  const parts: string[] = [];
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Node, depth: number): void => {
    parts.push(tokenText(node));
    if (depth >= 8) return;
    const scan = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const decl = resolveSymbol(checker, n)?.valueDeclaration;
        if (decl !== undefined && ts.isVariableDeclaration(decl) && decl.initializer !== undefined
          && !decl.getSourceFile().isDeclarationFile && !seen.has(decl)) {
          seen.add(decl);
          visit(decl.initializer, depth + 1);
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
  };
  visit(expr, 0);
  return parts.join('\n');
}

interface Slot {
  endpoint: ContractEndpoint;
  key: string; // 'query' | 'response.200'
  io: 'input' | 'output';
  ref: SchemaRef;
}

const RuntimeOutput = z.object({
  contractRuntime: z.literal(1),
  ok: z.boolean(),
  error: z.string().optional(),
  zod: z.string().optional(),
  schemas: z
    .array(
      z.object({
        module: z.string(),
        exportName: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        error: z.string().optional(),
      }),
    )
    .default([]),
});
type RuntimeSchemas = z.infer<typeof RuntimeOutput>['schemas'];

const RUNTIME_SCRIPT = fileURLToPath(new URL('./contract-runtime.ts', import.meta.url));

function tmpDir(harnessRoot: string, label: string): string {
  const dir = join(harnessRoot, '.harness', 'tmp', `${label}-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Convert exported schemas to JSON Schema in a child process. Throws when the runtime cannot run at all. */
export async function convertAtRuntime(opts: {
  apiRoot: string;
  harnessRoot: string;
  exec: Exec;
  refs: Array<{ module: string; exportName: string }>;
}): Promise<RuntimeSchemas> {
  if (opts.refs.length === 0) return [];
  // Short per-call dir under the OS temp dir: it becomes the confined child's TMPDIR, and tsx puts a
  // unix socket there whose path must stay under the 104-byte limit (a .harness/tmp path can exceed it).
  const dir = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  try {
    const listFile = join(dir, 'refs.json');
    writeFileSync(listFile, JSON.stringify(opts.refs));
    const tsx = join(opts.harnessRoot, 'node_modules', '.bin', 'tsx');
    // Schema modules are agent code: confined, the API read-only, writes only to this per-call dir
    // (the sandbox points TMPDIR, hence tsx's cache, here), no network at all.
    const res = await opts.exec(tsx, [RUNTIME_SCRIPT, opts.apiRoot, listFile], {
      cwd: opts.apiRoot,
      timeoutMs: 60_000,
      sandbox: { writable: [dir], network: 'none' },
    });
    const line = res.stdout.split('\n').reverse().find((l) => l.startsWith('{"contractRuntime"'));
    if (line === undefined) {
      const why = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(0, 3).join(' | ');
      throw new Error(`contract runtime produced no result (exit ${String(res.code)}): ${why.slice(0, 300)}`);
    }
    const parsed = RuntimeOutput.parse(JSON.parse(line));
    if (!parsed.ok) throw new Error(`contract runtime failed: ${parsed.error ?? 'unknown error'}`);
    return parsed.schemas;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function endpointFor(route: RouteInfo): ContractEndpoint {
  return { method: route.method.toUpperCase(), path: route.path, request: {}, responses: {}, sources: {}, statuses: [] };
}

/**
 * Request parts the route may consume without an extractable schema: unparsed reads in the handler (a bare
 * or computed `req` use counts for every part), and the body when route-level middleware may read it or
 * the handler could not be resolved.
 */
function opaqueParts(route: RouteInfo): RequestPart[] {
  const out = new Set<RequestPart>();
  for (const u of route.unparsedReads) {
    if (isRequestPart(u.target)) out.add(u.target);
    else if (u.target === 'req' || u.target.startsWith('req[')) for (const p of REQUEST_PARTS) out.add(p);
  }
  if (route.handler === undefined || route.middleware.length > 0) out.add('body');
  return REQUEST_PARTS.filter((p) => out.has(p));
}

function collect(routes: RouteInfo[], checker: ts.TypeChecker, warnings: string[]): { endpoints: ContractEndpoint[]; slots: Slot[] } {
  const endpoints: ContractEndpoint[] = [];
  const seen = new Set<string>();
  const slots: Slot[] = [];
  for (const route of routes) {
    const ep = endpointFor(route);
    const label = `${ep.method} ${ep.path}`;
    if (seen.has(label)) {
      warnings.push(`${label}: registered more than once (${route.file}:${route.line}); first registration kept`);
      continue;
    }
    seen.add(label);
    endpoints.push(ep);
    for (const p of route.parses) {
      if (p.target in ep.request) {
        warnings.push(`${label}: ${p.target} parsed more than once; first parse kept`);
        continue;
      }
      ep.request[p.target] = null;
      ep.sources[p.target] = sha(schemaSourceText(checker, p.schema.expr));
      slots.push({ endpoint: ep, key: p.target, io: 'input', ref: p.schema });
    }
    const opaque = opaqueParts(route);
    if (opaque.length > 0) ep.opaque = opaque;
    const statuses = new Set<number>();
    for (const s of route.statusLiterals) statuses.add(s.status);
    // Callee sites too, so moving a `throw notFound()` between the handler and a service is not a status change.
    for (const s of [...route.problemSites, ...route.calleeProblemSites]) if (s.status !== null) statuses.add(s.status);
    for (const r of route.responses) {
      if (r.status === null) {
        warnings.push(`${label}: response with a non-literal status ignored`);
        continue;
      }
      statuses.add(r.status);
      if (r.status < 200 || r.status > 299) continue;
      const key = `response.${r.status}`;
      const status = String(r.status);
      if (r.schema !== undefined) {
        if (key in ep.sources && slots.some((s) => s.endpoint === ep && s.key === key)) continue; // first schema wins
        ep.responses[status] = null;
        ep.sources[key] = sha(schemaSourceText(checker, r.schema.expr));
        slots.push({ endpoint: ep, key, io: 'output', ref: r.schema });
      } else if (!(status in ep.responses)) {
        ep.responses[status] = null;
        if (r.hasBody) {
          const body = r.call.arguments[0];
          ep.sources[key] = sha(tokenText(body ?? r.call));
          warnings.push(`${label}: ${status} body is not parsed with a schema; tracked by source text only`);
        }
      }
    }
    ep.statuses = [...statuses].sort((a, b) => a - b);
  }
  endpoints.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  return { endpoints, slots };
}

function stripMeta(s: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = { ...s };
  delete out.$schema;
  return out;
}

export async function extractContract(opts: {
  apiRoot: string;
  harnessRoot: string;
  exec: Exec;
  program?: ts.Program;
  /**
   * API-relative modules that are operator code (unchanged since the base commit). Every other module
   * is imported by the contract runtime only if it is declarative (schema-purity.ts). Default: none.
   */
  trusted?: (rel: string) => boolean;
}): Promise<Contract> {
  const root = resolve(opts.apiRoot);
  const files = await apiSourceFiles(root);
  const program = opts.program ?? createApiProgram(root, files);
  const warnings: string[] = [];
  const routes = extractRoutes(program, root, files);
  const { endpoints, slots } = collect(routes, program.getTypeChecker(), warnings);

  const refKey = (m: string, e: string): string => `${m}#${e}`;
  const wanted = new Map<string, { module: string; exportName: string }>();
  const purity: PurityContext = {
    read: (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null),
    trusted: opts.trusted ?? (() => false),
  };
  const memo = new Map<string, string | null>();
  const refused = new Map<string, string>();
  for (const s of slots) {
    if (s.ref.module !== undefined && s.ref.exportName !== undefined) {
      // Importing a module executes it: agent code that could fake the measurement is never imported.
      const why = notImportable(s.ref.module, purity, memo);
      if (why !== null) refused.set(s.ref.module, why);
      else wanted.set(refKey(s.ref.module, s.ref.exportName), { module: s.ref.module, exportName: s.ref.exportName });
    }
  }
  let converted: RuntimeSchemas = [];
  try {
    converted = await convertAtRuntime({ apiRoot: root, harnessRoot: opts.harnessRoot, exec: opts.exec, refs: [...wanted.values()] });
  } catch (e) {
    warnings.push(`runtime schema conversion failed; static fallback for every schema: ${e instanceof Error ? e.message : String(e)}`);
  }
  const byRef = new Map(converted.map((c) => [refKey(c.module, c.exportName), c]));

  let staticCount = 0;
  for (const s of slots) {
    const label = `${s.endpoint.method} ${s.endpoint.path} ${s.key}`;
    const hit = s.ref.module !== undefined && s.ref.exportName !== undefined ? byRef.get(refKey(s.ref.module, s.ref.exportName)) : undefined;
    const schema = hit === undefined ? undefined : s.io === 'input' ? hit.input : hit.output;
    if (schema === undefined) {
      staticCount++;
      const why = hit?.error ?? (s.ref.module === undefined ? `schema "${s.ref.text}" is not an exported const`
        : refused.get(s.ref.module) !== undefined ? `not imported at runtime: ${refused.get(s.ref.module) ?? ''}` : 'no runtime result');
      warnings.push(`${label}: static fallback (${why})`);
      continue;
    }
    const value = stripMeta(schema);
    if (s.key.startsWith('response.')) s.endpoint.responses[s.key.slice('response.'.length)] = value;
    else if (isRequestPart(s.key)) s.endpoint.request[s.key] = value;
  }
  return { endpoints, extractedWith: staticCount === 0 ? 'runtime' : 'static', warnings };
}

function isRequestPart(k: string): k is RequestPart {
  return (REQUEST_PARTS as readonly string[]).includes(k);
}

// ───────────────────────────── base snapshot ─────────────────────────────

const snapshotRoots = new Map<string, string>();

/**
 * Materialise the base commit's version of the API under <harnessRoot>/.harness/tmp
 * (`git archive <baseSha> <rootRel>`) and return the API directory inside it.
 * node_modules resolution: the temp dir lives under the harness root; an API-level
 * node_modules (if the worktree has one) is symlinked in.
 */
export async function snapshotBase(opts: {
  repoRoot: string;
  baseSha: string;
  rootRel: string;
  harnessRoot: string;
  exec: Exec;
}): Promise<string> {
  if (opts.baseSha.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(opts.baseSha)) {
    throw new Error(`invalid base revision "${opts.baseSha}"`);
  }
  const rel = opts.rootRel === '.' ? '' : opts.rootRel.replace(/\/+$/, '');
  const dir = tmpDir(opts.harnessRoot, 'contract-base');
  try {
    const tar = join(dir, 'base.tar');
    const args = ['-C', opts.repoRoot, 'archive', '--format=tar', '-o', tar, opts.baseSha];
    if (rel !== '') args.push('--', rel);
    const a = await opts.exec('git', args, { cwd: opts.repoRoot, timeoutMs: 60_000 });
    if (a.code !== 0) throw new Error(`git archive failed: ${a.stderr.trim().split('\n')[0] ?? ''}`);
    const tree = join(dir, 'tree');
    mkdirSync(tree, { recursive: true });
    const x = await opts.exec('tar', ['-xf', tar, '-C', tree], { cwd: dir, timeoutMs: 60_000 });
    if (x.code !== 0) throw new Error(`tar failed: ${x.stderr.trim().split('\n')[0] ?? ''}`);
    rmSync(tar, { force: true });
    const apiDir = rel === '' ? tree : join(tree, rel);
    if (!existsSync(apiDir)) throw new Error(`${rel} does not exist at ${opts.baseSha}`);
    for (const nm of [join(opts.repoRoot, rel, 'node_modules'), join(opts.repoRoot, 'node_modules')]) {
      const link = join(apiDir, 'node_modules');
      if (existsSync(nm) && !existsSync(link)) {
        symlinkSync(nm, link, 'dir');
        break;
      }
    }
    snapshotRoots.set(apiDir, dir);
    return apiDir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Remove a directory created by snapshotBase. */
export function removeSnapshot(apiDir: string): void {
  const dir = snapshotRoots.get(apiDir);
  if (dir === undefined) return;
  snapshotRoots.delete(apiDir);
  rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────────── diff ─────────────────────────────

type Dir = 'request' | 'response';
type Acc = ContractDiff;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deref(s: unknown, root: JsonSchema, depth = 0): JsonSchema | null {
  if (!isRecord(s)) return null;
  const ref = s.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/') && depth < 16) {
    let cur: unknown = root;
    for (const seg of ref.slice(2).split('/')) {
      const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      cur = isRecord(cur) ? cur[key] : undefined;
    }
    return deref(cur, root, depth + 1);
  }
  return s;
}

function branches(s: JsonSchema, root: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const k of ['anyOf', 'oneOf']) {
    const v = s[k];
    if (Array.isArray(v)) for (const b of v) {
      const d = deref(b, root);
      if (d !== null) out.push(d);
    }
  }
  return out;
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Set of JSON types a schema admits; null = unconstrained. */
export function typesOf(s: JsonSchema, root: JsonSchema): Set<string> | null {
  const t = s.type;
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'));
  const bs = branches(s, root);
  if (bs.length > 0) {
    const out = new Set<string>();
    for (const b of bs) {
      const bt = typesOf(b, root);
      if (bt === null) return null;
      for (const x of bt) out.add(x);
    }
    return out;
  }
  if (Array.isArray(s.enum)) return new Set(s.enum.map(jsonType));
  if ('const' in s) return new Set([jsonType(s.const)]);
  if (isRecord(s.properties)) return new Set(['object']);
  return null;
}

/** Allowed literal values (JSON-encoded), ignoring null branches; null = not an enum. */
export function enumOf(s: JsonSchema, root: JsonSchema): Set<string> | null {
  if (Array.isArray(s.enum)) return new Set(s.enum.map((v) => JSON.stringify(v)));
  if ('const' in s) return new Set([JSON.stringify(s.const)]);
  const bs = branches(s, root).filter((b) => b.type !== 'null');
  if (bs.length === 0) return null;
  const out = new Set<string>();
  for (const b of bs) {
    const e = enumOf(b, root);
    if (e === null) return null;
    for (const x of e) out.add(x);
  }
  return out;
}

interface ObjectView {
  properties: Map<string, unknown>;
  required: Set<string>;
}

function objectView(s: JsonSchema, root: JsonSchema): ObjectView | null {
  const parts: JsonSchema[] = [];
  if (isRecord(s.properties)) parts.push(s);
  if (Array.isArray(s.allOf)) for (const b of s.allOf) {
    const d = deref(b, root);
    if (d !== null && isRecord(d.properties)) parts.push(d);
  }
  if (parts.length === 0) {
    const b = branches(s, root).find((x) => isRecord(x.properties));
    if (b !== undefined) parts.push(b);
  }
  if (parts.length === 0) return null;
  const view: ObjectView = { properties: new Map(), required: new Set() };
  for (const p of parts) {
    if (isRecord(p.properties)) for (const [k, v] of Object.entries(p.properties)) view.properties.set(k, v);
    if (Array.isArray(p.required)) for (const r of p.required) if (typeof r === 'string') view.required.add(r);
  }
  return view;
}

function itemsOf(s: JsonSchema, root: JsonSchema): JsonSchema | null {
  const direct = deref(s.items, root);
  if (direct !== null) return direct;
  for (const b of branches(s, root)) {
    const d = deref(b.items, root);
    if (d !== null) return d;
  }
  return null;
}

/** `b` admits every type in `a` (integer is admitted by number). */
function covers(b: Set<string> | null, a: Set<string> | null): boolean {
  if (b === null) return true;
  if (a === null) return false;
  for (const t of a) if (!b.has(t) && !(t === 'integer' && b.has('number'))) return false;
  return true;
}

function fmtTypes(t: Set<string> | null): string {
  return t === null ? 'any' : [...t].sort().join('|');
}

function fmtValues(v: string[]): string {
  return v.slice(0, 8).join(', ') + (v.length > 8 ? `, … ${v.length - 8} more` : '');
}

function join2(loc: string, prop: string): string {
  return /\s$/.test(loc) || loc.endsWith('.') ? `${loc}${prop}` : `${loc}.${prop}`;
}

// ── constraint keywords ──
//
// Rule (request = what the API accepts, response = what clients receive):
// - request: a narrowing (bound added or tightened, pattern/format added, unknown keys newly rejected)
//   rejects input that was accepted, so it is breaking; a widening is additive.
// - response: reversed. A widening (bound loosened or removed, format/pattern removed) lets a response fall
//   outside what clients were promised and validate against, so it is breaking; a narrowing is additive.
//   Undeclared response properties are the exception: tolerant readers ignore unknown fields (a new
//   response property is additive too), so they are informational.
// - a changed pattern, format or incompatible multipleOf is breaking both ways (neither contains the other).
// - default: on a request it decides what an omitted value becomes (changed or removed = breaking, added =
//   additive); on a response it only documents a value (informational).
// Constraints of a union are compared only on its single non-null branch (a nullable or optional value).

/** A numeric bound; `exclusive` = the bound value itself is not allowed. */
interface Bound {
  value: number;
  exclusive: boolean;
}

type Side = 'min' | 'max';

/** Keywords that constrain a value of a single type. */
const CONSTRAINT_KEYS: readonly string[] = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
];
const COUNT_KEYS: readonly string[] = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
const OBJECT_KEYS: readonly string[] = ['properties', 'additionalProperties', 'propertyNames'];

/** A finite number below 2^53 - 1 (the implicit bound of every integer schema, e.g. z.int(): it constrains nothing). */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < Number.MAX_SAFE_INTEGER ? v : undefined;
}

/** The schema that carries `keys`: itself, or the single non-null branch of a nullable/optional union. */
function carrier(s: JsonSchema, root: JsonSchema, keys: readonly string[], depth = 0): JsonSchema {
  if (depth > 8 || keys.some((k) => k in s)) return s;
  const bs = branches(s, root).filter((x) => x.type !== 'null');
  const only = bs.length === 1 ? bs[0] : undefined;
  return only === undefined ? s : carrier(only, root, keys, depth + 1);
}

function stricter(a: Bound, b: Bound, side: Side): boolean {
  if (a.value !== b.value) return side === 'min' ? a.value > b.value : a.value < b.value;
  return a.exclusive && !b.exclusive;
}

/**
 * Effective lower or upper bound of a number schema: minimum/maximum, draft 2020-12 numeric and draft-04
 * boolean exclusive bounds, the stricter one when several are given. On an integer-only schema every bound
 * becomes the equivalent inclusive integer (> 0 and >= 0.5 are both >= 1).
 */
function numericBound(s: JsonSchema, side: Side, integer: boolean): Bound | null {
  const exclusiveKeyword = side === 'min' ? s.exclusiveMinimum : s.exclusiveMaximum;
  const found: Bound[] = [];
  const inclusive = finite(side === 'min' ? s.minimum : s.maximum);
  if (inclusive !== undefined) found.push({ value: inclusive, exclusive: exclusiveKeyword === true });
  const exclusive = finite(exclusiveKeyword);
  if (exclusive !== undefined) found.push({ value: exclusive, exclusive: true });
  let best: Bound | null = null;
  for (const raw of found) {
    const bound = !integer ? raw : {
      value: side === 'min'
        ? (raw.exclusive ? Math.floor(raw.value) + 1 : Math.ceil(raw.value))
        : (raw.exclusive ? Math.ceil(raw.value) - 1 : Math.floor(raw.value)),
      exclusive: false,
    };
    if (best === null || stricter(bound, best, side)) best = bound;
  }
  return best;
}

/** Request: a narrowing is breaking, a widening additive. Response: reversed (see the rule above). */
function byDirection(narrows: boolean, dir: Dir, location: string, message: string, acc: Acc): void {
  ((dir === 'request') === narrows ? acc.breaking : acc.additive).push({ location, message });
}

function compareBound(
  label: string, side: Side, b: Bound | null, a: Bound | null, show: (x: Bound) => string, loc: string, dir: Dir, acc: Acc,
): void {
  if (b === null && a !== null) byDirection(true, dir, loc, `${label} added: ${show(a)}`, acc);
  else if (b !== null && a === null) byDirection(false, dir, loc, `${label} removed (was ${show(b)})`, acc);
  else if (b !== null && a !== null) {
    if (stricter(a, b, side)) byDirection(true, dir, loc, `${label} narrows: ${show(b)} → ${show(a)}`, acc);
    else if (stricter(b, a, side)) byDirection(false, dir, loc, `${label} widens: ${show(b)} → ${show(a)}`, acc);
  }
}

function short(s: string): string {
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** pattern / format: added narrows, removed widens, changed is breaking both ways. */
function compareRestriction(label: string, bv: unknown, av: unknown, loc: string, dir: Dir, acc: Acc): void {
  const b = typeof bv === 'string' ? bv : undefined;
  const a = typeof av === 'string' ? av : undefined;
  if (b === a) return;
  if (b === undefined && a !== undefined) byDirection(true, dir, loc, `${label} added: ${short(a)}`, acc);
  else if (b !== undefined && a === undefined) byDirection(false, dir, loc, `${label} removed (was ${short(b)})`, acc);
  else if (b !== undefined && a !== undefined) acc.breaking.push({ location: loc, message: `${label} changes: ${short(b)} → ${short(a)}` });
}

function isMultiple(x: number, of: number): boolean {
  const q = x / of;
  return Math.abs(q - Math.round(q)) < 1e-9;
}

/** multipleOf: a new step that is a multiple of the old one narrows; a divisor of it widens; anything else changes. */
function compareMultipleOf(bv: unknown, av: unknown, loc: string, dir: Dir, acc: Acc): void {
  const step = (v: unknown): number | undefined => {
    const n = finite(v);
    return n !== undefined && n > 0 ? n : undefined;
  };
  const b = step(bv);
  const a = step(av);
  if (b === a) return;
  if (b === undefined && a !== undefined) byDirection(true, dir, loc, `multipleOf added: ${String(a)}`, acc);
  else if (b !== undefined && a === undefined) byDirection(false, dir, loc, `multipleOf removed (was ${String(b)})`, acc);
  else if (b !== undefined && a !== undefined) {
    if (isMultiple(a, b)) byDirection(true, dir, loc, `multipleOf narrows: ${String(b)} → ${String(a)}`, acc);
    else if (isMultiple(b, a)) byDirection(false, dir, loc, `multipleOf widens: ${String(b)} → ${String(a)}`, acc);
    else acc.breaking.push({ location: loc, message: `multipleOf changes: ${String(b)} → ${String(a)}` });
  }
}

function integerOnly(s: JsonSchema, root: JsonSchema): boolean {
  const t = typesOf(s, root);
  return t !== null && t.size === 1 && t.has('integer');
}

/** Bounds, lengths, counts, multipleOf, format, pattern and uniqueItems of one value. */
function compareConstraints(bIn: JsonSchema, aIn: JsonSchema, roots: { b: JsonSchema; a: JsonSchema }, loc: string, dir: Dir, acc: Acc): void {
  const b = carrier(bIn, roots.b, CONSTRAINT_KEYS);
  const a = carrier(aIn, roots.a, CONSTRAINT_KEYS);
  for (const side of ['min', 'max'] as const) {
    const show = (x: Bound): string => `${side === 'min' ? '>' : '<'}${x.exclusive ? '' : '='} ${String(x.value)}`;
    const label = side === 'min' ? 'minimum' : 'maximum';
    compareBound(label, side, numericBound(b, side, integerOnly(b, roots.b)), numericBound(a, side, integerOnly(a, roots.a)), show, loc, dir, acc);
  }
  for (const keyword of COUNT_KEYS) {
    const count = (s: JsonSchema): Bound | null => {
      const v = finite(s[keyword]);
      return v === undefined ? null : { value: v, exclusive: false };
    };
    compareBound(keyword, keyword.startsWith('min') ? 'min' : 'max', count(b), count(a), (x) => String(x.value), loc, dir, acc);
  }
  compareMultipleOf(b.multipleOf, a.multipleOf, loc, dir, acc);
  compareRestriction('format', b.format, a.format, loc, dir, acc);
  compareRestriction('pattern', b.pattern, a.pattern, loc, dir, acc);
  const bu = b.uniqueItems === true;
  const au = a.uniqueItems === true;
  if (bu !== au) byDirection(au, dir, loc, au ? 'items must now be unique' : 'items no longer need to be unique', acc);
}

/** default: request = behaviour for an omitted value; response = documentation only (see the rule above). */
function compareDefault(b: JsonSchema, a: JsonSchema, loc: string, dir: Dir, acc: Acc): void {
  const bd = 'default' in b ? JSON.stringify(b.default) : undefined;
  const ad = 'default' in a ? JSON.stringify(a.default) : undefined;
  if (bd === ad) return;
  const change = `${bd ?? 'none'} → ${ad ?? 'none'}`;
  if (dir === 'response') acc.informational.push({ location: loc, message: `default changes: ${change}` });
  else if (bd === undefined) acc.additive.push({ location: loc, message: `default added: ${ad ?? ''}` });
  else acc.breaking.push({ location: loc, message: `default changes: ${change} (an omitted value now behaves differently)` });
}

/** additionalProperties: false = closed; otherwise the schema undeclared keys must match ({} when absent or true). */
function extraKeys(s: JsonSchema): JsonSchema | false {
  const v = s.additionalProperties;
  if (v === false) return false;
  return isRecord(v) ? v : {};
}

/** Undeclared keys (closed vs open, record value schemas) and record key schemas of an object. */
function compareExtraKeys(
  bIn: JsonSchema, aIn: JsonSchema, roots: { b: JsonSchema; a: JsonSchema }, loc: string, dir: Dir, acc: Acc, depth: number,
): void {
  const b = carrier(bIn, roots.b, OBJECT_KEYS);
  const a = carrier(aIn, roots.a, OBJECT_KEYS);
  if (!(typesOf(b, roots.b)?.has('object') ?? false) || !(typesOf(a, roots.a)?.has('object') ?? false)) return;
  const be = extraKeys(b);
  const ae = extraKeys(a);
  if (be !== false && ae === false) {
    byDirection(true, dir, loc, dir === 'request' ? 'undeclared properties are now rejected' : 'response no longer carries undeclared properties', acc);
  } else if (be === false && ae !== false) {
    if (dir === 'request') acc.additive.push({ location: loc, message: 'undeclared properties are now accepted' });
    else acc.informational.push({ location: loc, message: 'response may now include undeclared properties' });
  } else if (be !== false && ae !== false) {
    compareSchemas(be, ae, roots, `${loc}.*`, dir, acc, depth + 1);
  }
  // Keys are strings anyway: a key schema is compared only when both sides declare one.
  if (isRecord(b.propertyNames) && isRecord(a.propertyNames)) {
    compareSchemas(b.propertyNames, a.propertyNames, roots, `${loc}{keys}`, dir, acc, depth + 1);
  }
}

function compareSchemas(
  bIn: unknown, aIn: unknown, roots: { b: JsonSchema; a: JsonSchema }, loc: string, dir: Dir, acc: Acc, depth: number,
): void {
  if (depth > 24) return;
  const b = deref(bIn, roots.b);
  const a = deref(aIn, roots.a);
  if (b === null || a === null) return;

  const tb = typesOf(b, roots.b);
  const ta = typesOf(a, roots.a);
  if (dir === 'request') {
    if (!covers(ta, tb)) acc.breaking.push({ location: loc, message: `type narrows: ${fmtTypes(tb)} → ${fmtTypes(ta)}` });
    else if (!covers(tb, ta)) acc.additive.push({ location: loc, message: `type widens: ${fmtTypes(tb)} → ${fmtTypes(ta)}` });
  } else {
    if (!covers(tb, ta)) acc.breaking.push({ location: loc, message: `type changes: ${fmtTypes(tb)} → ${fmtTypes(ta)}` });
    else if (!covers(ta, tb)) acc.additive.push({ location: loc, message: `type narrows: ${fmtTypes(tb)} → ${fmtTypes(ta)}` });
  }

  const eb = enumOf(b, roots.b);
  const ea = enumOf(a, roots.a);
  if (eb !== null || ea !== null) {
    const lost = eb === null ? [] : [...eb].filter((v) => ea !== null && !ea.has(v));
    const gained = ea === null ? [] : [...ea].filter((v) => eb !== null && !eb.has(v));
    if (dir === 'request') {
      if (eb === null && ea !== null) acc.breaking.push({ location: loc, message: `now restricted to values: ${fmtValues([...ea])}` });
      if (lost.length > 0) acc.breaking.push({ location: loc, message: `enum loses values: ${fmtValues(lost)}` });
      if (gained.length > 0) acc.additive.push({ location: loc, message: `enum gains values: ${fmtValues(gained)}` });
      if (eb !== null && ea === null) acc.additive.push({ location: loc, message: 'enum restriction removed' });
    } else {
      if (eb !== null && ea === null) acc.breaking.push({ location: loc, message: 'enum restriction removed (any value may be returned)' });
      if (gained.length > 0) acc.breaking.push({ location: loc, message: `enum gains values: ${fmtValues(gained)}` });
      if (lost.length > 0) acc.additive.push({ location: loc, message: `enum loses values: ${fmtValues(lost)}` });
      if (eb === null && ea !== null) acc.additive.push({ location: loc, message: `now restricted to values: ${fmtValues([...ea])}` });
    }
  }

  compareConstraints(b, a, roots, loc, dir, acc);
  compareDefault(b, a, loc, dir, acc);

  const ob = objectView(b, roots.b);
  const oa = objectView(a, roots.a);
  if (ob !== null && oa !== null) {
    if (dir === 'request') {
      for (const p of oa.required) {
        if (ob.required.has(p)) continue;
        acc.breaking.push({
          location: join2(loc, p),
          message: ob.properties.has(p) ? 'property becomes required' : 'new required property',
        });
      }
      for (const p of ob.properties.keys()) {
        if (!oa.properties.has(p)) acc.breaking.push({ location: join2(loc, p), message: 'property no longer accepted' });
      }
      for (const p of oa.properties.keys()) {
        if (!ob.properties.has(p) && !oa.required.has(p)) acc.additive.push({ location: join2(loc, p), message: 'new optional property' });
      }
      for (const p of ob.required) {
        if (!oa.required.has(p) && oa.properties.has(p)) acc.additive.push({ location: join2(loc, p), message: 'property becomes optional' });
      }
    } else {
      for (const p of ob.properties.keys()) {
        if (!oa.properties.has(p)) acc.breaking.push({ location: join2(loc, p), message: 'property removed from response' });
        else if (ob.required.has(p) && !oa.required.has(p)) acc.breaking.push({ location: join2(loc, p), message: 'property becomes optional' });
        else if (!ob.required.has(p) && oa.required.has(p)) acc.additive.push({ location: join2(loc, p), message: 'property now always present' });
      }
      for (const p of oa.properties.keys()) {
        if (!ob.properties.has(p)) acc.additive.push({ location: join2(loc, p), message: 'new response property' });
      }
    }
    for (const [p, bs] of ob.properties) {
      if (oa.properties.has(p)) compareSchemas(bs, oa.properties.get(p), roots, join2(loc, p), dir, acc, depth + 1);
    }
  }
  compareExtraKeys(b, a, roots, loc, dir, acc, depth);

  const ib = itemsOf(b, roots.b);
  const ia = itemsOf(a, roots.a);
  if (ib !== null && ia !== null) compareSchemas(ib, ia, roots, `${loc}[]`, dir, acc, depth + 1);
}

function requiredCount(s: JsonSchema): number {
  return objectView(s, s)?.required.size ?? 0;
}

function emptyDiff(): ContractDiff {
  return { breaking: [], additive: [], unproven: [], informational: [] };
}

const SET_KEYWORDS = new Set(['required', 'enum', 'type', 'anyOf', 'oneOf', 'allOf']);
/** Keywords that only annotate: they never change what is accepted or returned. */
const ANNOTATIONS = new Set(['description', 'title', 'examples', 'deprecated', '$comment', '$schema', '$id', 'id']);

/**
 * Key-sorted JSON without annotations; arrays with set semantics (required, enum, type, anyOf, oneOf,
 * allOf) sorted; `additionalProperties: true` or `{}` dropped (the same as absent).
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (!isRecord(v)) return JSON.stringify(v) ?? 'null';
  const open = (x: unknown): boolean => x === true || (isRecord(x) && Object.keys(x).length === 0);
  const keys = Object.keys(v).filter((k) => !ANNOTATIONS.has(k) && !(k === 'additionalProperties' && open(v[k])));
  const entries = keys.sort().map((k) => {
    const x = v[k];
    const value = Array.isArray(x) && SET_KEYWORDS.has(k) ? `[${x.map(canonical).sort().join(',')}]` : canonical(x);
    return `${JSON.stringify(k)}:${value}`;
  });
  return `{${entries.join(',')}}`;
}

function compareSlot(
  label: string, key: string, dir: Dir,
  b: JsonSchema | null | undefined, a: JsonSchema | null | undefined,
  bSrc: string | undefined, aSrc: string | undefined, acc: Acc,
): void {
  const loc = `${label} ${key}`;
  if (b === undefined && a === undefined) return;
  if (b === undefined) {
    if (a === null) acc.unproven.push({ location: loc, message: 'now validated, but the schema shape could not be extracted' });
    else if (a !== undefined && requiredCount(a) > 0) acc.breaking.push({ location: loc, message: `now validated and requires: ${[...(objectView(a, a)?.required ?? [])].join(', ')}` });
    else acc.additive.push({ location: loc, message: 'now validated (no required properties)' });
    return;
  }
  if (a === undefined) {
    // The parse may have moved (into middleware, a helper) or been dropped: nothing to compare against.
    acc.unproven.push({ location: loc, message: 'no longer validated where the harness can see it (moved or removed); the request contract cannot be compared' });
    return;
  }
  const bUnknown = b === null && bSrc !== undefined;
  const aUnknown = a === null && aSrc !== undefined;
  if (bUnknown || aUnknown) {
    if (bSrc !== undefined && bSrc === aSrc) return; // same schema source text on both sides
    acc.unproven.push({ location: loc, message: 'schema source changed but its shape could not be extracted at runtime' });
    return;
  }
  if (b === null && a === null) return; // no body on either side
  if (b === null) {
    acc.additive.push({ location: loc, message: 'response now has a body' });
    return;
  }
  if (a === null) {
    acc.breaking.push({ location: loc, message: 'response body removed' });
    return;
  }
  const slot = emptyDiff();
  compareSchemas(b, a, { b, a }, loc, dir, slot, 0);
  if (slot.breaking.length + slot.additive.length + slot.unproven.length + slot.informational.length > 0) {
    acc.breaking.push(...slot.breaking);
    acc.additive.push(...slot.additive);
    acc.unproven.push(...slot.unproven);
    acc.informational.push(...slot.informational);
  } else if (canonical(b) !== canonical(a)) {
    acc.unproven.push({ location: loc, message: 'JSON Schema changed in keywords the contract diff does not classify' });
  } else if (bSrc !== undefined && aSrc !== undefined && bSrc !== aSrc) {
    acc.unproven.push({
      location: loc,
      message: 'schema source changed but its JSON Schema is identical: validation changed in a way the contract cannot see (e.g. .refine, .transform)',
    });
  }
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * A POST/PUT/PATCH whose body has no schema on either side but is read without one (unparsed, by route
 * middleware, or by a handler that could not be resolved): its request contract is never "preserved".
 */
function compareOpaqueBody(b: ContractEndpoint, a: ContractEndpoint, label: string, acc: Acc): void {
  if (!BODY_METHODS.has(a.method) || 'body' in b.request || 'body' in a.request) return;
  if (!(b.opaque ?? []).includes('body') && !(a.opaque ?? []).includes('body')) return;
  acc.unproven.push({
    location: `${label} body`,
    message: 'request contract not extractable: the body is read without a schema the harness can see (unparsed, in route middleware, or by an unresolved handler)',
  });
}

/**
 * Non-2xx statuses as a set (2xx are compared as responses). A new 4xx may reject requests that were
 * accepted: breaking. A removed status, or a new 3xx/5xx, cannot fail a request that works today:
 * informational. Which condition produces which error status is not visible statically.
 */
function compareStatuses(b: ContractEndpoint, a: ContractEndpoint, label: string, acc: Acc): void {
  const before = new Set(b.statuses);
  const after = new Set(a.statuses);
  for (const s of after) {
    if (s < 300 || before.has(s)) continue;
    const location = `${label} response.${String(s)}`;
    if (s >= 400 && s < 500) acc.breaking.push({ location, message: `new ${String(s)} response: may reject requests that were accepted` });
    else acc.informational.push({ location, message: `new ${String(s)} response` });
  }
  for (const s of before) {
    if (s < 300 || after.has(s)) continue;
    acc.informational.push({ location: `${label} response.${String(s)}`, message: `${String(s)} response no longer produced` });
  }
}

function endpointKey(e: ContractEndpoint): string {
  return `${e.method} ${e.path.replace(/:[^/]+/g, ':')}`;
}

function dedupe(list: Change[]): Change[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.location}\u0000${c.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function diffContracts(before: Contract, after: Contract): ContractDiff {
  const acc = emptyDiff();
  const bMap = new Map(before.endpoints.map((e) => [endpointKey(e), e]));
  const aMap = new Map(after.endpoints.map((e) => [endpointKey(e), e]));
  for (const [k, b] of bMap) {
    const a = aMap.get(k);
    const label = `${b.method} ${b.path}`;
    if (a === undefined) {
      acc.breaking.push({ location: label, message: 'route removed' });
      continue;
    }
    const aLabel = `${a.method} ${a.path}`;
    for (const part of REQUEST_PARTS) {
      compareSlot(aLabel, part, 'request', b.request[part], a.request[part], b.sources[part], a.sources[part], acc);
    }
    compareOpaqueBody(b, a, aLabel, acc);
    for (const status of Object.keys(b.responses)) {
      const key = `response.${status}`;
      if (!(status in a.responses)) {
        acc.breaking.push({ location: `${aLabel} ${key}`, message: `${status} response removed` });
        continue;
      }
      compareSlot(aLabel, key, 'response', b.responses[status], a.responses[status], b.sources[key], a.sources[key], acc);
    }
    for (const status of Object.keys(a.responses)) {
      if (!(status in b.responses)) acc.additive.push({ location: `${aLabel} response.${status}`, message: `new ${status} response` });
    }
    compareStatuses(b, a, aLabel, acc);
  }
  for (const [k, a] of aMap) {
    if (!bMap.has(k)) acc.additive.push({ location: `${a.method} ${a.path}`, message: 'new route' });
  }
  return {
    breaking: dedupe(acc.breaking),
    additive: dedupe(acc.additive),
    unproven: dedupe(acc.unproven),
    informational: dedupe(acc.informational),
  };
}

/** Compact lines: `BREAKING  GET /v1/x query.status  enum loses values: "a"`. */
export function formatDiff(diff: ContractDiff, max = 40): string[] {
  const lines = [
    ...diff.breaking.map((c) => `BREAKING  ${c.location}  ${c.message}`),
    ...diff.unproven.map((c) => `UNPROVEN  ${c.location}  ${c.message}`),
    ...diff.additive.map((c) => `additive  ${c.location}  ${c.message}`),
    ...diff.informational.map((c) => `info      ${c.location}  ${c.message}`),
  ];
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`] : lines;
}

// ───────────────────────────── base comparison (gate + tool) ─────────────────────────────

export interface BaseComparison {
  before: Contract;
  after: Contract;
  diff: ContractDiff;
}

/** Snapshot the base commit, extract both contracts and diff them. Throws on extraction failure. */
export async function compareWithBase(ctx: RunContext): Promise<BaseComparison> {
  const ws = ctx.workspace;
  const harnessRoot = ctx.run.harnessRoot;
  const snap = await snapshotBase({
    repoRoot: ws.repoRoot, baseSha: ctx.run.baseSha, rootRel: ws.rootRel, harnessRoot, exec: ctx.exec,
  });
  try {
    // The base is operator code; in the worktree only files still identical to the base are.
    const before = await extractContract({ apiRoot: snap, harnessRoot, exec: ctx.exec, trusted: () => true });
    const sameAsBase = (rel: string): boolean => {
      const a = join(snap, rel);
      const b = join(ws.root, rel);
      return existsSync(a) && existsSync(b) && readFileSync(a, 'utf8') === readFileSync(b, 'utf8');
    };
    const after = await extractContract({ apiRoot: ws.root, harnessRoot, exec: ctx.exec, trusted: sameAsBase });
    return { before, after, diff: diffContracts(before, after) };
  } finally {
    removeSnapshot(snap);
  }
}

