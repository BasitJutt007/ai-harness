/**
 * Task files: the only input that describes WHAT to build. They never name a
 * model or provider (unknown keys such as "model" are rejected).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import pluralize from 'pluralize';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { LoadedTask, Operation, ResourceSpec, Task } from './types.ts';

const ALL_OPERATIONS: Operation[] = ['list', 'get', 'create', 'update', 'delete'];
const SERVER_MANAGED = new Set(['id', 'createdAt', 'updatedAt']);

const ident = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be an identifier ([A-Za-z][A-Za-z0-9_]*)');
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'must be relative to the repository root')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ".."');

const FieldSchema = z
  .object({
    name: ident.refine((n) => !SERVER_MANAGED.has(n), 'id, createdAt and updatedAt are server-managed; do not list them'),
    type: z.enum(['string', 'email', 'uuid', 'integer', 'number', 'boolean', 'datetime', 'enum']),
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
    fields: z.array(FieldSchema).min(1),
    operations: z.array(z.enum(['list', 'get', 'create', 'update', 'delete'])).min(1).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.fields.forEach((f, i) => {
      if (seen.has(f.name)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'name'], message: `duplicate field "${f.name}"` });
      seen.add(f.name);
    });
  })
  .transform(
    (r): ResourceSpec => ({
      name: r.name,
      plural: r.plural ?? pluralize.plural(r.name),
      fields: r.fields,
      operations: r.operations !== undefined ? [...new Set(r.operations)] : [...ALL_OPERATIONS],
    }),
  );

const common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must match ^[a-z0-9][a-z0-9-]*$'),
  title: z.string().min(1),
  behaviours: z.array(z.string().min(1)).default([]),
  limits: z
    .object({
      maxTurns: z.number().int().min(1).default(60),
      maxOutputTokens: z.number().int().min(256).max(128000).default(16000),
    })
    .strict()
    .default({ maxTurns: 60, maxOutputTokens: 16000 }),
};

const GreenfieldSchema = z
  .object({
    kind: z.literal('greenfield'),
    ...common,
    output: relPath,
    template: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default('express-zod'),
    basePath: z.string().regex(/^\/v\d+$/, 'basePath must look like /v1').default('/v1'),
    resources: z.array(ResourceSchema).min(1),
  })
  .strict();

const BrownfieldSchema = z
  .object({
    kind: z.literal('brownfield'),
    ...common,
    target: relPath,
    change: z.string().min(1),
    scope: z
      .object({
        allow: z.array(z.string().min(1)).min(1).default(['src/**/*.ts', 'test/**/*.ts']),
        deny: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] }),
    allowBreaking: z.boolean().default(false),
  })
  .strict();

export const TaskFileSchema: z.ZodType<Task, unknown> = z.discriminatedUnion('kind', [GreenfieldSchema, BrownfieldSchema]);

function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const at = i.path.length > 0 ? i.path.join('.') : '(root)';
      if (i.code === 'unrecognized_keys') {
        const keys = i.keys.map((k) => `"${k}"`).join(', ');
        const hint = i.keys.some((k) => /^(model|provider|driver)$/i.test(k))
          ? ' (task files are provider-neutral; choose the model with --driver/--model)'
          : '';
        return `${at}: unknown key ${keys} is not allowed${hint}`;
      }
      return `${at}: ${i.message}`;
    })
    .join('\n  ');
}

/** Parse + validate already-decoded task data. Throws with readable issues. */
export function parseTask(data: unknown, source = 'task'): Task {
  const res = TaskFileSchema.safeParse(data);
  if (!res.success) throw new Error(`invalid task file ${source}:\n  ${formatIssues(res.error)}`);
  return res.data;
}

export async function loadTask(file: string): Promise<LoadedTask> {
  const abs = resolve(file);
  const bytes = await readFile(abs);
  const text = bytes.toString('utf8');
  const ext = extname(abs).toLowerCase();
  let data: unknown;
  try {
    if (ext === '.json') data = JSON.parse(text);
    else if (ext === '.yaml' || ext === '.yml') data = parseYaml(text);
    else throw new Error(`unsupported task file extension "${ext}" (use .yaml, .yml or .json)`);
  } catch (e) {
    throw new Error(`cannot parse task file ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const task = parseTask(data, abs);
  return { task, file: abs, sha256: createHash('sha256').update(bytes).digest('hex') };
}
