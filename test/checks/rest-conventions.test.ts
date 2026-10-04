import { afterAll, describe, expect, it } from 'vitest';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import { contextFor, lineOf, lineOfAfter, removeTempApi, runCheck, tempApi } from './_ctx.ts';

const USERS = 'src/routes/users.ts';

describe('rest-conventions', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await removeTempApi(r);
  });

  it('good: 5/5 routes', async () => {
    const findings = await runCheck(restConventions, 'good');
    expect(findings).toEqual([{ rule: 'rest-conventions', file: USERS, status: 'pass', units: { passed: 5, total: 5 }, violations: [] }]);
  });

  it('bad-rest: each convention violation at its route, only the compliant route passes', async () => {
    const findings = await runCheck(restConventions, 'bad-rest');
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f?.status).toBe('fail');
    expect(f?.units).toEqual({ passed: 1, total: 8 });
    const at = (line: number): string => `${USERS}:${line}:`;
    const got = (f?.violations ?? []).map((v) => ({ line: v.location.replace(/:\d+$/, ':'), message: v.message }));
    const expectViolation = (line: number, text: string): void => {
      expect(got.some((g) => g.line === at(line) && g.message.includes(text)), `${line}: ${text}\n${JSON.stringify(got, null, 2)}`).toBe(true);
    };
    expectViolation(lineOf('bad-rest', USERS, "usersRouter.get('/users'"), 'GET /users: path is not versioned');
    expectViolation(lineOf('bad-rest', USERS, 'OffsetQuerySchema.parse(req.query)'), 'GET /v1/users: offset/page pagination');
    expectViolation(lineOf('bad-rest', USERS, 'res.json(UserListSchema.parse('), 'GET /v1/users: collection response must be a page schema');
    expectViolation(lineOfAfter('bad-rest', USERS, "usersRouter.post('/v1/users'", 'res.json('), 'POST /v1/users: creating a resource must respond res.status(201)');
    expectViolation(lineOf('bad-rest', USERS, "usersRouter.get('/v1/user/:userId'"), 'segment "user" is not a plural noun');
    expectViolation(lineOf('bad-rest', USERS, "usersRouter.patch('/v1/users/:userId'"), 'PATCH /v1/users/:userId: no idempotency');
    expectViolation(lineOf('bad-rest', USERS, 'throw badRequest('), 'PUT /v1/users/:userId: literal 400 in a handler');
    expectViolation(lineOfAfter('bad-rest', USERS, "usersRouter.delete('/v1/users/:userId'", 'res.json('), 'DELETE must respond res.status(204).end()');
    expect(got).toHaveLength(8);
  });

  it('a key handed to code the analysis cannot follow is UNPROVEN; a create without Location fails', async () => {
    const root = await tempApi({
      'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
const Headers = z.object({ 'idempotency-key': z.string() });
declare const cache: { run(key: string, work: () => void): void };
export const r = Router();
r.post('/v1/items', (req, res) => {
  const key = Headers.parse(req.headers)['idempotency-key'];
  cache.run(key, () => {
    const body = Item.parse(req.body);
    res.status(201).location(\`/v1/items/\${body.id}\`).json(Item.parse(body));
  });
});
const done = new Map<string, unknown>();
r.post('/v1/notes', (req, res) => {
  const key = Headers.parse(req.headers)['idempotency-key'];
  const hit = done.get(key);
  if (hit !== undefined) {
    res.status(201).json(Item.parse(hit));
    return;
  }
  const body = Item.parse(req.body);
  done.set(key, body);
  res.status(201).json(Item.parse(body));
});
`,
    });
    roots.push(root);
    const findings = await restConventions.run(await contextFor(root));
    const skipped = findings.filter((f) => f.status === 'skip').map((f) => f.skipReason ?? '');
    expect(skipped.some((s) => s.includes('POST /v1/items reads the Idempotency-Key header, but no function of its chain was shown to store a response keyed by it')), skipped.join('\n')).toBe(true);
    const msgs = findings.flatMap((f) => f.violations.map((v) => v.message));
    expect(msgs).toEqual(['POST /v1/notes: creating a resource must set the Location header of the new resource: res.status(201).location(`…/${id}`)']);
  });

  it('no routes → no findings (the runner reports unproven 0/0)', async () => {
    const root = await tempApi({ 'src/app.ts': 'export const nothing = 1;\n' });
    roots.push(root);
    expect(await restConventions.run(await contextFor(root))).toEqual([]);
  });

  it('flags unknown status codes, missing 404 paths; header-based idempotency that stores and replays is accepted', async () => {
    const root = await tempApi(
      {
        'src/routes.ts': `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ id: z.string() });
const Headers = z.object({ 'idempotency-key': z.string().optional() });
const Params = z.object({ itemId: z.string() });
const done = new Map<string, z.infer<typeof Item>>();
export const r = Router();
r.post('/v1/items', (req, res) => {
  const key = Headers.parse(req.headers)['idempotency-key'];
  const hit = key !== undefined ? done.get(key) : undefined;
  if (hit !== undefined) {
    res.status(201).location(\`/v1/items/\${hit.id}\`).json(Item.parse(hit));
    return;
  }
  const body = Item.parse(req.body);
  if (key !== undefined) done.set(key, body);
  res.status(201).location(\`/v1/items/\${body.id}\`).json(Item.parse(body));
});
r.get('/v1/items/:itemId', (req, res) => {
  const { itemId } = Params.parse(req.params);
  res.status(418).json(Item.parse({ id: itemId }));
});
r.get('/v1/order-items', (req, res) => {
  res.json(Item.parse(req.query));
});
`,
      },
    );
    roots.push(root);
    const findings = await restConventions.run(await contextFor(root));
    const msgs = findings.flatMap((f) => f.violations.map((v) => v.message));
    expect(findings[0]?.units).toEqual({ passed: 1, total: 3 });
    expect(msgs.some((m) => m.includes('status 418 is not in the allowed set'))).toBe(true);
    expect(msgs.some((m) => m.includes('GET /v1/items/:itemId: no 404 path'))).toBe(true);
    expect(msgs.some((m) => m.includes('GET /v1/order-items: collection GET must parse req.query with a cursor schema'))).toBe(true);
    expect(msgs.some((m) => m.includes('POST /v1/items'))).toBe(false);
  });
});
