import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  HttpProblem,
  ProblemSchema,
  badRequest,
  conflict,
  notFound,
  typeUri,
  sendProblem,
  unprocessable,
} from '../../src/lib/problem.ts';

describe('problem helpers', () => {
  it.each([
    [badRequest('x'), 400, 'malformed-json'],
    [notFound('x'), 404, 'not-found'],
    [conflict('x'), 409, 'conflict'],
    [unprocessable('x'), 422, 'validation'],
  ])('builds an HttpProblem with status and type', (problem, status, slug) => {
    expect(problem).toBeInstanceOf(HttpProblem);
    expect(problem.status).toBe(status);
    expect(problem.type).toBe(typeUri(slug));
    expect(problem.title.length).toBeGreaterThan(0);
  });

  it('accepts a custom problem type slug', () => {
    expect(conflict('busy', 'idempotency-key-in-flight').type).toBe('https://api.sf/problems/idempotency-key-in-flight');
  });

  it('turns an HttpProblem into a Problem with an instance', () => {
    const problem = notFound('user 1 not found').toProblem('/v1/users/1');
    expect(ProblemSchema.parse(problem)).toEqual({
      type: 'https://api.sf/problems/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'user 1 not found',
      instance: '/v1/users/1',
    });
  });

  it('sends a problem as application/problem+json', async () => {
    const app = express();
    app.get('/v1/things', (req, res) => {
      sendProblem(res, conflict('already there').toProblem(req.originalUrl));
    });
    const res = await request(app).get('/v1/things');
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(ProblemSchema.parse(res.body).instance).toBe('/v1/things');
  });
});
