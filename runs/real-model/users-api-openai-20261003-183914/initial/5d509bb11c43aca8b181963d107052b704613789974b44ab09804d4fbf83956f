import express from 'express';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/app.ts';
import { errorHandler, notFoundHandler } from '../../src/lib/errors.ts';
import { ProblemSchema, notFound } from '../../src/lib/problem.ts';

function expectProblem(res: Response, status: number, slug: string) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(res.body);
  expect(problem.status).toBe(status);
  expect(problem.type).toBe(`https://api.sf/problems/${slug}`);
  return problem;
}

const ThingSchema = z.object({ name: z.string().min(1), size: z.number().int() });

/** A throwaway app with one validating route, wired like createApp(). */
function appWithRoute() {
  const app = express();
  app.use(express.json());
  app.post('/v1/things', (req, res) => {
    const body = ThingSchema.parse(req.body);
    res.status(201).json(ThingSchema.parse(body));
  });
  app.get('/v1/things/:thingId', (req) => {
    throw notFound(`thing ${String(req.params.thingId)} not found`);
  });
  app.get('/v1/boom', () => {
    throw new Error('secret internals');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('createApp error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers unknown routes with a 404 problem', async () => {
    const res = await request(createApp()).get('/v1/does-not-exist?x=1');
    const problem = expectProblem(res, 404, 'not-found');
    expect(problem.instance).toBe('/v1/does-not-exist?x=1');
    expect(problem.detail).toContain('GET /v1/does-not-exist');
  });

  it('answers malformed JSON with a 400 problem', async () => {
    const res = await request(createApp()).post('/v1/anything').set('Content-Type', 'application/json').send('{"name":');
    expectProblem(res, 400, 'malformed-json');
  });

  it('maps a ZodError to a 422 problem listing each issue', async () => {
    const res = await request(appWithRoute()).post('/v1/things').send({ name: '', size: 1.5 });
    const problem = expectProblem(res, 422, 'validation');
    expect(problem.detail).toContain('name: ');
    expect(problem.detail).toContain('size: ');
    expect(problem.detail.split('; ')).toHaveLength(2);
  });

  it('passes valid bodies through', async () => {
    const res = await request(appWithRoute()).post('/v1/things').send({ name: 'a', size: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'a', size: 2 });
  });

  it('sends a thrown HttpProblem with its own status', async () => {
    const res = await request(appWithRoute()).get('/v1/things/42');
    const problem = expectProblem(res, 404, 'not-found');
    expect(problem.detail).toBe('thing 42 not found');
    expect(problem.instance).toBe('/v1/things/42');
  });

  it('hides unexpected errors behind a 500 problem without a stack', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await request(appWithRoute()).get('/v1/boom');
    const problem = expectProblem(res, 500, 'internal');
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
    expect(problem.detail).not.toContain('at ');
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('secret internals');
  });
});
