/**
 * openapi_diff: compare the API's implemented contract (routes + request/response
 * schemas, extracted from the code) with either
 *   - an OpenAPI 3.x JSON document (openapi.json or docs/openapi.json in the API root,
 *     or the `spec` input): documented vs implemented, or
 *   - the base commit of the run: before vs after (a greenfield API that did not exist
 *     at the base diffs against an empty contract).
 * Returns compact lines (route set + BREAKING / UNPROVEN / additive changes); the full
 * contracts go to the raw log. Reuses the contract lock's extractor and diff rules.
 *
 * Drop-in: copy this file to plugins/tools/. The next run offers it to the model.
 */
import { z } from 'zod';
import { defineTool } from '../lib/plugin-helpers.ts';
import type { JsonSchema, RunContext, ToolResult } from '../lib/plugin-helpers.ts';
import { diffContracts, extractContract, formatDiff, removeSnapshot, snapshotBase } from '../lib/contract.ts';
import type { Contract, ContractDiff, ContractEndpoint } from '../lib/contract.ts';

const SPEC_CANDIDATES = ['openapi.json', 'docs/openapi.json'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_LINES = 30;

const Input = z.object({
  against: z.enum(['auto', 'spec', 'base']).optional()
    .describe('auto (default): the OpenAPI file if one exists, else the base commit.'),
  spec: z.string().optional().describe('OpenAPI JSON path relative to the API root (default: openapi.json, docs/openapi.json).'),
});

// ───────────────────────────── OpenAPI → Contract ─────────────────────────────

const Obj = z.record(z.string(), z.unknown());
const Param = z.looseObject({ name: z.string(), in: z.string(), required: z.boolean().optional(), schema: Obj.optional() });
const Media = z.looseObject({ schema: Obj.optional() });
const WithContent = z.looseObject({ content: z.record(z.string(), Media).optional() });
const Operation = z.looseObject({
  parameters: z.array(z.unknown()).optional(),
  requestBody: z.unknown().optional(),
  responses: Obj.optional(),
});
const PathItem = z.looseObject({ parameters: z.array(z.unknown()).optional() });
const OpenApiDoc = z.looseObject({ openapi: z.string(), paths: z.record(z.string(), Obj) });

function pointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Inline every local `$ref` (cycles and depth > 32 become `{}`). */
export function deref(value: unknown, doc: unknown, depth = 0, seen: ReadonlySet<string> = new Set()): unknown {
  if (depth > 32) return {};
  if (Array.isArray(value)) return value.map((v) => deref(v, doc, depth + 1, seen));
  if (typeof value !== 'object' || value === null) return value;
  const rec = value as Record<string, unknown>;
  const ref = rec['$ref'];
  if (typeof ref === 'string') {
    if (seen.has(ref)) return {};
    return deref(pointer(doc, ref) ?? {}, doc, depth + 1, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = deref(v, doc, depth + 1, seen);
  return out;
}

function jsonSchemaOf(content: Record<string, z.infer<typeof Media>> | undefined): JsonSchema | null {
  if (content === undefined) return null;
  const key = Object.keys(content).find((k) => k === 'application/json' || /\+json$|\/json$/.test(k));
  return key === undefined ? null : (content[key]?.schema ?? null);
}

function paramsObject(params: Array<z.infer<typeof Param>>, where: string, lower: boolean): JsonSchema | undefined {
  const ps = params.filter((p) => p.in === where);
  if (ps.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of ps) {
    const name = lower ? p.name.toLowerCase() : p.name;
    properties[name] = p.schema ?? {};
    if (p.required === true || where === 'path') required.push(name);
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** An OpenAPI 3.x document as a contract the contract lock's diff rules understand. */
export function specToContract(raw: unknown): Contract {
  const doc = OpenApiDoc.parse(raw);
  const warnings: string[] = [];
  const endpoints: ContractEndpoint[] = [];
  for (const [path, itemRaw] of Object.entries(doc.paths)) {
    const item = PathItem.parse(deref(itemRaw, raw));
    for (const method of METHODS) {
      const opRaw = item[method];
      if (opRaw === undefined) continue;
      const op = Operation.parse(opRaw);
      const params: Array<z.infer<typeof Param>> = [];
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const parsed = Param.safeParse(p);
        if (parsed.success) params.push(parsed.data);
        else warnings.push(`${method.toUpperCase()} ${path}: unreadable parameter ignored`);
      }
      const ep: ContractEndpoint = {
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, ':$1'),
        request: {},
        responses: {},
        sources: {},
        statuses: [],
      };
      const pathParams = paramsObject(params, 'path', false);
      const query = paramsObject(params, 'query', false);
      const headers = paramsObject(params, 'header', true);
      if (pathParams !== undefined) ep.request.params = pathParams;
      if (query !== undefined) ep.request.query = query;
      if (headers !== undefined) ep.request.headers = headers;
      const body = WithContent.safeParse(op.requestBody);
      if (op.requestBody !== undefined && body.success) {
        const schema = jsonSchemaOf(body.data.content);
        if (schema !== null) ep.request.body = schema;
      }
      for (const [status, resp] of Object.entries(op.responses ?? {})) {
        const code = Number(status);
        if (Number.isInteger(code)) ep.statuses.push(code);
        if (!/^2\d\d$/.test(status)) continue;
        const r = WithContent.safeParse(resp);
        ep.responses[status] = r.success ? jsonSchemaOf(r.data.content) : null;
      }
      ep.statuses.sort((a, b) => a - b);
      endpoints.push(ep);
    }
  }
  endpoints.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  return { endpoints, extractedWith: 'runtime', warnings };
}

// ───────────────────────────── report ─────────────────────────────

const routeKey = (e: ContractEndpoint): string => `${e.method} ${e.path.replace(/:[^/]+/g, ':')}`;

/** Compact report lines: route-set delta first, then the classified changes. */
export function report(before: Contract, after: Contract, diff: ContractDiff, labels: { before: string; after: string; spec: boolean }): string[] {
  const b = new Map(before.endpoints.map((e) => [routeKey(e), e]));
  const a = new Map(after.endpoints.map((e) => [routeKey(e), e]));
  const added = [...a].filter(([k]) => !b.has(k)).map(([, e]) => `${e.method} ${e.path}`);
  const removed = [...b].filter(([k]) => !a.has(k)).map(([, e]) => `${e.method} ${e.path}`);
  const rename = (d: ContractDiff): ContractDiff => {
    if (!labels.spec) return d;
    const msg = (m: string): string => m === 'route removed' ? 'documented but not implemented' : m === 'new route' ? 'implemented but not documented' : m;
    const fix = (cs: ContractDiff['breaking']): ContractDiff['breaking'] => cs.map((c) => ({ ...c, message: msg(c.message) }));
    return { breaking: fix(d.breaking), additive: fix(d.additive), unproven: fix(d.unproven) };
  };
  const plus = labels.spec ? 'undocumented' : 'added';
  const minus = labels.spec ? 'missing' : 'removed';
  const lines = [
    `openapi_diff ${labels.before} → ${labels.after}: ${before.endpoints.length} → ${after.endpoints.length} routes `
      + `(${added.length} ${plus}, ${removed.length} ${minus}); ${diff.breaking.length} breaking, ${diff.unproven.length} unproven, ${diff.additive.length} additive`,
  ];
  if (after.extractedWith === 'static') lines.push(`note: some schemas compared by source text only (${after.warnings.length} warnings in raw output)`);
  lines.push(...formatDiff(rename(diff), MAX_LINES));
  return lines;
}

// ───────────────────────────── sources ─────────────────────────────

const EMPTY: Contract = { endpoints: [], extractedWith: 'runtime', warnings: [] };

async function baseContract(ctx: RunContext): Promise<{ contract: Contract; label: string }> {
  const label = `base ${ctx.run.baseSha.slice(0, 7)}`;
  let snap: string;
  try {
    snap = await snapshotBase({
      repoRoot: ctx.workspace.repoRoot, baseSha: ctx.run.baseSha, rootRel: ctx.workspace.rootRel,
      harnessRoot: ctx.run.harnessRoot, exec: ctx.exec,
    });
  } catch (e) {
    // A greenfield API did not exist at the base commit: everything is new.
    if (e instanceof Error && /does not exist at|did not match any files/.test(e.message)) return { contract: EMPTY, label: `${label} (no API yet)` };
    throw e;
  }
  try {
    return { contract: await extractContract({ apiRoot: snap, harnessRoot: ctx.run.harnessRoot, exec: ctx.exec }), label };
  } finally {
    removeSnapshot(snap);
  }
}

async function findSpec(ctx: RunContext, given: string | undefined): Promise<string | undefined> {
  if (given !== undefined) return given;
  for (const c of SPEC_CANDIDATES) if (await ctx.workspace.exists(c)) return c;
  return undefined;
}

export async function openapiDiff(input: z.infer<typeof Input>, ctx: RunContext): Promise<ToolResult> {
  const against = input.against ?? 'auto';
  const specPath = against === 'base' ? undefined : await findSpec(ctx, input.spec);
  if (against === 'spec' && specPath === undefined) {
    return { ok: false, summary: `openapi_diff: no OpenAPI file (looked for ${SPEC_CANDIDATES.join(', ')}); pass spec or against: base` };
  }
  let before: Contract;
  let label: string;
  if (specPath !== undefined) {
    const text = await ctx.workspace.read(specPath);
    if (text === null) return { ok: false, summary: `openapi_diff: ${specPath} does not exist` };
    try {
      before = specToContract(JSON.parse(text));
    } catch (e) {
      return { ok: false, summary: `openapi_diff: ${specPath} is not an OpenAPI 3.x JSON document: ${e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e)}` };
    }
    label = specPath;
  } else {
    ({ contract: before, label } = await baseContract(ctx));
  }
  const after = await extractContract({ apiRoot: ctx.workspace.root, harnessRoot: ctx.run.harnessRoot, exec: ctx.exec });
  const diff = diffContracts(before, after);
  const lines = report(before, after, diff, { before: label, after: specPath !== undefined ? 'implementation' : 'working tree', spec: specPath !== undefined });
  return { ok: true, summary: lines.join('\n'), raw: JSON.stringify({ against: label, before, after, diff }, null, 2), data: diff };
}

export default defineTool({
  name: 'openapi_diff',
  description: 'Diff the implemented routes and request/response schemas against openapi.json (if present) or the base commit; compact breaking/additive lines.',
  input: Input,
  effect: 'exec',
  async run(input, ctx) {
    try {
      return await openapiDiff(input, ctx);
    } catch (e) {
      return { ok: false, summary: `openapi_diff: contract extraction failed (UNPROVEN): ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
