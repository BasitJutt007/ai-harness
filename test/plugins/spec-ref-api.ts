/**
 * Reference APIs for the spec-coverage tests, built from task data:
 *  - refApp(): an in-process Express app implementing every resource × operation of a task correctly
 *    (validation from the field specs, unique -> 409, idempotency, cursor pagination), with optional
 *    mutants that break exactly one behaviour;
 *  - refSources(): the same API as TypeScript source files with literal paths (for the sandboxed gate run),
 *    on the express-zod template's helpers.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { FieldSpec, GreenfieldTask, ResourceSpec } from '../../src/core/plugin-api.ts';

export const field = (f: Partial<FieldSpec> & Pick<FieldSpec, 'name' | 'type'>): FieldSpec => ({ required: false, unique: false, readOnly: false, ...f });
export const res = (name: string, plural: string, fields: FieldSpec[], operations: ResourceSpec['operations'] = ['list', 'get', 'create', 'update', 'delete']): ResourceSpec => ({ name, plural, fields, operations });
export const task = (resources: ResourceSpec[], extra: Partial<GreenfieldTask> = {}): GreenfieldTask => ({
  kind: 'greenfield', id: 't', title: 't', behaviours: [], limits: { maxTurns: 1, maxOutputTokens: 256 }, output: 'api', template: 'express-zod', basePath: '/v1', resources, ...extra,
});

export const USERS = res('user', 'users', [
  field({ name: 'email', type: 'email', required: true, unique: true }),
  field({ name: 'name', type: 'string', required: true, min: 1, max: 100 }),
  field({ name: 'role', type: 'enum', values: ['admin', 'member'], default: 'member' }),
]);
export const TEAMS = res('team', 'teams', [field({ name: 'name', type: 'string', required: true, unique: true, max: 50 })]);

export type Mutant =
  | 'no-validation'
  | 'unique-not-enforced'
  | 'delete-200'
  | 'patch-replaces'
  | 'no-idempotency'
  | 'auth-everything'
  | 'list-ignores-new'
  | 'no-echo'
  /** The idempotency cache holds the sent object by reference and PATCH updates the stored object in place. */
  | 'shared-reference-cache';

function fieldSchema(f: FieldSpec): z.ZodType {
  switch (f.type) {
    case 'email':
      return f.max !== undefined ? z.email().max(f.max) : z.email();
    case 'uuid':
      return z.uuid();
    case 'enum':
      return z.enum((f.values ?? ['x']) as [string, ...string[]]);
    case 'integer': {
      let s = z.number().int();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      return s;
    }
    case 'number':
    case 'decimal': {
      let s = z.number();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      return s;
    }
    case 'boolean':
      return z.boolean();
    case 'datetime':
      return z.iso.datetime();
    case 'date':
      return z.iso.date();
    case 'string': {
      let s = z.string();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      return s;
    }
    default:
      return z.unknown();
  }
}

function createSchema(r: ResourceSpec, partial: boolean): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const f of r.fields.filter((x) => !x.readOnly)) {
    const s = fieldSchema(f);
    shape[f.name] = partial || !f.required ? s.optional() : s;
  }
  return z.strictObject(shape);
}

function problem(res: Response, status: number, detail: string): void {
  res.status(status).type('application/problem+json').json({ type: 'about:blank', title: 'Problem', status, detail, instance: '/' });
}

export function refApp(resources: ResourceSpec[], basePath: string, mutants: Mutant[] = []): Express {
  const on = (m: Mutant): boolean => mutants.includes(m);
  const app = express();
  app.use(express.json());
  if (on('auth-everything')) app.use((_req, res) => problem(res, 401, 'credentials required'));
  const base = basePath === '/' ? '' : basePath;
  for (const r of resources) {
    const store = new Map<string, Record<string, unknown>>();
    const keys = new Map<string, { status: number; body: unknown }>();
    const col = `${base}/${r.plural}`;
    const create = createSchema(r, false);
    const patch = createSchema(r, true);
    const dup = (body: Record<string, unknown>, except?: string): boolean =>
      !on('unique-not-enforced') && r.fields.some((f) => f.unique && body[f.name] !== undefined && [...store.values()].some((x) => x['id'] !== except && x[f.name] === body[f.name]));
    const ops = new Set(r.operations);
    if (ops.has('list')) {
      app.get(col, (req, res) => {
        const all = [...store.values()].filter((_x, i) => !on('list-ignores-new') || i < 0);
        const start = typeof req.query['cursor'] === 'string' ? Number(req.query['cursor']) : 0;
        const page = all.slice(start, start + 2);
        res.json({ data: page, nextCursor: start + 2 < all.length ? String(start + 2) : null });
      });
    }
    if (ops.has('create')) {
      app.post(col, (req: Request, res: Response) => {
        const key = req.get('idempotency-key');
        const hit = key !== undefined && !on('no-idempotency') ? keys.get(key) : undefined;
        if (hit !== undefined) {
          res.status(hit.status).json(hit.body);
          return;
        }
        const parsed = on('no-validation') ? { success: true as const, data: req.body as Record<string, unknown> } : create.safeParse(req.body);
        if (!parsed.success) return problem(res, 422, 'invalid body');
        const defaults: Record<string, unknown> = {};
        for (const f of r.fields) if (f.default !== undefined) defaults[f.name] = f.default;
        const item = { ...defaults, ...parsed.data, id: randomUUID() };
        if (dup(item)) return problem(res, 409, 'duplicate');
        store.set(item.id, item);
        const body = on('no-echo') ? { id: item.id } : item;
        if (key !== undefined) keys.set(key, { status: 201, body: on('shared-reference-cache') ? body : structuredClone(body) });
        res.status(201).location(`${col}/${item.id}`).json(body);
      });
    }
    const item = `${col}/:id`;
    if (ops.has('get')) {
      app.get(item, (req, res) => {
        const x = store.get(String(req.params['id']));
        if (x === undefined) return problem(res, 404, 'not found');
        res.json(x);
      });
    }
    if (ops.has('update')) {
      app.patch(item, (req, res) => {
        const id = String(req.params['id']);
        const x = store.get(id);
        if (x === undefined) return problem(res, 404, 'not found');
        const parsed = patch.safeParse(req.body);
        if (!parsed.success) return problem(res, 422, 'invalid body');
        const next = on('patch-replaces') ? { ...parsed.data, id } : { ...x, ...parsed.data };
        if (dup(next, id)) return problem(res, 409, 'duplicate');
        if (on('shared-reference-cache')) {
          Object.assign(x, parsed.data);
          res.json(x);
          return;
        }
        store.set(id, next);
        res.json(next);
      });
    }
    if (ops.has('delete')) {
      app.delete(item, (req, res) => {
        if (!store.delete(String(req.params['id']))) return problem(res, 404, 'not found');
        if (on('delete-200')) res.status(200).json({ deleted: true });
        else res.status(204).end();
      });
    }
  }
  app.use((_req: Request, res: Response) => problem(res, 404, 'no route'));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => problem(res, 400, 'bad request'));
  return app;
}

export async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ───────────────────────────── as source files (sandboxed gate runs) ─────────────────────────────

function zodSource(f: FieldSpec): string {
  const b = (s: string): string => `${s}${f.min !== undefined ? `.min(${f.min})` : ''}${f.max !== undefined ? `.max(${f.max})` : ''}`;
  switch (f.type) {
    case 'email':
      return f.max !== undefined ? `z.email().max(${f.max})` : 'z.email()';
    case 'uuid':
      return 'z.uuid()';
    case 'enum':
      return `z.enum(${JSON.stringify(f.values ?? [])})`;
    case 'integer':
      return b('z.number().int()');
    case 'number':
    case 'decimal':
      return b('z.number()');
    case 'boolean':
      return 'z.boolean()';
    case 'datetime':
      return 'z.iso.datetime()';
    case 'date':
      return 'z.iso.date()';
    default:
      return b('z.string()');
  }
}

/**
 * src/routes/<plural>.ts per resource (literal /v1 paths, Zod schemas from the fields, the template's
 * idempotency() and problem helpers; PATCH updates the stored object in place, the object a create sent) and src/routes/index.ts mounting them. `skip` drops endpoints
 * ("<resource>:<op>") or whole resources ("<resource>").
 */
export function refSources(resources: ResourceSpec[], basePath: string, skip: string[] = []): Record<string, string> {
  const files: Record<string, string> = {};
  const kept = resources.filter((r) => !skip.includes(r.name));
  const base = basePath === '/' ? '' : basePath;
  for (const r of kept) {
    const has = (op: string): boolean => r.operations.some((o) => o === op) && !skip.includes(`${r.name}:${op}`);
    const fields = r.fields.filter((f) => !f.readOnly);
    const shape = fields.map((f) => `  ${f.name}: ${zodSource(f)}${f.required ? '' : '.optional()'},`).join('\n');
    const patchShape = fields.map((f) => `  ${f.name}: ${zodSource(f)}.optional(),`).join('\n');
    const uniques = fields.filter((f) => f.unique).map((f) => JSON.stringify(f.name));
    const col = `${base}/${r.plural}`;
    const lines = [
      "import { randomUUID } from 'node:crypto';",
      "import { Router } from 'express';",
      "import { z } from 'zod';",
      "import { idempotency } from '../lib/idempotency.ts';",
      "import { conflict, notFound } from '../lib/problem.ts';",
      `const Create = z.strictObject({\n${shape}\n});`,
      `const Patch = z.strictObject({\n${patchShape}\n});`,
      'const Params = z.object({ id: z.uuid() });',
      'const Query = z.object({ cursor: z.string().optional() });',
      'type Item = Record<string, unknown> & { id: string };',
      `const UNIQUE: string[] = [${uniques.join(', ')}];`,
      `export function router(): Router {`,
      '  const store = new Map<string, Item>();',
      '  const r = Router();',
      '  const dup = (x: Record<string, unknown>, except?: string): boolean => UNIQUE.some((k) => [...store.values()].some((y) => y.id !== except && y[k] === x[k]));',
    ];
    if (has('list')) lines.push(`  r.get('${col}', (req, res) => {\n    Query.parse(req.query);\n    res.json({ data: [...store.values()], nextCursor: null });\n  });`);
    if (has('create')) {
      const defaults = fields.filter((f) => f.default !== undefined).map((f) => `${f.name}: ${JSON.stringify(f.default)}`).join(', ');
      lines.push(`  r.post('${col}', idempotency(), (req, res) => {\n    const body = Create.parse(req.body);\n    const item: Item = { ${defaults}${defaults === '' ? '' : ', '}...body, id: randomUUID() };\n    if (dup(item)) throw conflict('duplicate');\n    store.set(item.id, item);\n    res.status(201).location(\`${col}/\${item.id}\`).json(item);\n  });`);
    }
    if (has('get')) lines.push(`  r.get('${col}/:id', (req, res) => {\n    const { id } = Params.parse(req.params);\n    const item = store.get(id);\n    if (item === undefined) throw notFound('not found');\n    res.json(item);\n  });`);
    if (has('update')) lines.push(`  r.patch('${col}/:id', idempotency(), (req, res) => {\n    const { id } = Params.parse(req.params);\n    const item = store.get(id);\n    if (item === undefined) throw notFound('not found');\n    const patch = Patch.parse(req.body);\n    if (dup({ ...item, ...patch }, id)) throw conflict('duplicate');\n    Object.assign(item, patch);\n    res.json(item);\n  });`);
    if (has('delete')) lines.push(`  r.delete('${col}/:id', (req, res) => {\n    const { id } = Params.parse(req.params);\n    if (!store.delete(id)) throw notFound('not found');\n    res.status(204).end();\n  });`);
    lines.push('  return r;', '}', '');
    files[`src/routes/${r.plural}.ts`] = lines.join('\n');
  }
  files['src/routes/index.ts'] = [
    "import type { Router } from 'express';",
    ...kept.map((r, i) => `import { router as r${i} } from './${r.plural}.ts';`),
    'export function registerRoutes(app: Router): void {',
    ...kept.map((_r, i) => `  app.use(r${i}());`),
    '}',
    '',
  ].join('\n');
  return files;
}
