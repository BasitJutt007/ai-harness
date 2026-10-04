/**
 * Contract Lock end to end on real code (real Zod at runtime, real AST, real git base commit):
 * constraint narrowing, a .refine-only change, formatting-only changes, error statuses (including
 * ones thrown from a called function) and request bodies the extractor cannot see.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import contractLock from '../../plugins/gates/contract-lock.ts';
import contractDiffTool from '../../plugins/tools/contract_diff.ts';
import { diffContracts, extractContract } from '../../plugins/lib/contract.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { apiFiles, brownfieldTask, git, isolatedExec, makeCtx, repoTmp, ROUTES, SCHEMAS, writeFiles } from './helpers.ts';

const tmp = repoTmp('coverage');
afterAll(() => tmp.cleanup());

/** Extract `files` (the helpers' API with overrides) from a fresh directory. */
async function extract(label: string, overrides: Record<string, string>) {
  writeFiles(join(tmp.dir, label), apiFiles(overrides));
  return extractContract({ apiRoot: join(tmp.dir, label), harnessRoot: HARNESS_ROOT, exec: isolatedExec });
}

const NOTES = `import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

function notFound(detail: string): Error { return new Error(detail); }
function conflict(detail: string): Error { return new Error(detail); }
const audit = (_req: Request, _res: Response, next: NextFunction): void => { next(); };
const seen = new Set<string>();
function load(id: string): string {
  if (!seen.has(id)) throw notFound(id);
  return id;
}
function save(id: string): void {
  /*SAVE*/
  seen.add(id);
}

export const notesRouter = Router();
notesRouter.post('/v1/notes', audit, (req, res) => {
  const note: unknown = req.body;
  res.status(201).json({ note });
});
notesRouter.post('/v1/pings', (_req, res) => {
  res.status(204).end();
});
notesRouter.get('/v1/notes/:id', (req, res) => {
  res.json({ id: load(String(req.params.id)) });
});
notesRouter.put('/v1/notes/:id', (req, res) => {
  save(String(req.params.id));
  res.status(204).end();
});
`;

describe('extraction feeds the new diff rules', () => {
  it('a real Zod constraint change is classified (max narrowed, min added) and formatting is not a change', async () => {
    const base = await extract('c-base', {});
    const narrowed = await extract('c-narrow', {
      'src/schemas.ts': SCHEMAS
        .replace('limit: z.coerce.number().int().min(1).max(100).default(20)', 'limit: z.coerce.number().int().min(1).max(50).default(20)')
        .replace('export const CreateProjectSchema = z.object({ name: z.string().min(1) });', 'export const CreateProjectSchema = z.object({ name: z.string().min(3) });'),
    });
    const d = diffContracts(base, narrowed);
    expect(d.breaking).toEqual([
      { location: 'GET /v1/projects query.limit', message: 'maximum narrows: <= 100 → <= 50' },
      { location: 'POST /v1/projects body.name', message: 'minLength narrows: 1 → 3' },
    ]);
    expect(d.unproven).toEqual([]);
    // The non-exported header schema is compared by source tokens: comments and layout are not a change.
    const reformatted = await extract('c-format', {
      'src/routes/projects.ts': ROUTES.replace("const LocalHeaders = z.object({ 'x-trace': z.string().optional() });",
        "const LocalHeaders = z.object({\n  // tracing header\n  'x-trace':   z.string()\n    .optional()\n});"),
    });
    expect(diffContracts(base, reformatted)).toEqual({ breaking: [], additive: [], unproven: [], informational: [] });
  });

  it('a .refine-only change is UNPROVEN: the JSON Schema is identical but the validation is not', async () => {
    const base = await extract('r-base', {});
    const refined = await extract('r-after', {
      'src/schemas.ts': SCHEMAS.replace(
        'export const CreateProjectSchema = z.object({ name: z.string().min(1) });',
        "export const CreateProjectSchema = z.object({ name: z.string().min(1) }).refine((p) => p.name !== 'admin', { message: 'reserved' });",
      ),
    });
    const post = (c: typeof base) => c.endpoints.find((e) => e.method === 'POST' && e.path === '/v1/projects');
    expect(post(refined)?.request.body).toEqual(post(base)?.request.body); // JSON Schema cannot see the refinement
    const d = diffContracts(base, refined);
    expect(d.breaking).toEqual([]);
    expect(d.unproven).toEqual([{
      location: 'POST /v1/projects body',
      message: 'schema source changed but its JSON Schema is identical: validation changed in a way the contract cannot see (e.g. .refine, .transform)',
    }]);
  });

  it('records opaque bodies and statuses thrown from called functions', async () => {
    const c = await extract('n-base', { 'src/routes/notes.ts': NOTES });
    const byKey = new Map(c.endpoints.map((e) => [`${e.method} ${e.path}`, e]));
    expect(byKey.get('POST /v1/notes')?.opaque).toEqual(['body']);
    expect(byKey.get('POST /v1/pings')?.opaque).toBeUndefined();
    expect(byKey.get('GET /v1/notes/:id')?.statuses).toEqual([200, 404]);
    // an unextractable body is never "preserved", even against itself; a body nobody reads is fine
    const self = diffContracts(c, structuredClone(c));
    expect(self.unproven).toEqual([{ location: 'POST /v1/notes body', message: expect.stringContaining('request contract not extractable') }]);
    expect(self.breaking).toEqual([]);
  });
});

describe('contract-lock gate on a real base commit', () => {
  const repo = join(tmp.dir, 'repo');
  let baseSha = '';
  const notesPath = join(repo, 'api', 'src', 'routes', 'notes.ts');
  const ctxFor = (allowBreaking = false) => makeCtx({
    repoRoot: repo, rootRel: 'api', task: brownfieldTask({ allowBreaking }), branch: 'harness/notes', baseBranch: 'main', baseSha,
  });
  // the opaque POST body would make every gate run unproven: give it a schema for these cases
  const NOTES_PARSED = NOTES.replace('const note: unknown = req.body;', 'const note = z.object({ text: z.string() }).parse(req.body);')
    .replace("import { Router } from 'express';", "import { Router } from 'express';\nimport { z } from 'zod';");

  beforeAll(async () => {
    writeFiles(join(repo, 'api'), apiFiles({ 'src/routes/notes.ts': NOTES_PARSED }));
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'base');
    baseSha = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '-q', '-b', 'harness/notes');
  });

  it('a new 4xx thrown by a called function fails the gate unless the task allows breaking changes', async () => {
    writeFileSync(notesPath, NOTES_PARSED.replace('/*SAVE*/', "if (seen.has(id)) throw conflict(id);"));
    const r = await contractLock.run(ctxFor(), 'finish');
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(['PUT /v1/notes/:id response.409  new 409 response: may reject requests that were accepted']);
    const allowed = await contractLock.run(ctxFor(true), 'finish');
    expect(allowed.status).toBe('pass');
    expect(allowed.details).toContain('allowed: PUT /v1/notes/:id response.409  new 409 response: may reject requests that were accepted');
    const tool = await contractDiffTool.run({}, ctxFor());
    expect(tool.summary).toContain('1 breaking, 0 unproven, 0 additive, 0 informational');
    writeFileSync(notesPath, NOTES_PARSED);
  });

  it('a removed error status is informational: the gate passes and says so', async () => {
    writeFileSync(notesPath, NOTES_PARSED.replace('if (!seen.has(id)) throw notFound(id);', ''));
    const r = await contractLock.run(ctxFor(), 'finish');
    expect(r.status).toBe('pass');
    expect(r.summary).toContain('1 informational');
    expect(r.details).toEqual(['informational: GET /v1/notes/:id response.404  404 response no longer produced']);
    writeFileSync(notesPath, NOTES_PARSED);
  });

  it('a body that becomes unparsed (moved out of sight) is unproven, never "preserved"', async () => {
    writeFileSync(notesPath, NOTES_PARSED.replace('const note = z.object({ text: z.string() }).parse(req.body);', 'const note: unknown = req.body;'));
    const r = await contractLock.run(ctxFor(), 'finish');
    expect(r.status).toBe('unproven');
    expect(r.details).toEqual(['POST /v1/notes body  no longer validated where the harness can see it (moved or removed); the request contract cannot be compared']);
    writeFileSync(notesPath, NOTES_PARSED);
  });
});
