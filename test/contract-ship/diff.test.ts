import { describe, expect, it } from 'vitest';
import { diffContracts, formatDiff } from '../../plugins/lib/contract.ts';
import type { Contract, ContractEndpoint } from '../../plugins/lib/contract.ts';
import type { JsonSchema } from '../../src/core/types.ts';

const Project: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['active', 'archived'] },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  },
  required: ['id', 'name', 'status'],
  additionalProperties: false,
};

function ep(method: string, path: string, over: Partial<ContractEndpoint> = {}): ContractEndpoint {
  return { method, path, request: {}, responses: { '200': Project }, sources: {}, statuses: [200], ...over };
}

function contract(...endpoints: ContractEndpoint[]): Contract {
  return { endpoints, extractedWith: 'runtime', warnings: [] };
}

const listQuery: JsonSchema = {
  type: 'object',
  properties: { cursor: { type: 'string' }, status: { type: 'string', enum: ['active', 'archived'] } },
};
const createBody: JsonSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

function base(): Contract {
  return contract(
    ep('GET', '/v1/projects', { request: { query: listQuery } }),
    ep('POST', '/v1/projects', { request: { body: createBody }, responses: { '201': Project }, statuses: [201] }),
    ep('GET', '/v1/projects/:projectId', { request: { params: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } } }),
    ep('DELETE', '/v1/projects/:projectId', { responses: { '204': null }, statuses: [204] }),
  );
}

function clone(c: Contract): Contract {
  return structuredClone(c);
}

function find(c: Contract, method: string, path: string): ContractEndpoint {
  const e = c.endpoints.find((x) => x.method === method && x.path === path);
  if (e === undefined) throw new Error(`no ${method} ${path}`);
  return e;
}

describe('diffContracts', () => {
  it('identical contracts have no changes', () => {
    expect(diffContracts(base(), base())).toEqual({ breaking: [], additive: [], unproven: [], informational: [] });
  });

  it('removed route is breaking; added route is additive', () => {
    const after = clone(base());
    after.endpoints = after.endpoints.filter((e) => e.method !== 'DELETE');
    after.endpoints.push(ep('POST', '/v1/projects/:projectId/archives', { responses: { '201': Project } }));
    const d = diffContracts(base(), after);
    expect(d.breaking).toEqual([{ location: 'DELETE /v1/projects/:projectId', message: 'route removed' }]);
    expect(d.additive).toEqual([{ location: 'POST /v1/projects/:projectId/archives', message: 'new route' }]);
  });

  it('renaming a path parameter is not a change', () => {
    const after = clone(base());
    find(after, 'DELETE', '/v1/projects/:projectId').path = '/v1/projects/:id';
    expect(diffContracts(base(), after).breaking).toEqual([]);
  });

  it('new required body field is breaking; new optional field is additive', () => {
    const after = clone(base());
    find(after, 'POST', '/v1/projects').request.body = {
      type: 'object',
      properties: { name: { type: 'string' }, ownerId: { type: 'string' }, note: { type: 'string' } },
      required: ['name', 'ownerId'],
    };
    const d = diffContracts(base(), after);
    expect(d.breaking).toEqual([{ location: 'POST /v1/projects body.ownerId', message: 'new required property' }]);
    expect(d.additive).toEqual([{ location: 'POST /v1/projects body.note', message: 'new optional property' }]);
  });

  it('request property removed or made required is breaking', () => {
    const after = clone(base());
    find(after, 'GET', '/v1/projects').request.query = {
      type: 'object', properties: { cursor: { type: 'string' } }, required: ['cursor'],
    };
    const d = diffContracts(base(), after);
    expect(d.breaking).toContainEqual({ location: 'GET /v1/projects query.cursor', message: 'property becomes required' });
    expect(d.breaking).toContainEqual({ location: 'GET /v1/projects query.status', message: 'property no longer accepted' });
  });

  it('removed response field and field becoming optional are breaking; new field is additive', () => {
    const after = clone(base());
    const props = { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['active', 'archived'] }, createdAt: { type: 'string' } };
    find(after, 'GET', '/v1/projects/:projectId').responses['200'] = { type: 'object', properties: props, required: ['id', 'status'] };
    const d = diffContracts(base(), after);
    expect(d.breaking).toEqual([
      { location: 'GET /v1/projects/:projectId response.200.name', message: 'property becomes optional' },
      { location: 'GET /v1/projects/:projectId response.200.tags', message: 'property removed from response' },
    ]);
    expect(d.additive).toEqual([{ location: 'GET /v1/projects/:projectId response.200.createdAt', message: 'new response property' }]);
  });

  it('request enum narrowing is breaking, widening is additive', () => {
    const narrowed = clone(base());
    find(narrowed, 'GET', '/v1/projects').request.query = {
      type: 'object', properties: { cursor: { type: 'string' }, status: { type: 'string', enum: ['active'] } },
    };
    expect(diffContracts(base(), narrowed).breaking).toEqual([
      { location: 'GET /v1/projects query.status', message: 'enum loses values: "archived"' },
    ]);
    const widened = clone(base());
    find(widened, 'GET', '/v1/projects').request.query = {
      type: 'object', properties: { cursor: { type: 'string' }, status: { type: 'string', enum: ['active', 'archived', 'draft'] } },
    };
    const d = diffContracts(base(), widened);
    expect(d.breaking).toEqual([]);
    expect(d.additive).toEqual([{ location: 'GET /v1/projects query.status', message: 'enum gains values: "draft"' }]);
  });

  it('response enum widening is breaking, narrowing is not (also inside arrays)', () => {
    const after = clone(base());
    const r: JsonSchema = structuredClone(Project); // endpoints share one Project object; replace, do not mutate
    find(after, 'GET', '/v1/projects/:projectId').responses['200'] = r;
    const props = r.properties as Record<string, JsonSchema>;
    props.status = { type: 'string', enum: ['active', 'archived', 'deleted'] };
    props.tags = { type: 'array', items: { type: 'string', enum: ['a'] } };
    const d = diffContracts(base(), after);
    expect(d.breaking).toEqual([{ location: 'GET /v1/projects/:projectId response.200.status', message: 'enum gains values: "deleted"' }]);
    expect(d.additive).toEqual([{ location: 'GET /v1/projects/:projectId response.200.tags[]', message: 'enum loses values: "b"' }]);
  });

  it('type narrowing in a request and nullable response are breaking', () => {
    const b = contract(ep('POST', '/v1/things', {
      request: { body: { type: 'object', properties: { n: { type: 'number' } } } },
      responses: { '201': { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } },
    }));
    const a = contract(ep('POST', '/v1/things', {
      request: { body: { type: 'object', properties: { n: { type: 'integer' } } } },
      responses: { '201': { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['v'] } },
    }));
    expect(diffContracts(b, a).breaking).toEqual([
      { location: 'POST /v1/things body.n', message: 'type narrows: number → integer' },
      { location: 'POST /v1/things response.201.v', message: 'type changes: string → null|string' },
    ]);
  });

  it('removed 2xx status is breaking', () => {
    const after = clone(base());
    const post = find(after, 'POST', '/v1/projects');
    post.responses = { '200': Project };
    const d = diffContracts(base(), after);
    expect(d.breaking).toEqual([{ location: 'POST /v1/projects response.201', message: '201 response removed' }]);
    expect(d.additive).toEqual([{ location: 'POST /v1/projects response.200', message: 'new 200 response' }]);
  });

  it('static fallback: same source hash is no change; changed source is unproven', () => {
    const b = contract(ep('GET', '/v1/x', { request: { query: null }, sources: { query: 'h1' } }));
    expect(diffContracts(b, structuredClone(b))).toEqual({ breaking: [], additive: [], unproven: [], informational: [] });
    const a = contract(ep('GET', '/v1/x', { request: { query: null }, sources: { query: 'h2' } }));
    const d = diffContracts(b, a);
    expect(d.unproven).toHaveLength(1);
    expect(d.unproven[0]?.location).toBe('GET /v1/x query');
    // a runtime shape on one side only cannot be compared either
    const c = contract(ep('GET', '/v1/x', { request: { query: listQuery }, sources: { query: 'h3' } }));
    expect(diffContracts(b, c).unproven).toHaveLength(1);
  });

  it('newly validated request part with required props is breaking', () => {
    const b = contract(ep('POST', '/v1/x'));
    const a = contract(ep('POST', '/v1/x', { request: { headers: { type: 'object', properties: { 'idempotency-key': { type: 'string' } }, required: ['idempotency-key'] } } }));
    expect(diffContracts(b, a).breaking).toEqual([{ location: 'POST /v1/x headers', message: 'now validated and requires: idempotency-key' }]);
    const opt = contract(ep('POST', '/v1/x', { request: { headers: { type: 'object', properties: { 'idempotency-key': { type: 'string' } } } } }));
    expect(diffContracts(b, opt).breaking).toEqual([]);
  });

  it('formatDiff prints compact lines', () => {
    const after = clone(base());
    after.endpoints = after.endpoints.filter((e) => e.method !== 'DELETE');
    expect(formatDiff(diffContracts(base(), after))).toEqual(['BREAKING  DELETE /v1/projects/:projectId  route removed']);
  });
});
