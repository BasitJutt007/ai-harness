import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ProblemError, writeProblem } from '../lib/problem.ts';

function isBodyParseError(err: unknown): boolean {
  return err instanceof SyntaxError && 'type' in err && err.type === 'entity.parse.failed';
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ProblemError(404, 'Not Found', `No route for ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const instance = req.originalUrl;
  if (err instanceof ProblemError) {
    writeProblem(res, { type: err.type, title: err.title, status: err.status, detail: err.detail, instance });
  } else if (err instanceof ZodError) {
    writeProblem(res, { type: 'https://errors.example.com/validation', title: 'Unprocessable Content', status: 422, detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), instance });
  } else if (isBodyParseError(err)) {
    writeProblem(res, { type: 'https://errors.example.com/malformed-json', title: 'Bad Request', status: 400, detail: 'Request body is not valid JSON', instance });
  } else {
    writeProblem(res, { type: 'https://errors.example.com/internal', title: 'Internal Server Error', status: 500, detail: 'Unexpected error', instance });
  }
}
