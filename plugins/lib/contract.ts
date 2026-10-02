/**
 * Contract Lock (the harness's own addition): extract an API's public contract
 * and diff two versions of it.
 *
 * Routes and parse/response sites come from the shared route extractor
 * (api-ast.ts). Schemas are converted to JSON Schema at runtime by
 * contract-runtime.ts (spawned with tsx) so the contract is the real Zod shape,
 * not a guess. When a schema cannot be converted, its source text hash is kept
 * instead (static fallback): an unchanged text is no change, a changed text is
 * an UNPROVEN change, never a silent pass.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { z } from 'zod';
import type { Exec, JsonSchema, RunContext } from '../../src/core/plugin-api.ts';
import { extractRoutes, resolveSymbol } from './api-ast.ts';
import type { RouteInfo, SchemaRef } from './api-ast.ts';

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
  /** sha256 of the schema source text per location ("query", "response.200"). Used by the static fallback. */
  sources: Record<string, string>;
  /** Every literal status code the handler can produce (informational). */
  statuses: number[];
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
  /** Schema text changed but no runtime shape exists on one side: cannot be proven either way. */
  unproven: Change[];
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

/** Source text of a schema expression plus the initialisers of the consts it references (transitively). */
export function schemaSourceText(checker: ts.TypeChecker, expr: ts.Expression): string {
  const parts: string[] = [];
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Node, depth: number): void => {
    parts.push(node.getText());
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
  const dir = tmpDir(opts.harnessRoot, 'contract-refs');
  try {
    const listFile = join(dir, 'refs.json');
    writeFileSync(listFile, JSON.stringify(opts.refs));
    const tsx = join(opts.harnessRoot, 'node_modules', '.bin', 'tsx');
    const res = await opts.exec(tsx, [RUNTIME_SCRIPT, opts.apiRoot, listFile], { cwd: opts.apiRoot, timeoutMs: 60_000 });
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
    const statuses = new Set<number>();
    for (const s of route.statusLiterals) statuses.add(s.status);
    for (const s of route.problemSites) if (s.status !== null) statuses.add(s.status);
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
          ep.sources[key] = sha(body !== undefined ? body.getText() : r.call.getText());
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
}): Promise<Contract> {
  const root = resolve(opts.apiRoot);
  const files = await apiSourceFiles(root);
  const program = opts.program ?? createApiProgram(root, files);
  const warnings: string[] = [];
  const routes = extractRoutes(program, root, files);
  const { endpoints, slots } = collect(routes, program.getTypeChecker(), warnings);

  const refKey = (m: string, e: string): string => `${m}#${e}`;
  const wanted = new Map<string, { module: string; exportName: string }>();
  for (const s of slots) {
    if (s.ref.module !== undefined && s.ref.exportName !== undefined) {
      wanted.set(refKey(s.ref.module, s.ref.exportName), { module: s.ref.module, exportName: s.ref.exportName });
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
      const why = hit?.error ?? (s.ref.module === undefined ? `schema "${s.ref.text}" is not an exported const` : 'no runtime result');
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
    }
  }

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
    } else {
      for (const p of ob.properties.keys()) {
        if (!oa.properties.has(p)) acc.breaking.push({ location: join2(loc, p), message: 'property removed from response' });
        else if (ob.required.has(p) && !oa.required.has(p)) acc.breaking.push({ location: join2(loc, p), message: 'property becomes optional' });
      }
      for (const p of oa.properties.keys()) {
        if (!ob.properties.has(p)) acc.additive.push({ location: join2(loc, p), message: 'new response property' });
      }
    }
    for (const [p, bs] of ob.properties) {
      if (oa.properties.has(p)) compareSchemas(bs, oa.properties.get(p), roots, join2(loc, p), dir, acc, depth + 1);
    }
  }

  const ib = itemsOf(b, roots.b);
  const ia = itemsOf(a, roots.a);
  if (ib !== null && ia !== null) compareSchemas(ib, ia, roots, `${loc}[]`, dir, acc, depth + 1);
}

function requiredCount(s: JsonSchema): number {
  return objectView(s, s)?.required.size ?? 0;
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
    acc.additive.push({ location: loc, message: 'no longer validated' });
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
  compareSchemas(b, a, { b, a }, loc, dir, acc, 0);
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
  const acc: Acc = { breaking: [], additive: [], unproven: [] };
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
  }
  for (const [k, a] of aMap) {
    if (!bMap.has(k)) acc.additive.push({ location: `${a.method} ${a.path}`, message: 'new route' });
  }
  return { breaking: dedupe(acc.breaking), additive: dedupe(acc.additive), unproven: dedupe(acc.unproven) };
}

/** Compact lines: `BREAKING  GET /v1/x query.status  enum loses values: "a"`. */
export function formatDiff(diff: ContractDiff, max = 40): string[] {
  const lines = [
    ...diff.breaking.map((c) => `BREAKING  ${c.location}  ${c.message}`),
    ...diff.unproven.map((c) => `UNPROVEN  ${c.location}  ${c.message}`),
    ...diff.additive.map((c) => `additive  ${c.location}  ${c.message}`),
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
    const before = await extractContract({ apiRoot: snap, harnessRoot, exec: ctx.exec });
    const after = await extractContract({ apiRoot: ws.root, harnessRoot, exec: ctx.exec });
    return { before, after, diff: diffContracts(before, after) };
  } finally {
    removeSnapshot(snap);
  }
}

