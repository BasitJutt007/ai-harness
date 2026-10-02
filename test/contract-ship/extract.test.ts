import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import contractLock from '../../plugins/gates/contract-lock.ts';
import contractDiffTool from '../../plugins/tools/contract_diff.ts';
import { diffContracts, extractContract, removeSnapshot, snapshotBase } from '../../plugins/lib/contract.ts';
import type { Contract } from '../../plugins/lib/contract.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { apiFiles, brownfieldTask, git, greenfieldTask, isolatedExec, makeCtx, repoTmp, ROUTES, SCHEMAS, writeFiles } from './helpers.ts';

const tmp = repoTmp('extract');
let base: Contract;

beforeAll(async () => {
  writeFiles(join(tmp.dir, 'api-a'), apiFiles());
  base = await extractContract({ apiRoot: join(tmp.dir, 'api-a'), harnessRoot: HARNESS_ROOT, exec: isolatedExec });
});
afterAll(() => tmp.cleanup());

describe('extractContract', () => {
  it('extracts every route with runtime JSON Schemas', () => {
    expect(base.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /v1/projects',
      'POST /v1/projects',
      'DELETE /v1/projects/:projectId',
      'GET /v1/projects/:projectId',
    ]);
    const list = base.endpoints.find((e) => e.method === 'GET' && e.path === '/v1/projects');
    expect(list?.request.query).toMatchObject({
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'archived'] } },
    });
    expect(list?.responses['200']).toMatchObject({ properties: { data: { type: 'array' }, nextCursor: {} }, required: ['data', 'nextCursor'] });
    const post = base.endpoints.find((e) => e.method === 'POST');
    expect(post?.request.body).toMatchObject({ required: ['name'] });
    expect(Object.keys(post?.responses ?? {})).toEqual(['201']);
    // A non-exported schema has no runtime shape: static fallback via source hash.
    expect(post?.request.headers).toBeNull();
    expect(post?.sources.headers).toMatch(/^[0-9a-f]{64}$/);
    expect(base.extractedWith).toBe('static');
    expect(base.warnings.some((w) => w.includes('POST /v1/projects headers: static fallback'))).toBe(true);
    const del = base.endpoints.find((e) => e.method === 'DELETE');
    expect(del?.responses).toEqual({ '204': null });
    const get = base.endpoints.find((e) => e.method === 'GET' && e.path.endsWith(':projectId'));
    expect(get?.statuses).toEqual([200, 404]);
  });

  it('detects a narrowed enum and a removed route against a changed copy', async () => {
    const routes = ROUTES.replace(/projectsRouter\.delete[\s\S]*$/, '');
    writeFiles(join(tmp.dir, 'api-b'), apiFiles({
      'src/schemas.ts': SCHEMAS.replace("status: z.enum(['active', 'archived']).optional()", "status: z.enum(['active']).optional()"),
      'src/routes/projects.ts': routes,
    }));
    const after = await extractContract({ apiRoot: join(tmp.dir, 'api-b'), harnessRoot: HARNESS_ROOT, exec: isolatedExec });
    const d = diffContracts(base, after);
    expect(d.breaking).toEqual([
      { location: 'GET /v1/projects query.status', message: 'enum loses values: "archived"' },
      { location: 'DELETE /v1/projects/:projectId', message: 'route removed' },
    ]);
    expect(d.unproven).toEqual([]);
  });

  it('a changed non-exported schema is unproven, never silently passed', async () => {
    writeFiles(join(tmp.dir, 'api-c'), apiFiles({
      'src/routes/projects.ts': ROUTES.replace("'x-trace': z.string().optional()", "'x-trace': z.string()"),
    }));
    const after = await extractContract({ apiRoot: join(tmp.dir, 'api-c'), harnessRoot: HARNESS_ROOT, exec: isolatedExec });
    const d = diffContracts(base, after);
    expect(d.breaking).toEqual([]);
    expect(d.unproven).toEqual([{ location: 'POST /v1/projects headers', message: 'schema source changed but its shape could not be extracted at runtime' }]);
  });
});

describe('snapshotBase + contract-lock gate + contract_diff tool', () => {
  const repo = join(tmp.dir, 'repo');
  let baseSha = '';

  beforeAll(async () => {
    writeFiles(join(repo, 'api'), apiFiles());
    writeFiles(repo, { 'README.md': 'repo\n' });
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'base');
    baseSha = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '-q', '-b', 'harness/projects-change');
  });

  it('snapshotBase materialises the base version of the API under .harness/tmp', async () => {
    writeFileSync(join(repo, 'api', 'src', 'schemas.ts'), `${SCHEMAS}\nexport const Extra = 1;\n`);
    const snap = await snapshotBase({ repoRoot: repo, baseSha, rootRel: 'api', harnessRoot: HARNESS_ROOT, exec: isolatedExec });
    try {
      expect(snap.startsWith(join(HARNESS_ROOT, '.harness', 'tmp'))).toBe(true);
      expect(readFileSync(join(snap, 'src', 'schemas.ts'), 'utf8')).toBe(SCHEMAS);
      expect(existsSync(join(snap, 'README.md'))).toBe(false);
    } finally {
      removeSnapshot(snap);
    }
    expect(existsSync(snap)).toBe(false);
    writeFileSync(join(repo, 'api', 'src', 'schemas.ts'), SCHEMAS);
  });

  const ctxFor = (allowBreaking = false) => makeCtx({
    repoRoot: repo, rootRel: 'api', task: brownfieldTask({ allowBreaking }), branch: 'harness/projects-change', baseBranch: 'main', baseSha,
  });

  it('passes with an additive summary when only additive changes exist', async () => {
    writeFileSync(join(repo, 'api', 'src', 'schemas.ts'), SCHEMAS.replace("description: z.string().optional(),", "description: z.string().optional(),\n  color: z.string().optional(),"));
    const ctx = ctxFor();
    const r = await contractLock.run(ctx, 'finish');
    expect(r.status).toBe('pass');
    expect(r.summary).toContain('additive');
    expect(r.summary).toContain('response.200.color');
    expect([...ctx.logs.files.keys()]).toEqual(['contract-before.json', 'contract-after.json', 'contract-diff.txt']);
  });

  it('fails on a breaking change unless the task allows it', async () => {
    writeFileSync(join(repo, 'api', 'src', 'schemas.ts'), SCHEMAS.replace('export const CreateProjectSchema = z.object({ name: z.string().min(1) });', 'export const CreateProjectSchema = z.object({ name: z.string().min(1), ownerId: z.string() });'));
    const r = await contractLock.run(ctxFor(), 'ship');
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(['POST /v1/projects body.ownerId  new required property']);
    const allowed = await contractLock.run(ctxFor(true), 'ship');
    expect(allowed.status).toBe('pass');
    expect(allowed.summary).toContain('1 breaking changes allowed by task');

    const tool = await contractDiffTool.run({}, ctxFor());
    expect(tool.ok).toBe(true);
    expect(tool.summary).toContain('1 breaking');
    expect(tool.summary).toContain('BREAKING  POST /v1/projects body.ownerId  new required property');
  });

  it('is unproven when the contract cannot be extracted', async () => {
    const ctx = makeCtx({ repoRoot: repo, rootRel: 'api', task: brownfieldTask(), branch: 'x', baseBranch: 'main', baseSha: 'deadbeefdeadbeef' });
    const r = await contractLock.run(ctx, 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toContain('contract extraction failed');
  });

  it('registers as brownfield-only (greenfield → n/a via runGates)', async () => {
    expect(contractLock.appliesTo).toEqual(['brownfield']);
    expect(contractLock.phases).toEqual(['finish', 'ship']);
    expect(contractDiffTool.availableIn).toEqual(['brownfield']);
    const ctx = makeCtx({ repoRoot: repo, rootRel: 'api', task: greenfieldTask(), branch: 'x', baseBranch: 'main', baseSha });
    expect((await contractLock.run(ctx, 'finish')).status).toBe('n/a');
  });
});

const SAMPLE = join(HARNESS_ROOT, 'samples', 'existing-api');
describe.runIf(existsSync(join(SAMPLE, 'src')))('extractContract on samples/existing-api', () => {
  it('extracts the sample at runtime and it is stable against itself', async () => {
    const c = await extractContract({ apiRoot: SAMPLE, harnessRoot: HARNESS_ROOT, exec: isolatedExec });
    expect(c.endpoints.length).toBeGreaterThan(0);
    expect(c.extractedWith).toBe('runtime');
    expect(diffContracts(c, structuredClone(c))).toEqual({ breaking: [], additive: [], unproven: [] });
  });
});
