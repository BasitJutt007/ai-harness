import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';

const app = createApp();

/** The public contract, restated independently of the implementation. */
const UserBody = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const PageBody = z.strictObject({ data: z.array(UserBody), nextCursor: z.string().nullable() });

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

const uniqueEmail = (): string => `user-${randomUUID()}@example.com`;

function expectProblem(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(res.body);
  expect(problem.status).toBe(status);
  return problem;
}

async function createUser(body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/v1/users')
    .send({ email: uniqueEmail(), name: 'Ada Lovelace', ...body });
  expect(res.status).toBe(201);
  return UserBody.parse(res.body);
}

describe('POST /v1/users', () => {
  it('creates a user: 201, Location header, role defaults to member', async () => {
    const email = uniqueEmail();
    const res = await request(app).post('/v1/users').send({ email, name: 'Grace Hopper' });
    expect(res.status).toBe(201);
    const user = UserBody.parse(res.body);
    expect(res.headers['location']).toBe(`/v1/users/${user.id}`);
    expect(user).toMatchObject({ email, name: 'Grace Hopper', role: 'member' });
  });

  it('accepts an explicit role', async () => {
    expect((await createUser({ role: 'admin' })).role).toBe('admin');
  });

  it('returns 409 when the email already exists', async () => {
    const user = await createUser();
    const problem = expectProblem(await request(app).post('/v1/users').send({ email: user.email, name: 'Copy' }), 409);
    expect(problem.detail).toContain(user.email);
  });

  it.each([
    ['missing email', { name: 'No Email' }],
    ['invalid email', { email: 'not-an-email', name: 'Bad Email' }],
    ['empty name', { email: 'empty-name@example.com', name: '' }],
    ['name over 100 characters', { email: 'long-name@example.com', name: 'x'.repeat(101) }],
    ['unknown role', { email: 'bad-role@example.com', name: 'Role', role: 'owner' }],
    ['unknown property', { email: 'extra@example.com', name: 'Extra', admin: true }],
  ])('rejects an invalid body (%s) with a 422 problem', async (_label, body) => {
    expectProblem(await request(app).post('/v1/users').send(body), 422);
  });

  it('rejects malformed JSON with a 400 problem', async () => {
    expectProblem(await request(app).post('/v1/users').set('Content-Type', 'application/json').send('{"email":'), 400);
  });

  it('honours Idempotency-Key: same key and body replays the first response', async () => {
    const key = randomUUID();
    const body = { email: uniqueEmail(), name: 'Idempotent' };
    const first = await request(app).post('/v1/users').set('Idempotency-Key', key).send(body);
    const second = await request(app).post('/v1/users').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(UserBody.parse(second.body)).toEqual(UserBody.parse(first.body));
  });

  it('rejects reuse of an Idempotency-Key with a different body (422)', async () => {
    const key = randomUUID();
    await request(app).post('/v1/users').set('Idempotency-Key', key).send({ email: uniqueEmail(), name: 'One' }).expect(201);
    expectProblem(await request(app).post('/v1/users').set('Idempotency-Key', key).send({ email: uniqueEmail(), name: 'Two' }), 422);
  });
});

describe('GET /v1/users', () => {
  it('is cursor-paginated: following nextCursor visits every user once', async () => {
    const created = [await createUser(), await createUser(), await createUser()];
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(app)
        .get('/v1/users')
        .query(cursor === null ? { limit: '2' } : { limit: '2', cursor });
      expect(res.status).toBe(200);
      const page = PageBody.parse(res.body);
      expect(page.data.length).toBeLessThanOrEqual(2);
      ids.push(...page.data.map((u) => u.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(new Set(ids).size).toBe(ids.length);
    for (const user of created) expect(ids).toContain(user.id);
  });

  it('defaults limit to 20', async () => {
    for (let i = 0; i < 21; i += 1) await createUser();
    const page = PageBody.parse((await request(app).get('/v1/users')).body);
    expect(page.data).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
  });

  it('allows limit up to 100 and rejects anything outside 1..100 with a 422 problem', async () => {
    expect((await request(app).get('/v1/users').query({ limit: '100' })).status).toBe(200);
    expectProblem(await request(app).get('/v1/users').query({ limit: '101' }), 422);
    expectProblem(await request(app).get('/v1/users').query({ limit: '0' }), 422);
  });

  it('rejects a cursor it did not issue with a 422 problem', async () => {
    expectProblem(await request(app).get('/v1/users').query({ cursor: 'garbage' }), 422);
  });
});

describe('GET /v1/users/:userId', () => {
  it('returns the user', async () => {
    const user = await createUser();
    const res = await request(app).get(`/v1/users/${user.id}`);
    expect(res.status).toBe(200);
    expect(UserBody.parse(res.body)).toEqual(user);
  });

  it('answers an unknown id with a 404 problem', async () => {
    const problem = expectProblem(await request(app).get(`/v1/users/${UNKNOWN_ID}`), 404);
    expect(problem.instance).toBe(`/v1/users/${UNKNOWN_ID}`);
  });

  it('answers a malformed id with a 422 problem', async () => {
    expectProblem(await request(app).get('/v1/users/not-a-uuid'), 422);
  });
});

describe('PATCH /v1/users/:userId', () => {
  it('updates only the given fields', async () => {
    const user = await createUser();
    const res = await request(app).patch(`/v1/users/${user.id}`).send({ role: 'admin' });
    expect(res.status).toBe(200);
    const updated = UserBody.parse(res.body);
    expect(updated).toMatchObject({ id: user.id, email: user.email, name: user.name, role: 'admin' });
    expect(updated.createdAt).toBe(user.createdAt);
  });

  it('returns 409 when changing the email to one that already exists', async () => {
    const [a, b] = [await createUser(), await createUser()];
    expectProblem(await request(app).patch(`/v1/users/${b.id}`).send({ email: a.email }), 409);
  });

  it('allows keeping the same email', async () => {
    const user = await createUser();
    expect((await request(app).patch(`/v1/users/${user.id}`).send({ email: user.email, name: 'Renamed' })).status).toBe(200);
  });

  it('rejects an empty or invalid patch with a 422 problem', async () => {
    const user = await createUser();
    expectProblem(await request(app).patch(`/v1/users/${user.id}`).send({}), 422);
    expectProblem(await request(app).patch(`/v1/users/${user.id}`).send({ role: 'root' }), 422);
  });

  it('answers an unknown id with a 404 problem', async () => {
    expectProblem(await request(app).patch(`/v1/users/${UNKNOWN_ID}`).send({ name: 'Nobody' }), 404);
  });
});

describe('DELETE /v1/users/:userId', () => {
  it('deletes the user: 204 with no body, then 404', async () => {
    const user = await createUser();
    const res = await request(app).delete(`/v1/users/${user.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expectProblem(await request(app).get(`/v1/users/${user.id}`), 404);
    expectProblem(await request(app).delete(`/v1/users/${user.id}`), 404);
  });

  it('frees the email for reuse', async () => {
    const user = await createUser();
    await request(app).delete(`/v1/users/${user.id}`).expect(204);
    expect((await createUser({ email: user.email })).email).toBe(user.email);
  });

  it('answers an unknown id with a 404 problem', async () => {
    expectProblem(await request(app).delete(`/v1/users/${UNKNOWN_ID}`), 404);
  });
});
