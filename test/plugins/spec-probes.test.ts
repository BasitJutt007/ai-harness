/**
 * spec-probes: expected endpoints and route coverage from task data, values from field specs, and the
 * behavioural scenario against in-process reference APIs generated from several task specs: the
 * correct API passes every unit, each mutant fails exactly the unit of the behaviour it breaks.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { GreenfieldTask } from '../../src/core/plugin-api.ts';
import {
  coverRoutes,
  expectedEndpoints,
  httpClient,
  invalidValues,
  pathShape,
  referenceOf,
  runScenario,
  valueFor,
} from '../../plugins/lib/spec-probes.ts';
import type { SpecUnit } from '../../plugins/lib/spec-probes.ts';
import { field, listen, refApp, res, task, TEAMS, USERS } from './spec-ref-api.ts';
import type { Mutant } from './spec-ref-api.ts';

/** Several specs: field types and constraints, 1-3 resources, subsets of operations. */
const SPECS: Array<{ name: string; task: GreenfieldTask }> = [
  { name: 'users (email unique, string min/max, enum default)', task: task([USERS]) },
  {
    name: 'products: decimal/integer bounds, boolean, date; create/get/list only, basePath /api/v2',
    task: task([res('product', 'products', [
      field({ name: 'sku', type: 'string', required: true, unique: true, max: 20 }),
      field({ name: 'price', type: 'decimal', required: true, min: 0, max: 10_000 }),
      field({ name: 'stock', type: 'integer', min: 0, max: 1_000_000 }),
      field({ name: 'active', type: 'boolean' }),
      field({ name: 'launchedOn', type: 'date' }),
    ], ['create', 'get', 'list'])], { basePath: '/api/v2' }),
  },
  {
    name: 'authors + books (uuid reference, datetime, integer range) + tags (list/create/delete)',
    task: task([
      res('author', 'authors', [field({ name: 'name', type: 'string', required: true, max: 80 })]),
      res('book', 'books', [
        field({ name: 'title', type: 'string', required: true, min: 2, max: 200 }),
        field({ name: 'authorId', type: 'uuid', required: true }),
        field({ name: 'publishedAt', type: 'datetime' }),
        field({ name: 'pages', type: 'integer', required: true, min: 1, max: 5000 }),
        field({ name: 'format', type: 'enum', values: ['paper', 'ebook'], required: true }),
      ]),
      res('tag', 'tags', [field({ name: 'label', type: 'string', required: true, unique: true, max: 30 })], ['list', 'create', 'delete']),
    ]),
  },
];

const servers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(servers.map((c) => c()));
});

async function scenario(t: GreenfieldTask, mutants: Mutant[] = []): Promise<SpecUnit[]> {
  const s = await listen(refApp(t.resources, t.basePath, mutants));
  servers.push(s.close);
  const log: string[] = [];
  return (await runScenario(httpClient(s.base, log), t)).units;
}

const bad = (units: SpecUnit[]): string[] => units.filter((u) => u.status !== 'pass').map((u) => `${u.status} ${u.resource} ${u.name}: ${u.detail}`);
const failing = (units: SpecUnit[]): string[] => units.filter((u) => u.status === 'fail').map((u) => `${u.resource} ${u.name}`);

describe('expected endpoints and route coverage', () => {
  it('derives resources × operations under the base path (update accepts PATCH or PUT)', () => {
    const e = expectedEndpoints(task([USERS, res('team', 'teams', [], ['list', 'create'])]));
    expect(e.map((x) => `${x.methods.join('|')} ${x.paths.join(',')}`)).toEqual([
      'GET /v1/users', 'GET /v1/users/:id', 'POST /v1/users', 'PATCH|PUT /v1/users/:id', 'DELETE /v1/users/:id', 'GET /v1/teams', 'POST /v1/teams',
    ]);
    expect(expectedEndpoints(task([TEAMS], { basePath: '/' }))[0]?.paths).toEqual(['/teams']);
  });

  it('accepts the paths the task itself declares (Endpoint: lines) next to <base>/<plural>', () => {
    const t = task([res('team', 'teams', [], ['list', 'get'])], { behaviours: ['Endpoint: GET /api/teams', 'Endpoint: GET /api/teams/{teamId} - one team', 'Endpoint: GET /api/users/{id}/teams'] });
    expect(expectedEndpoints(t).map((x) => x.paths)).toEqual([['/api/teams', '/v1/teams'], ['/api/teams/{teamId}', '/v1/teams/:id']]);
  });

  it('matches by method and path shape; a missing endpoint fails with its exact label', () => {
    expect(pathShape('/V1/Users/{userId}/')).toBe(pathShape('/v1/users/:id'));
    const e = expectedEndpoints(task([USERS, TEAMS]));
    const routes = [
      { method: 'get', path: '/v1/users', at: 'a:1' }, { method: 'post', path: '/v1/users', at: 'a:2' }, { method: 'get', path: '/v1/users/:userId', at: 'a:3' },
      { method: 'put', path: '/v1/users/:userId', at: 'a:4' }, { method: 'delete', path: '/v1/users/:userId', at: 'a:5' },
    ];
    const units = coverRoutes(e, { routes, unresolved: 0 }, new Map(), undefined);
    expect(failing(units)).toEqual(['team route GET /v1/teams', 'team route GET /v1/teams/:id', 'team route POST /v1/teams', 'team route PATCH|PUT /v1/teams/:id', 'team route DELETE /v1/teams/:id']);
    expect(units.find((u) => u.name === 'route PATCH|PUT /v1/users/:id')?.detail).toContain('PUT /v1/users/:userId');
    // runtime evidence (statuses the harness received) decides what static extraction cannot
    const ev = new Map([['team|list', [200]], ['team|create', [404]]]);
    const mixed = coverRoutes(e, { routes, unresolved: 2 }, ev, undefined);
    expect(mixed.find((u) => u.name === 'route GET /v1/teams')?.status).toBe('pass');
    expect(mixed.find((u) => u.name === 'route POST /v1/teams')?.status).toBe('fail');
    expect(mixed.find((u) => u.name === 'route DELETE /v1/teams/:id')?.status).toBe('unproven');
  });
});

describe('values from field specs', () => {
  it('valid values respect type, bounds and uniqueness', () => {
    const name = field({ name: 'n', type: 'string', min: 3, max: 5 });
    for (let n = 1; n < 30; n++) {
      const v = valueFor(name, n, 'abc');
      expect(typeof v === 'string' && v.length >= 3 && v.length <= 5).toBe(true);
    }
    expect(valueFor(field({ name: 'e', type: 'email', max: 20 }), 7, 'abc')).toMatch(/^[^@]{1,8}@example\.com$/);
    expect(valueFor(field({ name: 'e', type: 'email' }), 1, 'a')).not.toBe(valueFor(field({ name: 'e', type: 'email' }), 2, 'a'));
    expect(valueFor(field({ name: 'r', type: 'enum', values: ['a', 'b'], default: 'b' }), 1, 'x')).toBe('b');
    const i = valueFor(field({ name: 'i', type: 'integer', min: 10, max: 12 }), 5, 'x');
    expect(Number.isInteger(i) && Number(i) >= 10 && Number(i) <= 12).toBe(true);
    expect(valueFor(field({ name: 'd', type: 'date' }), 1, 'x')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(valueFor(field({ name: 'u', type: 'unknown', rawType: 'url' }), 1, 'x')).toMatch(/^https:\/\//);
    expect(valueFor(field({ name: 'u', type: 'unknown', rawType: 'geometry' }), 1, 'x')).toBeUndefined();
  });

  it('invalid values break exactly one constraint', () => {
    expect(invalidValues(field({ name: 'n', type: 'string', min: 1, max: 3 })).map((x) => [x.rule, x.value])).toEqual([['max', 'xxxx'], ['min', '']]);
    expect(invalidValues(field({ name: 'q', type: 'integer', min: 0, max: 9 })).map((x) => x.value)).toEqual([10, -1]);
    expect(invalidValues(field({ name: 'r', type: 'enum', values: ['a'] }))[0]?.rule).toBe('enum');
  });

  it('a uuid field named <resource>Id refers to that resource', () => {
    const rs = [res('order-item', 'order-items', []), USERS];
    expect(referenceOf(field({ name: 'orderItemId', type: 'uuid' }), rs)?.name).toBe('order-item');
    expect(referenceOf(field({ name: 'user_id', type: 'uuid' }), rs)?.name).toBe('user');
    expect(referenceOf(field({ name: 'ownerId', type: 'uuid' }), rs)).toBeUndefined();
  });
});

describe('behavioural scenario against generated reference APIs', () => {
  it.each(SPECS)('$name: the correct API passes every unit', async ({ task: t }) => {
    const units = await scenario(t);
    expect(bad(units)).toEqual([]);
    const names = new Set(units.map((u) => `${u.resource} ${u.name}`));
    for (const r of t.resources) {
      for (const op of r.operations) expect(names.has(`${r.name} ${op}`), `${r.name} ${op}`).toBe(true);
      // probes only for requested operations
      for (const op of ['get', 'update', 'delete'] as const) if (!r.operations.includes(op)) expect(names.has(`${r.name} ${op}`)).toBe(false);
    }
  }, 60_000);

  const MUTANTS: Array<{ mutant: Mutant; spec: number; fails: string[] }> = [
    { mutant: 'no-validation', spec: 0, fails: ['user required email', 'user required name', 'user enum role', 'user max name', 'user min name'] },
    { mutant: 'unique-not-enforced', spec: 0, fails: ['user unique email'] },
    { mutant: 'delete-200', spec: 0, fails: ['user delete'] },
    { mutant: 'patch-replaces', spec: 0, fails: ['user update'] },
    { mutant: 'no-idempotency', spec: 0, fails: ['user idempotency'] },
    { mutant: 'no-validation', spec: 1, fails: ['product required sku', 'product required price', 'product max sku', 'product max price', 'product min price', 'product max stock', 'product min stock'] },
    { mutant: 'unique-not-enforced', spec: 1, fails: ['product unique sku'] },
    { mutant: 'list-ignores-new', spec: 1, fails: ['product list'] },
    { mutant: 'no-echo', spec: 1, fails: ['product create'] },
    { mutant: 'no-idempotency', spec: 2, fails: ['author idempotency', 'book idempotency', 'tag idempotency'] },
    { mutant: 'unique-not-enforced', spec: 2, fails: ['tag unique label'] },
    { mutant: 'delete-200', spec: 2, fails: ['author delete', 'book delete', 'tag delete'] },
  ];
  it.each(MUTANTS)('mutant $mutant on spec $spec fails exactly $fails', async ({ mutant, spec, fails }) => {
    const t = SPECS[spec]?.task;
    if (t === undefined) throw new Error('no spec');
    const units = await scenario(t, [mutant]);
    expect(failing(units).sort()).toEqual([...fails].sort());
  }, 60_000);

  it('an API that answers 401 to everything leaves every unit UNPROVEN, never pass', async () => {
    const units = await scenario(task([USERS]), ['auth-everything']);
    expect(units.length).toBeGreaterThan(5);
    expect(units.filter((u) => u.status !== 'unproven')).toEqual([]);
    expect(units[0]?.detail).toContain('401');
  });

  it('pagination is followed to find the created instance', async () => {
    // the reference list pages hold 2 items: with 5 seeded first, the created note is on page 3
    const t = task([res('note', 'notes', [field({ name: 'text', type: 'string', required: true })], ['list', 'create'])]);
    const s = await listen(refApp(t.resources, '/v1'));
    servers.push(s.close);
    for (let i = 0; i < 5; i++) await fetch(`${s.base}/v1/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `seed${i}` }) });
    const log: string[] = [];
    const units = (await runScenario(httpClient(s.base, log), t)).units;
    expect(bad(units)).toEqual([]);
    expect(units.find((u) => u.name === 'list')?.detail).toMatch(/page [2-9]/);
  });
});
