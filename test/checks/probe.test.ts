import { describe, expect, it } from 'vitest';
import { PROBE_UUID, buildProbes, evaluateProbe, substituteParams } from '../../plugins/lib/probe.ts';
import type { Probe } from '../../plugins/lib/probe.ts';
import { extractRoutes } from '../../plugins/lib/api-ast.ts';
import { fixtureContext } from './_ctx.ts';

const probe: Probe = { name: 'unknown id', method: 'GET', path: '/v1/users/x', expect: [404, 422] };
const goodBody = JSON.stringify({ type: 'https://api.sf/problems/not-found', title: 'Not Found', status: 404, detail: 'd', instance: '/v1/users/x' });

describe('probe helpers', () => {
  it('substitutes path params with the probe uuid', () => {
    expect(substituteParams('/v1/users/:userId/posts/:postId')).toBe(`/v1/users/${PROBE_UUID}/posts/${PROBE_UUID}`);
  });

  it('builds the §3.2 probe set for the good fixture', async () => {
    const ctx = await fixtureContext('good');
    const probes = buildProbes(extractRoutes(ctx.program(), ctx.root, ctx.sourceFiles));
    const id = `/v1/users/${PROBE_UUID}`;
    expect(probes.map((p) => `${p.method} ${p.path} ${p.name} ${p.expect.join('|')}${p.body !== undefined ? ` body=${p.body}` : ''}`)).toEqual([
      'GET /v1/__harness_probe__/does-not-exist unknown route 404',
      'GET /v1/users collection success 200|401|403',
      'POST /v1/users malformed JSON body 400 body={"__harness_probe__": ',
      'POST /v1/users invalid body 422 body=[]',
      // POST to a collection without Idempotency-Key: 428/400 if the API requires one, 422 (invalid body) if not
      'POST /v1/users missing Idempotency-Key 400|422|428 body=[]',
      `GET ${id} unknown id 404|422`,
      `PATCH ${id} malformed JSON body 400 body={"__harness_probe__": `,
      `PATCH ${id} invalid body 422|404 body=[]`,
      `PATCH ${id} unknown id 404|422 body={}`,
      `DELETE ${id} unknown id 404|422`,
      'GET /__harness_probe__/internal-error internal error 500',
    ]);
    expect(probes.find((p) => p.name === 'collection success')?.kind).toBe('success');
    expect(probes.find((p) => p.name === 'internal error')?.throwMarker).toMatch(/^harness-probe-secret-/);
    expect(probes.filter((p) => p.omitIdempotencyKey === true).map((p) => p.name)).toEqual(['missing Idempotency-Key']);
  });

  it('problem probes on API routes accept a 401/403 problem (auth required); the injected 500 probe does not', async () => {
    const ctx = await fixtureContext('good');
    const probes = buildProbes(extractRoutes(ctx.program(), ctx.root, ctx.sourceFiles));
    const invalid = probes.find((p) => p.name === 'invalid body');
    const boom = probes.find((p) => p.name === 'internal error');
    if (invalid === undefined || boom === undefined) throw new Error('probes missing');
    const p401 = goodBody.replace('404', '401');
    expect(evaluateProbe(invalid, { status: 401, contentType: 'application/problem+json', body: p401 }).ok).toBe(true);
    expect(evaluateProbe(invalid, { status: 403, contentType: 'application/problem+json', body: goodBody.replace('404', '403') }).ok).toBe(true);
    expect(evaluateProbe(invalid, { status: 401, contentType: 'text/plain', body: 'no' }).ok).toBe(false);
    expect(evaluateProbe(boom, { status: 401, contentType: 'application/problem+json', body: p401 }).problems).toContain('expected status 500, got 401');
  });

  it('success probes: a 2xx must be JSON and not problem+json; 401/403 must be problems', () => {
    const success: Probe = { name: 'collection success', method: 'GET', path: '/v1/users', expect: [200, 401, 403], kind: 'success' };
    const page = JSON.stringify({ data: [], nextCursor: null });
    expect(evaluateProbe(success, { status: 200, contentType: 'application/json; charset=utf-8', body: page }).ok).toBe(true);
    expect(evaluateProbe(success, { status: 200, contentType: 'application/problem+json', body: page }).problems).toEqual([
      'a successful response is sent as application/problem+json',
    ]);
    expect(evaluateProbe(success, { status: 200, contentType: 'text/html', body: '<p>' }).problems).toEqual([
      'Content-Type is "text/html", expected application/json',
      'body is not JSON',
    ]);
    expect(evaluateProbe(success, { status: 401, contentType: 'application/problem+json', body: goodBody.replace('404', '401') }).ok).toBe(true);
    expect(evaluateProbe(success, { status: 404, contentType: 'application/problem+json', body: goodBody }).problems).toEqual([
      'expected status 200 or 401 or 403, got 404',
    ]);
  });

  it('internal-error probe: a 500 problem must not leak the thrown message or a stack trace', () => {
    const boom: Probe = { name: 'internal error', method: 'GET', path: '/__harness_probe__/internal-error', expect: [500], throwMarker: 'secret-xyz' };
    const ok = JSON.stringify({ type: 'https://api.sf/problems/internal', title: 'Internal Server Error', status: 500, detail: 'An unexpected error occurred.', instance: '/x' });
    expect(evaluateProbe(boom, { status: 500, contentType: 'application/problem+json', body: ok }).ok).toBe(true);
    const leaky = JSON.stringify({ type: 't', title: 'x', status: 500, detail: 'Error: secret-xyz\n    at handler (/app/src/routes/users.ts:12:11)', instance: '/x' });
    expect(evaluateProbe(boom, { status: 500, contentType: 'application/problem+json', body: leaky }).problems).toEqual([
      'body leaks the internal error message',
      'body leaks a stack trace',
    ]);
  });

  it('accepts a full problem+json response', () => {
    expect(evaluateProbe(probe, { status: 404, contentType: 'application/problem+json; charset=utf-8', body: goodBody })).toMatchObject({ ok: true, problems: [] });
  });

  it('rejects wrong content type, missing fields, status mismatch and unexpected status', () => {
    const json = evaluateProbe(probe, { status: 404, contentType: 'application/json', body: goodBody });
    expect(json.ok).toBe(false);
    expect(json.problems[0]).toContain('expected application/problem+json');
    const partial = evaluateProbe(probe, { status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 't', title: 'x', status: 404 }) });
    expect(partial.problems).toEqual(['body.detail is not a string', 'body.instance is not a string']);
    const mismatch = evaluateProbe(probe, { status: 404, contentType: 'application/problem+json', body: goodBody.replace('404', '400') });
    expect(mismatch.problems).toEqual(['body.status 400 differs from HTTP status 404']);
    const wrong = evaluateProbe(probe, { status: 500, contentType: 'application/problem+json', body: goodBody.replace('404', '500') });
    expect(wrong.problems).toEqual(['expected status 404 or 422, got 500']);
    const html = evaluateProbe(probe, { status: 404, contentType: 'text/html', body: '<html>' });
    expect(html.problems).toContain('body is not JSON');
  });
});
