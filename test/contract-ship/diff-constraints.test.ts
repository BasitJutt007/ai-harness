/**
 * Contract diff coverage beyond shape: constraint keywords in both directions (request narrowing
 * and response widening are breaking), defaults, undeclared keys, non-2xx statuses, validation the
 * JSON Schema cannot show (.refine), validation moving out of sight and bodies that cannot be extracted.
 */
import { describe, expect, it } from 'vitest';
import { diffContracts } from '../../plugins/lib/contract.ts';
import type { Contract, ContractDiff, ContractEndpoint } from '../../plugins/lib/contract.ts';
import type { JsonSchema } from '../../src/core/types.ts';

type Kind = keyof ContractDiff;
const KINDS: readonly Kind[] = ['breaking', 'additive', 'unproven', 'informational'];

function contract(...endpoints: ContractEndpoint[]): Contract {
  return { endpoints, extractedWith: 'runtime', warnings: [] };
}

function ep(method: string, path: string, over: Partial<ContractEndpoint> = {}): ContractEndpoint {
  return { method, path, request: {}, responses: {}, sources: {}, statuses: [], ...over };
}

/** One property `v` with schema `s`, as an optional request body field and as a required response field. */
function withValue(s: JsonSchema): Contract {
  return contract(ep('POST', '/v1/things', {
    request: { body: { type: 'object', properties: { v: s } } },
    responses: { '201': { type: 'object', properties: { v: s }, required: ['v'] } },
    statuses: [201],
  }));
}

/** Categories (and messages) of the changes at `loc` or below it. */
function at(d: ContractDiff, loc: string): { kinds: Kind[]; messages: string[] } {
  const below = (l: string): boolean => l === loc || ['.', '{', '['].some((s) => l.startsWith(`${loc}${s}`));
  const hits = KINDS.flatMap((k) => d[k].filter((c) => below(c.location)).map((c) => ({ k, m: c.message })));
  return { kinds: [...new Set(hits.map((h) => h.k))].sort(), messages: hits.map((h) => h.m) };
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const num = (extra: JsonSchema = {}): JsonSchema => ({ type: 'number', ...extra });
const int = (extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', ...extra });
const str = (extra: JsonSchema = {}): JsonSchema => ({ type: 'string', ...extra });
const arr = (extra: JsonSchema = {}): JsonSchema => ({ type: 'array', items: { type: 'string' }, ...extra });
const obj = (extra: JsonSchema = {}): JsonSchema => ({ type: 'object', properties: { a: { type: 'string' } }, ...extra });
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });

interface Row {
  name: string;
  before: JsonSchema;
  after: JsonSchema;
  /** Expected categories on the request side and on the response side ([] = no change). */
  request: Kind[];
  response: Kind[];
  /** Expected request-side message. */
  message?: string;
}

const ROWS: Row[] = [
  // numeric bounds
  { name: 'minimum added', before: num(), after: num({ minimum: 1 }), request: ['breaking'], response: ['additive'], message: 'minimum added: >= 1' },
  { name: 'minimum removed', before: num({ minimum: 1 }), after: num(), request: ['additive'], response: ['breaking'], message: 'minimum removed (was >= 1)' },
  { name: 'minimum raised', before: num({ minimum: 1 }), after: num({ minimum: 5 }), request: ['breaking'], response: ['additive'], message: 'minimum narrows: >= 1 → >= 5' },
  { name: 'minimum lowered', before: num({ minimum: 5 }), after: num({ minimum: 1 }), request: ['additive'], response: ['breaking'], message: 'minimum widens: >= 5 → >= 1' },
  { name: 'maximum lowered', before: int({ maximum: 1000 }), after: int({ maximum: 10 }), request: ['breaking'], response: ['additive'], message: 'maximum narrows: <= 1000 → <= 10' },
  { name: 'maximum raised', before: int({ maximum: 10 }), after: int({ maximum: 1000 }), request: ['additive'], response: ['breaking'], message: 'maximum widens: <= 10 → <= 1000' },
  { name: 'maximum added', before: num(), after: num({ maximum: 9.5 }), request: ['breaking'], response: ['additive'], message: 'maximum added: <= 9.5' },
  { name: 'maximum removed', before: num({ maximum: 9.5 }), after: num(), request: ['additive'], response: ['breaking'] },
  { name: 'exclusiveMinimum added', before: num(), after: num({ exclusiveMinimum: 0 }), request: ['breaking'], response: ['additive'], message: 'minimum added: > 0' },
  { name: 'minimum 0 → exclusiveMinimum 0 (number)', before: num({ minimum: 0 }), after: num({ exclusiveMinimum: 0 }), request: ['breaking'], response: ['additive'], message: 'minimum narrows: >= 0 → > 0' },
  { name: 'exclusiveMaximum 5 → maximum 5 (number)', before: num({ exclusiveMaximum: 5 }), after: num({ maximum: 5 }), request: ['additive'], response: ['breaking'] },
  { name: 'integer: > 0 is >= 1', before: int({ exclusiveMinimum: 0 }), after: int({ minimum: 1 }), request: [], response: [] },
  { name: 'integer: < 10 is <= 9', before: int({ maximum: 9 }), after: int({ exclusiveMaximum: 10 }), request: [], response: [] },
  { name: 'draft-04 boolean exclusiveMaximum', before: num({ maximum: 10 }), after: num({ maximum: 10, exclusiveMaximum: true }), request: ['breaking'], response: ['additive'], message: 'maximum narrows: <= 10 → < 10' },
  { name: 'safe-integer bounds of int() are not bounds', before: num(), after: int({ minimum: -MAX_SAFE, maximum: MAX_SAFE }), request: ['breaking'], response: ['additive'], message: 'type narrows: number → integer' },
  // lengths and counts
  { name: 'minLength added', before: str(), after: str({ minLength: 1 }), request: ['breaking'], response: ['additive'], message: 'minLength added: 1' },
  { name: 'minLength raised', before: str({ minLength: 1 }), after: str({ minLength: 3 }), request: ['breaking'], response: ['additive'] },
  { name: 'minLength lowered', before: str({ minLength: 3 }), after: str({ minLength: 1 }), request: ['additive'], response: ['breaking'] },
  { name: 'maxLength lowered', before: str({ maxLength: 100 }), after: str({ maxLength: 10 }), request: ['breaking'], response: ['additive'], message: 'maxLength narrows: 100 → 10' },
  { name: 'maxLength raised', before: str({ maxLength: 100 }), after: str({ maxLength: 200 }), request: ['additive'], response: ['breaking'], message: 'maxLength widens: 100 → 200' },
  { name: 'maxLength removed', before: str({ maxLength: 100 }), after: str(), request: ['additive'], response: ['breaking'] },
  { name: 'minItems added', before: arr(), after: arr({ minItems: 1 }), request: ['breaking'], response: ['additive'] },
  { name: 'maxItems lowered', before: arr({ maxItems: 5 }), after: arr({ maxItems: 3 }), request: ['breaking'], response: ['additive'] },
  { name: 'maxItems removed', before: arr({ maxItems: 5 }), after: arr(), request: ['additive'], response: ['breaking'] },
  { name: 'minProperties added', before: obj(), after: obj({ minProperties: 1 }), request: ['breaking'], response: ['additive'] },
  { name: 'maxProperties raised', before: obj({ maxProperties: 1 }), after: obj({ maxProperties: 2 }), request: ['additive'], response: ['breaking'] },
  { name: 'uniqueItems added', before: arr(), after: arr({ uniqueItems: true }), request: ['breaking'], response: ['additive'], message: 'items must now be unique' },
  { name: 'uniqueItems removed', before: arr({ uniqueItems: true }), after: arr(), request: ['additive'], response: ['breaking'] },
  // pattern / format
  { name: 'pattern added', before: str(), after: str({ pattern: '^[a-z]+$' }), request: ['breaking'], response: ['additive'], message: 'pattern added: ^[a-z]+$' },
  { name: 'pattern removed', before: str({ pattern: '^[a-z]+$' }), after: str(), request: ['additive'], response: ['breaking'] },
  { name: 'pattern changed', before: str({ pattern: '^[a-z]+$' }), after: str({ pattern: '^[a-z0-9]+$' }), request: ['breaking'], response: ['breaking'] },
  { name: 'format added', before: str(), after: str({ format: 'email' }), request: ['breaking'], response: ['additive'], message: 'format added: email' },
  { name: 'format removed', before: str({ format: 'date-time' }), after: str(), request: ['additive'], response: ['breaking'], message: 'format removed (was date-time)' },
  { name: 'format changed', before: str({ format: 'email' }), after: str({ format: 'uuid' }), request: ['breaking'], response: ['breaking'] },
  // multipleOf
  { name: 'multipleOf added', before: num(), after: num({ multipleOf: 0.5 }), request: ['breaking'], response: ['additive'] },
  { name: 'multipleOf removed', before: num({ multipleOf: 0.5 }), after: num(), request: ['additive'], response: ['breaking'] },
  { name: 'multipleOf 0.5 → 1 narrows', before: num({ multipleOf: 0.5 }), after: num({ multipleOf: 1 }), request: ['breaking'], response: ['additive'], message: 'multipleOf narrows: 0.5 → 1' },
  { name: 'multipleOf 1 → 0.25 widens', before: num({ multipleOf: 1 }), after: num({ multipleOf: 0.25 }), request: ['additive'], response: ['breaking'] },
  { name: 'multipleOf 2 → 3 is incompatible', before: int({ multipleOf: 2 }), after: int({ multipleOf: 3 }), request: ['breaking'], response: ['breaking'] },
  // constraints of a nullable value
  { name: 'nullable maxLength lowered', before: nullable(str({ maxLength: 10 })), after: nullable(str({ maxLength: 5 })), request: ['breaking'], response: ['additive'] },
  { name: 'value made nullable keeps its bound', before: str({ maxLength: 10 }), after: nullable(str({ maxLength: 10 })), request: ['additive'], response: ['breaking'], message: 'type widens: string → null|string' },
  // undeclared keys
  { name: 'object closed', before: obj(), after: obj({ additionalProperties: false }), request: ['breaking'], response: ['additive'], message: 'undeclared properties are now rejected' },
  { name: 'object opened', before: obj({ additionalProperties: false }), after: obj(), request: ['additive'], response: ['informational'], message: 'undeclared properties are now accepted' },
  { name: 'record value narrowed', before: { type: 'object', additionalProperties: num() }, after: { type: 'object', additionalProperties: int() }, request: ['breaking'], response: ['additive'], message: 'type narrows: number → integer' },
  { name: 'record keys restricted', before: { type: 'object', propertyNames: str(), additionalProperties: num() }, after: { type: 'object', propertyNames: str({ enum: ['a', 'b'] }), additionalProperties: num() }, request: ['breaking'], response: ['additive'] },
  // defaults
  { name: 'default changed', before: str({ default: 'active' }), after: str({ default: 'archived' }), request: ['breaking'], response: ['informational'], message: 'default changes: "active" → "archived" (an omitted value now behaves differently)' },
  { name: 'default added', before: int(), after: int({ default: 20 }), request: ['additive'], response: ['informational'], message: 'default added: 20' },
  { name: 'default removed', before: int({ default: 20 }), after: int(), request: ['breaking'], response: ['informational'] },
  // no change
  { name: 'same constraints, keys in another order', before: str({ minLength: 1, maxLength: 5, pattern: '^a' }), after: { pattern: '^a', maxLength: 5, minLength: 1, type: 'string' }, request: [], response: [] },
];

describe('constraint keywords: request narrowing and response widening are breaking', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const d = diffContracts(withValue(row.before), withValue(row.after));
      const req = at(d, 'POST /v1/things body.v');
      const res = at(d, 'POST /v1/things response.201.v');
      expect(req.kinds, `request: ${JSON.stringify(d)}`).toEqual([...row.request].sort());
      expect(res.kinds, `response: ${JSON.stringify(d)}`).toEqual([...row.response].sort());
      if (row.message !== undefined) expect(req.messages).toContain(row.message);
      // the swap is the mirror image: what narrowed now widens
      const back = diffContracts(withValue(row.after), withValue(row.before));
      expect(at(back, 'POST /v1/things body.v').kinds.length > 0).toBe(row.request.length > 0);
    });
  }

  it('top-level request and response schemas are compared the same way (query, params, headers too)', () => {
    for (const part of ['query', 'params', 'headers', 'body'] as const) {
      const b = contract(ep('GET', '/v1/x', { request: { [part]: { type: 'object', properties: { n: int({ maximum: 100 }) } } } }));
      const a = contract(ep('GET', '/v1/x', { request: { [part]: { type: 'object', properties: { n: int({ maximum: 50 }) } } } }));
      expect(diffContracts(b, a).breaking, part).toEqual([{ location: `GET /v1/x ${part}.n`, message: 'maximum narrows: <= 100 → <= 50' }]);
    }
  });

  it('required-ness both ways, a response enum restriction, and representation-only differences', () => {
    const o = (required: string[], extra: JsonSchema = {}): JsonSchema => ({ type: 'object', properties: { a: str(), b: str() }, required, ...extra });
    const pair = (b: JsonSchema, a: JsonSchema) => diffContracts(
      contract(ep('PUT', '/v1/x', { request: { body: b }, responses: { '200': b } })),
      contract(ep('PUT', '/v1/x', { request: { body: a }, responses: { '200': a } })),
    );
    const loosened = pair(o(['a', 'b']), o(['a']));
    expect(loosened.additive).toEqual([{ location: 'PUT /v1/x body.b', message: 'property becomes optional' }]);
    expect(loosened.breaking).toEqual([{ location: 'PUT /v1/x response.200.b', message: 'property becomes optional' }]);
    const tightened = pair(o(['a']), o(['a', 'b']));
    expect(tightened.breaking).toEqual([{ location: 'PUT /v1/x body.b', message: 'property becomes required' }]);
    expect(tightened.additive).toEqual([{ location: 'PUT /v1/x response.200.b', message: 'property now always present' }]);
    const restricted = diffContracts(withValue(str()), withValue(str({ enum: ['x', 'y'] })));
    expect(restricted.additive).toEqual([{ location: 'POST /v1/things response.201.v', message: 'now restricted to values: "x", "y"' }]);
    // annotations, `additionalProperties: {}` vs absent, and order are representation, not contract
    const same = pair(o(['b', 'a'], { description: 'x', additionalProperties: {} }), o(['a', 'b'], { title: 'y' }));
    expect(same).toEqual({ breaking: [], additive: [], unproven: [], informational: [] });
  });

  it('a JSON Schema difference no rule classifies is unproven, never "no change"', () => {
    const tuple = (n: number): JsonSchema => ({ type: 'array', prefixItems: Array.from({ length: n }, () => str()) });
    const d = diffContracts(withValue(tuple(2)), withValue(tuple(3)));
    expect(d.unproven).toContainEqual({ location: 'POST /v1/things body', message: 'JSON Schema changed in keywords the contract diff does not classify' });
    expect(d.unproven).toContainEqual({ location: 'POST /v1/things response.201', message: 'JSON Schema changed in keywords the contract diff does not classify' });
  });
});

describe('validation JSON Schema cannot show', () => {
  const body: JsonSchema = { type: 'object', properties: { name: str({ minLength: 1 }) }, required: ['name'] };
  const at2 = (src: string, schema: JsonSchema = body): Contract => contract(ep('PATCH', '/v1/x/:id', { request: { body: schema }, sources: { body: src } }));

  it('a source change with an identical JSON Schema (.refine, .superRefine, .transform) is unproven', () => {
    expect(diffContracts(at2('h1'), at2('h2')).unproven).toEqual([{
      location: 'PATCH /v1/x/:id body',
      message: 'schema source changed but its JSON Schema is identical: validation changed in a way the contract cannot see (e.g. .refine, .transform)',
    }]);
  });

  it('identical source is no change; a visible change is classified normally (no extra unproven)', () => {
    expect(diffContracts(at2('h1'), at2('h1'))).toEqual({ breaking: [], additive: [], unproven: [], informational: [] });
    const narrowed: JsonSchema = { type: 'object', properties: { name: str({ minLength: 1, maxLength: 5 }) }, required: ['name'] };
    const d = diffContracts(at2('h1'), at2('h2', narrowed));
    expect(d.breaking).toEqual([{ location: 'PATCH /v1/x/:id body.name', message: 'maxLength added: 5' }]);
    expect(d.unproven).toEqual([]);
  });

  it('request validation that moves out of the handler is unproven (not additive)', () => {
    for (const part of ['params', 'query', 'body', 'headers'] as const) {
      const b = contract(ep('PUT', '/v1/x/:id', { request: { [part]: body } }));
      const a = contract(ep('PUT', '/v1/x/:id'));
      const d = diffContracts(b, a);
      expect(d.additive, part).toEqual([]);
      expect(d.unproven, part).toEqual([{ location: `PUT /v1/x/:id ${part}`, message: 'no longer validated where the harness can see it (moved or removed); the request contract cannot be compared' }]);
    }
  });

  it('a POST/PUT/PATCH body read without an extractable schema on both sides is unproven, never "preserved"', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      for (const side of ['before', 'after', 'both'] as const) {
        const opaque = (s: 'before' | 'after'): Partial<ContractEndpoint> => (side === s || side === 'both' ? { opaque: ['body'] } : {});
        const d = diffContracts(contract(ep(method, '/v1/x', opaque('before'))), contract(ep(method, '/v1/x', opaque('after'))));
        expect(d.unproven, `${method} ${side}`).toEqual([{
          location: `${method} /v1/x body`,
          message: 'request contract not extractable: the body is read without a schema the harness can see (unparsed, in route middleware, or by an unresolved handler)',
        }]);
      }
    }
  });

  it('negative: a body that is never read, a GET/DELETE, or a body with a schema is not flagged', () => {
    const quiet = [
      [ep('POST', '/v1/ping'), ep('POST', '/v1/ping')],
      [ep('GET', '/v1/x', { opaque: ['body'] }), ep('GET', '/v1/x', { opaque: ['body'] })],
      [ep('DELETE', '/v1/x/:id', { opaque: ['body'] }), ep('DELETE', '/v1/x/:id', { opaque: ['body'] })],
      [ep('POST', '/v1/x', { opaque: ['body'], request: { body } }), ep('POST', '/v1/x', { opaque: ['body'], request: { body } })],
      [ep('PATCH', '/v1/x', { opaque: ['query'] }), ep('PATCH', '/v1/x', { opaque: ['query'] })],
    ];
    for (const [b, a] of quiet) {
      if (b === undefined || a === undefined) continue;
      expect(diffContracts(contract(b), contract(a)).unproven, `${b.method} ${JSON.stringify(b.opaque)}`).toEqual([]);
    }
  });
});

describe('non-2xx statuses', () => {
  const st = (method: string, path: string, statuses: number[]): Contract => contract(ep(method, path, { statuses, responses: { '200': null } }));

  it('a new 4xx on an existing endpoint is breaking: it may reject requests that were accepted', () => {
    for (const s of [400, 401, 403, 404, 409, 410, 412, 415, 422, 428, 429]) {
      const d = diffContracts(st('POST', '/v1/x', [200]), st('POST', '/v1/x', [200, s]));
      expect(d.breaking, String(s)).toEqual([{ location: `POST /v1/x response.${s}`, message: `new ${s} response: may reject requests that were accepted` }]);
    }
  });

  it('a removed 4xx/5xx, a new 3xx/5xx are informational; unchanged sets and 2xx codes say nothing here', () => {
    const cases: Array<[number[], number[], string]> = [
      [[200, 404], [200], '404 response no longer produced'],
      [[200, 500], [200], '500 response no longer produced'],
      [[200], [200, 503], 'new 503 response'],
      [[200], [200, 302], 'new 302 response'],
    ];
    for (const [b, a, message] of cases) {
      const d = diffContracts(st('GET', '/v1/x/:id', b), st('GET', '/v1/x/:id', a));
      expect(d.breaking, message).toEqual([]);
      expect(d.informational.map((c) => c.message), message).toEqual([message]);
    }
    expect(diffContracts(st('GET', '/v1/x', [200, 404, 422]), st('GET', '/v1/x', [422, 200, 404]))).toEqual({ breaking: [], additive: [], unproven: [], informational: [] });
    // 2xx codes are compared as responses (removed 2xx stays breaking), not as statuses
    const two = diffContracts(st('POST', '/v1/x', [200]), contract(ep('POST', '/v1/x', { statuses: [201], responses: { '201': null } })));
    expect(two.breaking).toEqual([{ location: 'POST /v1/x response.200', message: '200 response removed' }]);
    expect(two.informational).toEqual([]);
  });

  it('a new route brings its statuses with it (not "new 4xx" on an existing endpoint)', () => {
    const d = diffContracts(st('GET', '/v1/x', [200]), contract(ep('GET', '/v1/x', { statuses: [200], responses: { '200': null } }), ep('DELETE', '/v1/x/:id', { statuses: [204, 404], responses: { '204': null } })));
    expect(d.breaking).toEqual([]);
    expect(d.additive).toEqual([{ location: 'DELETE /v1/x/:id', message: 'new route' }]);
  });
});
