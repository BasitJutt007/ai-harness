import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

const body = { email: 'a@example.com', name: 'Alice' };
const create = (app: ReturnType<typeof createApp>, value = body, key?: string) => {
  const req = request(app).post('/v1/users').send(value);
  return key === undefined ? req : req.set('Idempotency-Key', key);
};

describe('users API', () => {
  it('creates, gets, updates and deletes users', async () => {
    const app = createApp();
    const made = await create(app).expect(201);
    expect(made.headers.location).toMatch(/^\/v1\/users\/.+/);
    expect(made.body.role).toBe('member');
    const id = made.body.id as string;
    await request(app).get(`/v1/users/${id}`).expect(200);
    const updated = await request(app).patch(`/v1/users/${id}`).send({ name: 'A' }).expect(200);
    expect(updated.body.name).toBe('A');
    await request(app).delete(`/v1/users/${id}`).expect(204);
    await request(app).get(`/v1/users/${id}`).expect(404).expect('Content-Type', /problem\+json/);
  });
  it('validates inputs and reports malformed JSON', async () => {
    const app = createApp();
    await request(app).post('/v1/users').send({ name: '' }).expect(422).expect('Content-Type', /problem\+json/);
    await request(app).post('/v1/users').set('Content-Type', 'application/json').send('{').expect(400);
    await request(app).get('/v1/users?limit=0').expect(422);
    await request(app).patch('/v1/users/not-uuid').send({ name: 'x' }).expect(422);
    const made = await create(app).expect(201);
    await request(app).patch(`/v1/users/${made.body.id}`).send({}).expect(422);
  });
  it('enforces unique email', async () => {
    const app = createApp();
    await create(app).expect(201);
    await create(app, body).expect(409);
    const other = await create(app, { email: 'b@example.com', name: 'B' }).expect(201);
    await request(app).patch(`/v1/users/${other.body.id}`).send(body).expect(409);
  });
  it('paginates with cursors', async () => {
    const app = createApp();
    await create(app, { email: '1@example.com', name: '1' });
    await create(app, { email: '2@example.com', name: '2' });
    await create(app, { email: '3@example.com', name: '3' });
    const first = await request(app).get('/v1/users?limit=2').expect(200);
    const second = await request(app).get(`/v1/users?limit=2&cursor=${first.body.nextCursor}`).expect(200);
    expect([...first.body.data, ...second.body.data]).toHaveLength(3);
    expect(new Set([...first.body.data, ...second.body.data].map((u) => u.id)).size).toBe(3);
  });
  it('replays idempotent creates and rejects changed reuse', async () => {
    const app = createApp();
    const first = await create(app, body, 'key').expect(201);
    const replay = await create(app, body, 'key').expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    await create(app, { email: 'different@example.com', name: 'D' }, 'key').expect(422);
  });
});
