import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

const body = { email: 'a@example.com', name: 'Alice' };
const problem = (r: request.Response, status: number): void => {
  expect(r.status).toBe(status);
  expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(r.body).toMatchObject({ status, type: expect.any(String), title: expect.any(String), detail: expect.any(String), instance: expect.any(String) });
};

describe('users API', () => {
  it('creates, gets, updates and deletes a user', async () => {
    const app = createApp();
    const created = await request(app).post('/v1/users').send(body);
    expect(created.status).toBe(201); expect(created.headers.location).toMatch(/^\/v1\/users\//); expect(created.body.role).toBe('member');
    expect(created.body).toMatchObject(body);
    const id = created.body.id as string;
    expect((await request(app).get(`/v1/users/${id}`)).status).toBe(200);
    const patched = await request(app).patch(`/v1/users/${id}`).send({ name: 'A' });
    expect(patched.status).toBe(200); expect(patched.body.name).toBe('A'); expect(patched.body.email).toBe(body.email);
    expect((await request(app).delete(`/v1/users/${id}`)).status).toBe(204);
    expect((await request(app).get(`/v1/users/${id}`)).status).toBe(404);
  });
  it('validates and reports duplicates and missing ids', async () => {
    const app = createApp(); await request(app).post('/v1/users').send(body);
    problem(await request(app).post('/v1/users').send(body), 409);
    problem(await request(app).post('/v1/users').send({ email: 'bad', name: '' }), 422);
    problem(await request(app).patch('/v1/users/nope').send({ name: 'x' }), 422);
    problem(await request(app).get('/v1/users/00000000-0000-4000-8000-000000000000'), 404);
    problem(await request(app).delete('/v1/users/00000000-0000-4000-8000-000000000000'), 404);
    problem(await request(app).patch('/v1/users/00000000-0000-4000-8000-000000000000').send({ name: 'x' }), 404);
    problem(await request(app).patch('/v1/users/00000000-0000-4000-8000-000000000000').send({}), 404);
    problem(await request(app).post('/v1/users').set('Content-Type','application/json').send('{'), 400);
  });
  it('paginates and supports idempotency', async () => {
    const app = createApp(); const key = 'k1';
    const first = await request(app).post('/v1/users').set('Idempotency-Key', key).send(body);
    const replay = await request(app).post('/v1/users').set('Idempotency-Key', key).send(body);
    expect(replay.status).toBe(201); expect(replay.headers['idempotent-replayed']).toBe('true'); expect(replay.body.id).toBe(first.body.id);
    problem(await request(app).post('/v1/users').set('Idempotency-Key', key).send({ ...body, name: 'Other' }), 422);
    for (let i=0;i<2;i++) await request(app).post('/v1/users').send({ email: `${i}@example.com`, name: `N${i}` });
    const page = await request(app).get('/v1/users?limit=2'); expect(page.status).toBe(200); expect(page.body.data).toHaveLength(2); expect(page.body.nextCursor).not.toBeNull();
    const next = await request(app).get(`/v1/users?limit=2&cursor=${page.body.nextCursor}`); expect(next.status).toBe(200); expect(next.body.data).toHaveLength(1);
    problem(await request(app).patch(`/v1/users/${first.body.id}`).send({}), 422);
  });
});

import { usersRouter } from '../src/routes/users.ts';
it('exports users router', () => { expect(usersRouter).toBeTypeOf('function'); });
