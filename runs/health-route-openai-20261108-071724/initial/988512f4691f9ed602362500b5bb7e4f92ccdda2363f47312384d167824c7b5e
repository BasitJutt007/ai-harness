import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';

const app = createApp();

/** The public contract, restated independently of the implementation. */
const ProjectBody = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().optional(),
  status: z.enum(['active', 'archived']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const PageBody = z.strictObject({ data: z.array(ProjectBody), nextCursor: z.string().nullable() });

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

function expectProblem(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(res.body);
  expect(problem.status).toBe(status);
  return problem;
}

async function createProject(body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/v1/projects')
    .send({ name: `project ${randomUUID()}`, ...body });
  expect(res.status).toBe(201);
  return ProjectBody.parse(res.body);
}

async function listAll(query: Record<string, string>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await request(app)
      .get('/v1/projects')
      .query(cursor === null ? query : { ...query, cursor });
    expect(res.status).toBe(200);
    const page = PageBody.parse(res.body);
    ids.push(...page.data.map((p) => p.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

describe('POST /v1/projects', () => {
  it('creates a project: 201, Location header, status defaults to active', async () => {
    const res = await request(app).post('/v1/projects').send({ name: 'Apollo', description: 'moon' });
    expect(res.status).toBe(201);
    const project = ProjectBody.parse(res.body);
    expect(res.headers['location']).toBe(`/v1/projects/${project.id}`);
    expect(project).toMatchObject({ name: 'Apollo', description: 'moon', status: 'active' });
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it('rejects an invalid body with a 422 problem', async () => {
    const problem = expectProblem(await request(app).post('/v1/projects').send({ name: '', status: 'deleted' }), 422);
    expect(problem.detail).toContain('name');
    expect(problem.detail).toContain('status');
  });

  it('rejects unknown properties with a 422 problem', async () => {
    expectProblem(await request(app).post('/v1/projects').send({ name: 'x', owner: 'me' }), 422);
  });

  it('rejects malformed JSON with a 400 problem', async () => {
    expectProblem(await request(app).post('/v1/projects').set('Content-Type', 'application/json').send('{"name"'), 400);
  });

  it('honours Idempotency-Key: same key and body replays the first response', async () => {
    const key = randomUUID();
    const body = { name: `idem ${key}` };
    const first = await request(app).post('/v1/projects').set('Idempotency-Key', key).send(body);
    const second = await request(app).post('/v1/projects').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(ProjectBody.parse(second.body).id).toBe(ProjectBody.parse(first.body).id);
    const all = await listAll({ limit: '100' });
    expect(all.filter((id) => id === ProjectBody.parse(first.body).id)).toHaveLength(1);
  });

  it('rejects reuse of an Idempotency-Key with a different body (422)', async () => {
    const key = randomUUID();
    await request(app).post('/v1/projects').set('Idempotency-Key', key).send({ name: 'one' }).expect(201);
    expectProblem(await request(app).post('/v1/projects').set('Idempotency-Key', key).send({ name: 'two' }), 422);
  });
});

describe('GET /v1/projects', () => {
  it('pages through every project with an opaque cursor', async () => {
    const created = [await createProject(), await createProject(), await createProject()];
    const ids = await listAll({ limit: '2' });
    expect(new Set(ids).size).toBe(ids.length);
    for (const project of created) expect(ids).toContain(project.id);
  });

  it('returns at most `limit` items and a nextCursor while more remain', async () => {
    await createProject();
    await createProject();
    const res = await request(app).get('/v1/projects').query({ limit: '1' });
    const page = PageBody.parse(res.body);
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it('defaults to 20 items per page', async () => {
    for (let i = 0; i < 21; i += 1) await createProject();
    const page = PageBody.parse((await request(app).get('/v1/projects')).body);
    expect(page.data).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
  });

  it('rejects limit outside 1..100 and foreign cursors with a 422 problem', async () => {
    expectProblem(await request(app).get('/v1/projects').query({ limit: '0' }), 422);
    expectProblem(await request(app).get('/v1/projects').query({ limit: '101' }), 422);
    expectProblem(await request(app).get('/v1/projects').query({ cursor: 'nope' }), 422);
  });
});

describe('GET /v1/projects/:projectId', () => {
  it('returns the project', async () => {
    const project = await createProject({ description: 'details' });
    const res = await request(app).get(`/v1/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(ProjectBody.parse(res.body)).toEqual(project);
  });

  it('answers an unknown id with a 404 problem', async () => {
    const problem = expectProblem(await request(app).get(`/v1/projects/${UNKNOWN_ID}`), 404);
    expect(problem.instance).toBe(`/v1/projects/${UNKNOWN_ID}`);
  });

  it('answers a malformed id with a 422 problem', async () => {
    expectProblem(await request(app).get('/v1/projects/not-a-uuid'), 422);
  });
});

describe('PATCH /v1/projects/:projectId', () => {
  it('updates the given fields only', async () => {
    const project = await createProject({ description: 'keep me' });
    const res = await request(app).patch(`/v1/projects/${project.id}`).send({ status: 'archived' });
    expect(res.status).toBe(200);
    const updated = ProjectBody.parse(res.body);
    expect(updated).toMatchObject({ id: project.id, name: project.name, description: 'keep me', status: 'archived' });
    expect(updated.createdAt).toBe(project.createdAt);
  });

  it('rejects an empty or invalid patch with a 422 problem', async () => {
    const project = await createProject();
    expectProblem(await request(app).patch(`/v1/projects/${project.id}`).send({}), 422);
    expectProblem(await request(app).patch(`/v1/projects/${project.id}`).send({ status: 'gone' }), 422);
  });

  it('answers an unknown id with a 404 problem', async () => {
    expectProblem(await request(app).patch(`/v1/projects/${UNKNOWN_ID}`).send({ name: 'x' }), 404);
  });

  it('honours Idempotency-Key on PATCH', async () => {
    const project = await createProject();
    const key = randomUUID();
    const first = await request(app).patch(`/v1/projects/${project.id}`).set('Idempotency-Key', key).send({ name: 'renamed' });
    const second = await request(app).patch(`/v1/projects/${project.id}`).set('Idempotency-Key', key).send({ name: 'renamed' });
    expect(first.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});
