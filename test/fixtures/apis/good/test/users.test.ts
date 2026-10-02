import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('users', () => {
  it('creates and fetches a user', async () => {
    const app = createApp();
    const created = await request(app).post('/v1/users').send({ email: 'a@example.com', name: 'A' });
    expect(created.status).toBe(201);
    const id: unknown = created.body.id;
    expect(typeof id).toBe('string');
    const fetched = await request(app).get(`/v1/users/${String(id)}`);
    expect(fetched.status).toBe(200);
  });

  it('returns a problem for unknown users', async () => {
    const res = await request(createApp()).get('/v1/users/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
