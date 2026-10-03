import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

const Problem = z.object({ type: z.string(), title: z.string(), status: z.number().int(), detail: z.string(), instance: z.string() });
type Problem = z.infer<typeof Problem>;

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly title: string, readonly type: string, readonly detail: string) {
    super(detail);
  }
}
export const notFound = (detail: string): HttpProblem => new HttpProblem(404, 'Not Found', 'urn:problem:not-found', detail);
export const conflict = (detail: string): HttpProblem => new HttpProblem(409, 'Conflict', 'urn:problem:conflict', detail);

function toProblem(err: unknown, instance: string): Problem {
  if (err instanceof HttpProblem) return { type: err.type, title: err.title, status: err.status, detail: err.detail, instance };
  if (err instanceof z.ZodError) return { type: 'urn:problem:validation', title: 'Unprocessable Content', status: 422, detail: z.prettifyError(err), instance };
  if (err instanceof SyntaxError && 'body' in err) return { type: 'urn:problem:malformed-json', title: 'Bad Request', status: 400, detail: 'malformed JSON', instance };
  return { type: 'urn:problem:internal', title: 'Internal Server Error', status: 500, detail: 'unexpected error', instance };
}

export const routeNotFound: RequestHandler = (req, _res, next) => next(notFound(`no route ${req.method} ${req.path}`));

export const problemHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const problem = Problem.parse(toProblem(err, req.originalUrl));
  res.status(problem.status).type('application/problem+json').json(problem);
};
