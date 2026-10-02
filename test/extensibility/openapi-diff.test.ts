/**
 * The example openapi_diff tool: OpenAPI → contract conversion, then the full tool
 * against (a) an openapi.json next to a copy of the brownfield sample and (b) the
 * base commit of a temp git repo (including a greenfield API absent at the base).
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tool, { deref, specToContract } from '../../examples/plugins/tools/openapi_diff.ts';
import { git, makeCtx, repoTmp, SAMPLE_API } from './_helpers.ts';

const DOC = {
  openapi: '3.1.0',
  info: { title: 'Projects', version: '1' },
  paths: {
    '/v1/projects': {
      get: {
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } } },
      },
      post: {
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } },
        responses: { '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Project' } } } }, '422': { description: 'invalid' } },
      },
    },
    '/v1/projects/{projectId}': {
      parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Project' } } } }, '404': {} } },
      delete: { responses: { '204': { description: 'deleted' }, '404': {} } },
    },
  },
  components: {
    schemas: {
      Project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] },
      Page: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Project' } }, nextCursor: { type: ['string', 'null'] } } },
      Loop: { type: 'object', properties: { self: { $ref: '#/components/schemas/Loop' } } },
    },
  },
};

describe('specToContract', () => {
  it('maps paths, parameters, bodies and 2xx responses onto contract endpoints', () => {
    const c = specToContract(DOC);
    expect(c.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /v1/projects', 'POST /v1/projects', 'DELETE /v1/projects/:projectId', 'GET /v1/projects/:projectId',
    ]);
    const post = c.endpoints.find((e) => e.method === 'POST');
    expect(post?.request.headers).toEqual({ type: 'object', properties: { 'idempotency-key': { type: 'string' } } });
    expect(post?.request.body).toMatchObject({ required: ['name'] });
    expect(post?.responses).toEqual({ '201': DOC.components.schemas.Project });
    expect(post?.statuses).toEqual([201, 422]);
    const del = c.endpoints.find((e) => e.method === 'DELETE');
    expect(del?.request.params).toEqual({ type: 'object', properties: { projectId: { type: 'string', format: 'uuid' } }, required: ['projectId'] });
    expect(del?.responses).toEqual({ '204': null });
    const list = c.endpoints.find((e) => e.method === 'GET' && e.path === '/v1/projects');
    expect(Object.keys((list?.request.query?.['properties'] ?? {}) as object)).toEqual(['cursor', 'limit']);
  });

  it('inlines $ref and cuts cycles', () => {
    expect(deref({ $ref: '#/components/schemas/Loop' }, DOC)).toEqual({ type: 'object', properties: { self: {} } });
    expect(deref({ $ref: '#/nope' }, DOC)).toEqual({});
  });

  it('rejects a document that is not OpenAPI', () => {
    expect(() => specToContract({ swagger: '2.0' })).toThrow();
  });
});

describe('openapi_diff tool', () => {
  const tmp = repoTmp('openapi');
  let baseSha = '';

  beforeAll(async () => {
    cpSync(SAMPLE_API, join(tmp.dir, 'api'), { recursive: true, filter: (src) => !src.includes('node_modules') });
    await git(tmp.dir, 'init', '-q', '-b', 'main');
    await git(tmp.dir, 'add', '-A');
    await git(tmp.dir, 'commit', '-q', '-m', 'base');
    baseSha = await git(tmp.dir, 'rev-parse', 'HEAD');
  });

  afterAll(() => tmp.cleanup());

  it('is a valid drop-in tool (snake_case name, exec effect, offered in every task kind)', () => {
    expect(tool).toMatchObject({ kind: 'tool', name: 'openapi_diff', effect: 'exec' });
    expect(tool.availableIn).toBeUndefined();
  });

  it('documented vs implemented: missing and undocumented routes when openapi.json exists', async () => {
    writeFileSync(join(tmp.dir, 'api', 'openapi.json'), JSON.stringify(DOC));
    try {
      const res = await tool.run({}, makeCtx({ repoRoot: tmp.dir, rootRel: 'api', baseSha }));
      expect(res.ok).toBe(true);
      const lines = res.summary.split('\n');
      expect(lines[0]).toMatch(/^openapi_diff openapi\.json → implementation: 4 → 4 routes \(1 undocumented, 1 missing\); \d+ breaking/);
      expect(lines).toContain('BREAKING  DELETE /v1/projects/:projectId  documented but not implemented');
      expect(lines).toContain('additive  PATCH /v1/projects/:projectId  implemented but not documented');
      expect(lines.length).toBeLessThanOrEqual(32); // compact: header + note + ≤30 change lines
      expect(JSON.parse(res.raw ?? '{}')).toHaveProperty('after.endpoints');
    } finally {
      rmSync(join(tmp.dir, 'api', 'openapi.json'));
    }
  });

  it('against the base commit: a new route is additive', async () => {
    const routes = join(tmp.dir, 'api', 'src', 'modules', 'projects', 'routes.ts');
    const original = readFileSync(routes, 'utf8');
    writeFileSync(routes, `${original}\nprojectsRouter.delete('/v1/projects/:projectId', (req, res) => {\n  ProjectParamsSchema.parse(req.params);\n  res.status(204).end();\n});\n`);
    try {
      const res = await tool.run({}, makeCtx({ repoRoot: tmp.dir, rootRel: 'api', baseSha }));
      expect(res.ok).toBe(true);
      expect(res.summary.split('\n')[0]).toBe(`openapi_diff base ${baseSha.slice(0, 7)} → working tree: 4 → 5 routes (1 added, 0 removed); 0 breaking, 0 unproven, 1 additive`);
      expect(res.summary).toContain('additive  DELETE /v1/projects/:projectId  new route');
    } finally {
      writeFileSync(routes, original);
    }
  });

  it('against the base commit for an API that did not exist yet (greenfield): everything is added', async () => {
    cpSync(join(tmp.dir, 'api'), join(tmp.dir, 'newapi'), { recursive: true });
    const res = await tool.run({ against: 'base' }, makeCtx({ repoRoot: tmp.dir, rootRel: 'newapi', baseSha }));
    expect(res.ok).toBe(true);
    expect(res.summary.split('\n')[0]).toMatch(/\(no API yet\) → working tree: 0 → 4 routes \(4 added, 0 removed\); 0 breaking/);
  });

  it('against: spec without an OpenAPI file is a clear error, not a silent pass', async () => {
    const res = await tool.run({ against: 'spec' }, makeCtx({ repoRoot: tmp.dir, rootRel: 'api', baseSha }));
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/no OpenAPI file/);
  });
});
