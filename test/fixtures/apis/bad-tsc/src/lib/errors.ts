import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { badRequest, HttpProblem, internal, notFound, sendProblem, unprocessable } from './problem.js';

function isMalformedJson(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed';
}

function toHttpProblem(err: unknown): HttpProblem {
  if (err instanceof HttpProblem) return err;
  if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return unprocessable(detail);
  }
  if (isMalformedJson(err)) return badRequest('request body is not valid JSON');
  return internal();
}

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(notFound(`no route for ${req.method} ${req.path}`));
};

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  sendProblem(res, toHttpProblem(err).toProblem(req.originalUrl));
};
