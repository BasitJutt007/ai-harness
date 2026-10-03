import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { DomainError } from '../errors/domain-errors.js';
import { ProblemDocument } from '../schemas/problem.schema.js';

const STATUS_BY_CODE: Record<string, number> = { not_found: 404, duplicate: 409, invalid_cursor: 422 };
const TITLES: Record<number, string> = { 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 500: 'Internal Server Error' };

function problem(status: number, detail: string, instance: string, slug: string): ProblemDocument {
  return ProblemDocument.parse({ type: `https://api.example.com/problems/${slug}`, title: TITLES[status] ?? 'Error', status, detail, instance });
}

export const notFoundRoute: RequestHandler = (req, res) => {
  const body = problem(404, `${req.method} ${req.originalUrl} does not exist`, req.originalUrl, 'route-not-found');
  res.status(404).type('application/problem+json').json(body);
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let body: ProblemDocument;
  if (err instanceof DomainError) {
    const status = STATUS_BY_CODE[err.code] ?? 500;
    body = problem(status, err.message, req.originalUrl, err.code.replace(/_/g, '-'));
  } else if (err instanceof ZodError) {
    body = problem(422, err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), req.originalUrl, 'validation-error');
  } else if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    body = problem(400, 'malformed JSON body', req.originalUrl, 'malformed-json');
  } else {
    body = problem(500, 'internal server error', req.originalUrl, 'internal');
  }
  res.status(body.status).type('application/problem+json').json(body);
};
