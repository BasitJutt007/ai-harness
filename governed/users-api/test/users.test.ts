import request from 'supertest';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';

type UserResponse = {
  id: string;
  createdAt: string;
  updatedAt: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
};

function expectProblem(res: Response, status: number, slug: string) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(res.body);
  expect(problem.status).toBe(status);
  expect(problem.type).toBe(`https://api.sf/problems/${slug}`);
  return problem;
}

function expectUser(user: unknown): UserResponse {
  expect(user).toEqual({
    id: expect.any(String),
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    email: expect.any(String),
    name: expect.any(String),
    role: expect.stringMatching(/^(admin|member)$/),
  });
  return user as UserResponse;
}

describe('users API', () => {
  it('creates a user with default role member and returns 201 with Location', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-default-role')
      .send({ email: 'alice@example.com', name: 'Alice' });

    expect(res.status).toBe(201);
    const user = expectUser(res.body);
    expect(user.email).toBe('alice@example.com');
    expect(user.name).toBe('Alice');
    expect(user.role).toBe('member');
    expect(res.headers.location).toBe(`/v1/users/${user.id}`);
  });

  it('gets a created user by id', async () => {
    const app = createApp();
    const created = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'get-created-user')
      .send({ email: 'bob@example.com', name: 'Bob', role: 'admin' });

    const user = expectUser(created.body);
    const res = await request(app).get(`/v1/users/${user.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(user);
  });

  it('lists users with cursor pagination that visits every user exactly once', async () => {
    const app = createApp();

    for (let index = 0; index < 5; index += 1) {
      await request(app)
        .post('/v1/users')
        .set('Idempotency-Key', `list-user-${index}`)
        .send({ email: `user${index}@example.com`, name: `User ${index}` });
    }

    const page1 = await request(app).get('/v1/users?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app).get(`/v1/users?limit=2&cursor=${page1.body.nextCursor as string}`);
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.nextCursor).toEqual(expect.any(String));

    const page3 = await request(app).get(`/v1/users?limit=2&cursor=${page2.body.nextCursor as string}`);
    expect(page3.status).toBe(200);
    expect(page3.body.data).toHaveLength(1);
    expect(page3.body.nextCursor).toBeNull();

    const ids = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((user: UserResponse) => user.id);
    expect(new Set(ids)).toHaveLength(5);
  });

  it('returns 404 problem when getting an unknown user id', async () => {
    const res = await request(createApp()).get('/v1/users/00000000-0000-0000-0000-000000000000');

    const problem = expectProblem(res, 404, 'not-found');
    expect(problem.detail).toContain('00000000-0000-0000-0000-000000000000');
  });

  it('returns 404 problem when patching an unknown user id', async () => {
    const res = await request(createApp())
      .patch('/v1/users/00000000-0000-0000-0000-000000000000')
      .set('Idempotency-Key', 'missing-patch')
      .send({ name: 'Nobody' });

    expectProblem(res, 404, 'not-found');
  });

  it('returns 404 problem when deleting an unknown user id', async () => {
    const res = await request(createApp()).delete('/v1/users/00000000-0000-0000-0000-000000000000');

    expectProblem(res, 404, 'not-found');
  });

  it('rejects duplicate emails on create with 409 problem', async () => {
    const app = createApp();
    await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'dup-create-1')
      .send({ email: 'dup@example.com', name: 'First' });

    const res = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'dup-create-2')
      .send({ email: 'dup@example.com', name: 'Second' });

    expectProblem(res, 409, 'conflict');
  });

  it('rejects changing a user email to another users email with 409 problem', async () => {
    const app = createApp();
    const first = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'dup-patch-1')
      .send({ email: 'first@example.com', name: 'First' });
    const second = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'dup-patch-2')
      .send({ email: 'second@example.com', name: 'Second' });

    const secondUser = expectUser(second.body);
    const firstUser = expectUser(first.body);
    const res = await request(app)
      .patch(`/v1/users/${secondUser.id}`)
      .set('Idempotency-Key', 'dup-patch-3')
      .send({ email: firstUser.email });

    expectProblem(res, 409, 'conflict');
  });

  it('returns 422 problem whose detail names each invalid body field', async () => {
    const res = await request(createApp())
      .post('/v1/users')
      .set('Idempotency-Key', 'invalid-body')
      .send({ email: 'not-an-email', name: '', role: 'owner' });

    const problem = expectProblem(res, 422, 'validation');
    expect(problem.detail).toContain('email: ');
    expect(problem.detail).toContain('name: ');
    expect(problem.detail).toContain('role: ');
  });

  it('returns 422 problem for invalid query and path parameters', async () => {
    const app = createApp();

    const queryRes = await request(app).get('/v1/users?limit=101&cursor=%%%');
    const queryProblem = expectProblem(queryRes, 422, 'validation');
    expect(queryProblem.detail).toContain('limit: ');

    const pathRes = await request(app).get('/v1/users/not-a-uuid');
    const pathProblem = expectProblem(pathRes, 422, 'validation');
    expect(pathProblem.detail).toContain('userId: ');
  });

  it('returns 400 problem for malformed JSON body', async () => {
    const res = await request(createApp())
      .post('/v1/users')
      .set('Idempotency-Key', 'malformed-users')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expectProblem(res, 400, 'malformed-json');
  });

  it('replays POST by Idempotency-Key with same body and rejects reuse with different body', async () => {
    const app = createApp();

    const first = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'replay-create')
      .send({ email: 'idem@example.com', name: 'Idem' });
    const replay = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'replay-create')
      .send({ email: 'idem@example.com', name: 'Idem' });
    const changed = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'replay-create')
      .send({ email: 'idem@example.com', name: 'Changed' });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(changed.status).toBe(422);

    const list = await request(app).get('/v1/users');
    expect(list.body.data).toHaveLength(1);
  });

  it('patches only provided fields and rejects an empty patch', async () => {
    const app = createApp();
    const created = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'patch-user-create')
      .send({ email: 'patch@example.com', name: 'Before', role: 'member' });
    const user = expectUser(created.body);

    const updated = await request(app)
      .patch(`/v1/users/${user.id}`)
      .set('Idempotency-Key', 'patch-user-update')
      .send({ name: 'After' });

    expect(updated.status).toBe(200);
    expect(updated.body.email).toBe('patch@example.com');
    expect(updated.body.role).toBe('member');
    expect(updated.body.name).toBe('After');
    expect(Date.parse(updated.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(user.updatedAt));

    const empty = await request(app)
      .patch(`/v1/users/${user.id}`)
      .set('Idempotency-Key', 'patch-user-empty')
      .send({});

    expectProblem(empty, 422, 'validation');
  });

  it('deletes a user with 204 and the user is then gone', async () => {
    const app = createApp();
    const created = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'delete-user-create')
      .send({ email: 'delete@example.com', name: 'Delete Me' });
    const user = expectUser(created.body);

    const del = await request(app).delete(`/v1/users/${user.id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');

    const get = await request(app).get(`/v1/users/${user.id}`);
    expectProblem(get, 404, 'not-found');
  });
});
