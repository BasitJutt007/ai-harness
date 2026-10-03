import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

export const Problem = z.object({ type: z.string(), title: z.string(), status: z.number().int(), detail: z.string(), instance: z.string() });

export class ApiProblem extends Error {
  constructor(readonly status: number, readonly title: string, readonly detail: string, readonly type = `https://problems.example.org/${status}`) {
    super(detail);
  }
}
export const notFound = (detail: string): ApiProblem => new ApiProblem(404, 'Not Found', detail);
export const conflict = (detail: string): ApiProblem => new ApiProblem(409, 'Conflict', detail);
export const preconditionRequired = (detail: string): ApiProblem => new ApiProblem(428, 'Precondition Required', detail);

export const fallthrough: RequestHandler = (req, _res, next) => next(notFound(`${req.method} ${req.originalUrl} not found`));

export const problemMiddleware: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const p =
    err instanceof ApiProblem ? err
      : err instanceof z.ZodError ? new ApiProblem(422, 'Unprocessable Entity', err.issues.map((i) => i.message).join('; '))
        : err instanceof SyntaxError ? new ApiProblem(400, 'Bad Request', 'body is not valid JSON')
          : new ApiProblem(500, 'Internal Server Error', 'something went wrong');
  res.status(p.status).type('application/problem+json').json(Problem.parse({ type: p.type, title: p.title, status: p.status, detail: p.detail, instance: req.originalUrl }));
};
