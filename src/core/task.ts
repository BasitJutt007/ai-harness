/**
 * Task files: the only input that describes WHAT to build. They never name a model or provider
 * (provider keys such as "model" are rejected, see task-normalize.ts).
 *
 *   bytes -> decode (.json/.yaml/.yml/.md/.txt) -> lenient front end (task-normalize.ts)
 *         -> canonical schema below (strict) -> Task + warnings
 *
 * `--strict-task` skips the front end: the file must already be in the canonical shape.
 * Every issue is reported in one pass, never one at a time.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import pluralize from 'pluralize';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isObj, normalizeTaskData, providerKeyErrors, withoutProviderKeys } from './task-normalize.ts';
import { DEFAULT_TEMPLATE } from './template.ts';
import type { BrownfieldTask, GreenfieldTask, LoadedTask, Operation, ResourceSpec, Task, TaskFormat } from './types.ts';

const ALL_OPERATIONS: Operation[] = ['list', 'get', 'create', 'update', 'delete'];
const SERVER_MANAGED = new Set(['id', 'createdAt', 'updatedAt']);
/** Free text is shown to the model verbatim and never truncated, so it is capped instead. */
export const MAX_BRIEF_CHARS = 32_000;

const FIELD_TYPES = ['string', 'email', 'uuid', 'integer', 'number', 'decimal', 'boolean', 'datetime', 'date', 'time', 'enum', 'array', 'object', 'unknown'] as const;

const ident = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be an identifier ([A-Za-z][A-Za-z0-9_]*)');
/** A path the harness resolves against --repo: relative (portable) or absolute, never escaping with "..". */
const apiPath = z
  .string()
  .min(1)
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ".." (point --repo at the parent directory instead)');
/** Free text: surrounding whitespace (a YAML block's trailing newline) is not content. */
const freeText = (what: string): z.ZodString =>
  z
    .string()
    .trim()
    .max(MAX_BRIEF_CHARS, `${what} is longer than ${MAX_BRIEF_CHARS} characters (it is shown to the model verbatim, never truncated; shorten it)`);

const FieldSchema = z
  .object({
    name: ident.refine((n) => !SERVER_MANAGED.has(n), 'id, createdAt and updatedAt are server-managed; do not list them'),
    type: z.enum(FIELD_TYPES),
    rawType: z.string().min(1).optional(),
    required: z.boolean().default(false),
    unique: z.boolean().default(false),
    readOnly: z.boolean().default(false),
    values: z.array(z.string().min(1)).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === 'enum' && f.values === undefined) {
      ctx.addIssue({ code: 'custom', path: ['values'], message: 'enum fields need "values"' });
    }
    if (f.type !== 'enum' && f.values !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['values'], message: '"values" is only valid for enum fields' });
    }
    if (f.type === 'enum' && f.values !== undefined && typeof f.default === 'string' && !f.values.includes(f.default)) {
      ctx.addIssue({ code: 'custom', path: ['default'], message: `default "${f.default}" is not one of values` });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'min must be <= max' });
    }
  });

const ResourceSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'resource name must be a lower-case singular noun'),
    plural: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
    fields: z.array(FieldSchema),
    operations: z.array(z.enum(['list', 'get', 'create', 'update', 'delete'])).min(1).optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.fields.forEach((f, i) => {
      // `email` and `Email` are the same field to every client that maps JSON to columns.
      const key = f.name.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'name'], message: `duplicate field "${f.name}"` });
      seen.add(key);
    });
  })
  .transform(
    (r): ResourceSpec => ({
      name: r.name,
      plural: r.plural ?? pluralize.plural(r.name),
      fields: r.fields,
      operations: r.operations !== undefined ? [...new Set(r.operations)] : [...ALL_OPERATIONS],
      ...(r.notes !== undefined && r.notes.length > 0 ? { notes: r.notes } : {}),
    }),
  );

const common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must match ^[a-z0-9][a-z0-9-]*$'),
  title: z.string().min(1),
  behaviours: z.array(z.string().min(1)).default([]),
  brief: freeText('brief').min(1).optional(),
  carried: z
    .record(z.string(), z.unknown())
    .refine((c) => JSON.stringify(c).length <= MAX_BRIEF_CHARS, `carried keys are longer than ${MAX_BRIEF_CHARS} characters`)
    .optional(),
  limits: z
    .object({
      // No default: an absent maxTurns is scaled with the task's size at run time (loop.ts turnLimitFor).
      maxTurns: z.number().int().min(1).optional(),
      maxOutputTokens: z.number().int().min(256).max(128000).default(16000),
    })
    .strict()
    .default({ maxOutputTokens: 16000 }),
};

const GreenfieldSchema = z
  .object({
    kind: z.literal('greenfield'),
    ...common,
    output: apiPath,
    template: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default(DEFAULT_TEMPLATE),
    basePath: z
      .string()
      .regex(/^\/([A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?$/, 'basePath must be a URL path such as /v1')
      .default('/v1'),
    resources: z.array(ResourceSchema).default([]),
    // Free-text tasks only: 'human' opts out of the spec-coverage gate (a human verifies behaviour coverage).
    specCoverage: z.literal('human').optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.resources.length === 0 && t.brief === undefined) {
      ctx.addIssue({ code: 'custom', path: ['resources'], message: 'a greenfield task needs resources or a brief (a free-text description of the API)' });
    }
    if (t.specCoverage !== undefined && t.resources.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['specCoverage'], message: 'specCoverage: human is only for a free-text task without resources (with resources the spec-coverage gate probes them)' });
    }
  });

const CHANGE_NEEDED = 'a brownfield task needs a change: what to do, in prose (change / description / brief), or acceptance criteria';

const BrownfieldSchema = z
  .object({
    kind: z.literal('brownfield'),
    ...common,
    target: apiPath,
    change: freeText('change').min(1, CHANGE_NEEDED),
    scope: z
      .object({
        allow: z.array(z.string().min(1)).min(1).default(['src/**/*.ts', 'test/**/*.ts']),
        deny: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] }),
    allowBreaking: z.boolean().default(false),
    // Absent = strict: the standards rules must hold at 100% over the whole API. 'baseline' is the explicit
    // opt-in to the base-commit comparison (below 100% allowed when this run introduces nothing).
    standards: z.enum(['strict', 'baseline']).optional(),
    resources: z.array(ResourceSchema).optional(),
  })
  .strict();

export const TaskFileSchema: z.ZodType<Task, unknown> = z.discriminatedUnion('kind', [GreenfieldSchema, BrownfieldSchema]);

/** `resources.0.fields.1.min` -> `resources.0(order).fields.1(quantity).min`: names make map-style input traceable. */
function issuePath(path: ReadonlyArray<PropertyKey>, data: unknown): string {
  const parts: string[] = [];
  let cur: unknown = data;
  for (const seg of path) {
    const next: unknown = Array.isArray(cur) && typeof seg === 'number' ? cur[seg] : isObj(cur) && typeof seg === 'string' ? cur[seg] : undefined;
    const name = isObj(next) && typeof next.name === 'string' && typeof seg === 'number' ? `(${next.name})` : '';
    parts.push(`${String(seg)}${name}`);
    cur = next;
  }
  return parts.length > 0 ? parts.join('.') : '(root)';
}

function formatIssues(err: z.ZodError, data: unknown): string[] {
  return err.issues.map((i) => {
    const at = issuePath(i.path, data);
    if (i.code === 'unrecognized_keys') return `${at}: unknown key ${i.keys.map((k) => `"${k}"`).join(', ')} is not allowed`;
    if (i.code === 'invalid_type' && i.path[i.path.length - 1] === 'change') return `${at}: ${CHANGE_NEEDED}`;
    return `${at}: ${i.message}`;
  });
}

/** Canonical validation; a missing or unknown kind is validated against the branch the keys point to, so every issue shows. */
function validateCanonical(candidate: unknown): { task?: Task; issues: string[] } {
  if (!isObj(candidate)) {
    const r = TaskFileSchema.safeParse(candidate);
    return r.success ? { task: r.data, issues: [] } : { issues: formatIssues(r.error, candidate) };
  }
  const issues: string[] = [];
  let data = candidate;
  if (candidate.kind !== 'greenfield' && candidate.kind !== 'brownfield') {
    const brown = 'target' in candidate || 'change' in candidate;
    issues.push(`kind: must be "greenfield" (build a new API) or "brownfield" (change an existing one)${candidate.kind === undefined ? '' : `, got ${JSON.stringify(candidate.kind)}`}`);
    data = { ...candidate, kind: brown ? 'brownfield' : 'greenfield' };
  }
  const r = data.kind === 'brownfield' ? BrownfieldSchema.safeParse(data) : GreenfieldSchema.safeParse(data);
  if (!r.success) return { issues: [...issues, ...formatIssues(r.error, data)] };
  if (issues.length > 0) return { issues };
  const task: GreenfieldTask | BrownfieldTask = r.data;
  return { task, issues };
}

export interface TaskLoadOptions {
  /** Canonical shape only (no aliases, inference or carried keys): `--strict-task`. */
  strict?: boolean | undefined;
  /** `--target <dir>`: the existing API to change (implies brownfield). */
  target?: string | undefined;
  /** `--output <dir>`: where to build the new API (implies greenfield). */
  output?: string | undefined;
}

/**
 * Decoded task data -> canonical Task + warnings. Throws ONE error listing every issue.
 * `source` names the file in messages; `file` (default: source) feeds id inference.
 * `declaresScope`: the task names its own write scope (scope.allow, in any accepted spelling); when it
 * does not, the schema default (the template's src/ + test/) stands in, which a run replaces with the
 * target API's own roots (run.ts preflight).
 */
export function normalizeTask(
  data: unknown,
  opts: TaskLoadOptions & { source?: string; file?: string } = {},
): { task: Task; warnings: string[]; declaresScope: boolean } {
  const source = opts.source ?? 'task';
  let candidate: unknown = data;
  let warnings: string[] = [];
  let errors: string[] = [];
  if (opts.strict === true) {
    if (isObj(data)) {
      errors = providerKeyErrors(data);
      const c = withoutProviderKeys(data);
      if (opts.target !== undefined) {
        if (c.kind === 'greenfield') errors.push('kind is greenfield (build a new API) but --target names an existing API to change');
        c.target = opts.target;
      }
      if (opts.output !== undefined) {
        if (c.kind === 'brownfield') errors.push('kind is brownfield (change an existing API) but --output names a new output directory');
        c.output = opts.output;
      }
      candidate = c;
    }
  } else {
    const n = normalizeTaskData(data, { file: opts.file ?? source, target: opts.target, output: opts.output });
    candidate = n.candidate;
    warnings = n.warnings;
    errors = n.errors;
  }
  const v = validateCanonical(candidate);
  const all = [...errors, ...v.issues];
  if (all.length > 0 || v.task === undefined) {
    throw new Error(`invalid task file ${source}${opts.strict === true ? ' (--strict-task)' : ''}:\n  ${all.join('\n  ')}`);
  }
  // Before schema defaults: a scope with only a deny list (or nothing usable) still gets the default allow list.
  const declaresScope = isObj(candidate) && isObj(candidate.scope) && candidate.scope.allow !== undefined;
  return { task: v.task, warnings, declaresScope };
}

/** Parse + validate already-decoded task data in the canonical shape (strict). Throws with readable issues. */
export function parseTask(data: unknown, source = 'task'): Task {
  return normalizeTask(data, { strict: true, source }).task;
}

const EXT_FORMAT: Record<string, TaskFormat> = {
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
};

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Bytes -> data. JSON and YAML must parse (a syntax error is never turned into free text);
 * Markdown and plain text are a free-text brief, with optional YAML front matter for keys.
 */
export function decodeTask(text: string, file: string, strict = false): { data: unknown; format: TaskFormat } {
  const ext = extname(file).toLowerCase();
  const format = EXT_FORMAT[ext];
  if (format === undefined) throw new Error(`unsupported task file extension "${ext}" (use .yaml, .yml, .json, .md or .txt)`);
  if (strict && (format === 'markdown' || format === 'text')) throw new Error(`--strict-task accepts .yaml, .yml or .json, not "${ext}"`);
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') throw new Error('the task file is empty');
  if (format === 'json') return { data: JSON.parse(body), format };
  if (format === 'yaml') {
    const data: unknown = parseYaml(body);
    if (data === null || data === undefined) throw new Error('the task file has no content (only comments?)');
    return { data, format };
  }
  const fm = body.match(FRONT_MATTER);
  if (fm === null) return { data: body.trim(), format };
  const head: unknown = parseYaml(fm[1] ?? '');
  if (head !== null && head !== undefined && !isObj(head)) throw new Error('front matter (between the --- lines) must be a mapping of keys');
  const keys: Record<string, unknown> = isObj(head) ? { ...head } : {};
  const rest = body.slice(fm[0].length).trim();
  if (rest !== '') {
    const slot = ['brief', 'body', 'details', 'text'].find((k) => !(k in keys)) ?? 'brief';
    keys[slot] = rest;
  }
  if (Object.keys(keys).length === 0) throw new Error('the task file has no content');
  return { data: keys, format };
}

/** JSON with sorted keys and undefined dropped: the input of normalizedSha256. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function normalizedSha256(task: Task): string {
  return createHash('sha256').update(stableJson(task)).digest('hex');
}

export async function loadTask(file: string, opts: TaskLoadOptions = {}): Promise<LoadedTask> {
  const abs = resolve(file);
  const bytes = await readFile(abs);
  const strict = opts.strict === true;
  let decoded: { data: unknown; format: TaskFormat };
  try {
    decoded = decodeTask(bytes.toString('utf8'), abs, strict);
  } catch (e) {
    throw new Error(`cannot parse task file ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { task, warnings, declaresScope } = normalizeTask(decoded.data, { ...opts, strict, source: abs, file: abs });
  return {
    task,
    file: abs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    normalizedSha256: normalizedSha256(task),
    format: decoded.format,
    strict,
    warnings,
    declaresScope,
  };
}
