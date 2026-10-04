import request from 'supertest';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';

type User = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
  updatedAt: string;
};

function expectProblem(res: Response, status: number, slug: string) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(res.body);
  expect(problem.status).toBe(status);
  expect(problem.type).toBe(`https://api.sf/problems/${slug}`);
  return problem;
}

function expectUser(value: unknown): User {
  return {
    id: expect.any(String) as unknown as string,
    email: expect.any(String) as unknown as string,
    name: expect.any(String) as unknown as string,
    role: expect.stringMatching(/^(admin|member)$/) as unknown as 'admin' | 'member',
    createdAt: expect.any(String) as unknown as string,
    updatedAt: expect.any(String) as unknown as string,
    ...(value as Record<string, unknown>),
  } as User;
}

describe('users API', () => {
  it('creates a user, defaults role to member, returns 201 and Location, and can fetch it', async () => {
    const app = createApp();

    const createRes = await request(app).post('/v1/users').send({ email: 'ada@example.com', name: 'Ada' });
    expect(createRes.status).toBe(201);
    expect(createRes.headers.location).toMatch(/^\/v1\/users\//);
    expect(createRes.body).toEqual(expect.objectContaining(expectUser({ email: 'ada@example.com', name: 'Ada', role: 'member' })));

    const location = createRes.headers.location;
    expect(typeof location).toBe('string');

    if (typeof location !== 'string') {
      throw new Error('Expected location header to be present.');
    }

    const getRes = await request(app).get(location);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(createRes.body);
  });

  it('lists users with cursor pagination and visiting nextCursor returns each user exactly once', async () => {
    const app = createApp();
    const createdIds: string[] = [];

    for (const i of [0, 1, 2, 3, 4]) {
      const res = await request(app)
        .post('/v1/users')
        .send({ email: `user${i}@example.com`, name: `User ${i}` });
      expect(res.status).toBe(201);
      createdIds.push(String(res.body.id));
    }

    const seenIds: string[] = [];
    let cursor: string | null = null;

    do {
      const res = await request(app).get('/v1/users').query(cursor === null ? { limit: 2 } : { limit: 2, cursor });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      for (const user of res.body.data as User[]) {
        seenIds.push(user.id);
      }
      expect(typeof res.body.nextCursor === 'string' || res.body.nextCursor === null).toBe(true);
      cursor = res.body.nextCursor;
    } while (cursor !== null);

    expect(new Set(seenIds).size).toBe(createdIds.length);
    expect(seenIds).toHaveLength(createdIds.length);
    expect(new Set(seenIds)).toEqual(new Set(createdIds));
  });

  it('returns 404 problems for missing users on get patch and delete', async () => {
    const app = createApp();
    const missingId = '00000000-0000-4000-8000-000000000000';

    const getRes = await request(app).get(`/v1/users/${missingId}`);
    expectProblem(getRes, 404, 'not-found');

    const patchRes = await request(app).patch(`/v1/users/${missingId}`).send({ name: 'Nobody' });
    expectProblem(patchRes, 404, 'not-found');

    const deleteRes = await request(app).delete(`/v1/users/${missingId}`);
    expectProblem(deleteRes, 404, 'not-found');
  });

  it('returns 422 problems naming failing fields for invalid body query and path parameters', async () => {
    const app = createApp();

    const bodyRes = await request(app).post('/v1/users').send({ email: 'nope', name: '' });
    const bodyProblem = expectProblem(bodyRes, 422, 'validation');
    expect(bodyProblem.detail).toContain('email: ');
    expect(bodyProblem.detail).toContain('name: ');

    const queryRes = await request(app).get('/v1/users').query({ limit: 101, cursor: '' });
    const queryProblem = expectProblem(queryRes, 422, 'validation');
    expect(queryProblem.detail).toContain('limit: ');
    expect(queryProblem.detail).toContain('cursor: ');

    const pathRes = await request(app).get('/v1/users/not-a-uuid');
    const pathProblem = expectProblem(pathRes, 422, 'validation');
    expect(pathProblem.detail).toContain('userId: ');
  });

  it('returns 400 for malformed JSON bodies', async () => {
    const res = await request(createApp())
      .post('/v1/users')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expectProblem(res, 400, 'malformed-json');
  });

  it('rejects duplicate emails on create and patch with 409 problems', async () => {
    const app = createApp();

    const first = await request(app).post('/v1/users').send({ email: 'dup@example.com', name: 'First' });
    const second = await request(app).post('/v1/users').send({ email: 'other@example.com', name: 'Second' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const createDup = await request(app).post('/v1/users').send({ email: 'dup@example.com', name: 'Third' });
    expectProblem(createDup, 409, 'conflict');

    const patchDup = await request(app).patch(`/v1/users/${second.body.id}`).send({ email: 'dup@example.com' });
    expectProblem(patchDup, 409, 'conflict');
  });

  it('honours Idempotency-Key on create: same key and body replays original response, different body gets 422', async () => {
    const app = createApp();
    const key = 'create-user-1';

    const first = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', key)
      .send({ email: 'idem@example.com', name: 'Ida' });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const replay = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', key)
      .send({ email: 'idem@example.com', name: 'Ida' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.body).toEqual(first.body);

    const listRes = await request(app).get('/v1/users');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    const mismatch = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', key)
      .send({ email: 'idem@example.com', name: 'Different' });
    expectProblem(mismatch, 422, 'idempotency-key-reuse');
  });

  it('patches only provided fields, returns the updated user, and rejects an empty patch', async () => {
    const app = createApp();

    const created = await request(app).post('/v1/users').send({ email: 'patch@example.com', name: 'Before', role: 'member' });
    expect(created.status).toBe(201);

    const updated = await request(app).patch(`/v1/users/${created.body.id}`).send({ name: 'After', role: 'admin' });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual(
      expect.objectContaining({
        id: created.body.id,
        email: 'patch@example.com',
        name: 'After',
        role: 'admin',
        createdAt: created.body.createdAt,
        updatedAt: expect.any(String),
      }),
    );
    expect(Date.parse(String(updated.body.updatedAt))).toBeGreaterThanOrEqual(Date.parse(String(created.body.updatedAt)));

    const fetched = await request(app).get(`/v1/users/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(updated.body);

    const emptyPatch = await request(app).patch(`/v1/users/${created.body.id}`).send({});
    const problem = expectProblem(emptyPatch, 422, 'validation');
    expect(problem.detail).toContain('(root): ');
  });

  it('deletes a user with 204 and the user is then gone', async () => {
    const app = createApp();
    const created = await request(app).post('/v1/users').send({ email: 'delete@example.com', name: 'Delete Me' });
    expect(created.status).toBe(201);

    const deleted = await request(app).delete(`/v1/users/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');

    const getRes = await request(app).get(`/v1/users/${created.body.id}`);
    expectProblem(getRes, 404, 'not-found');
  });
});
