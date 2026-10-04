/**
 * The two terminal middlewares: a not-found handler and the error handler.
 * Both answer with application/problem+json; nothing else in the API formats errors.
 */
import { inspect } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { HttpProblem, badRequest, internalError, notFound, typeUri, sendProblem, unprocessable } from './problem.ts';

/** Shape of the errors thrown by express.json() (body-parser / http-errors). */
const BodyParserErrorSchema = z.object({
  type: z.string(),
  status: z.number().int().min(400).max(499),
  message: z.string(),
});

/** "email: Invalid email address; name: Too big: expected string to have <=100 characters" */
export function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

export function toHttpProblem(err: unknown): HttpProblem {
  if (err instanceof HttpProblem) return err;
  if (err instanceof ZodError) return unprocessable(formatZodIssues(err));
  const parserError = BodyParserErrorSchema.safeParse(err);
  if (parserError.success) {
    const { type, status, message } = parserError.data;
    if (type === 'entity.parse.failed') return badRequest('The request body is not valid JSON.');
    return new HttpProblem({ type: typeUri('request-rejected'), title: 'Request Rejected', status, detail: message });
  }
  return internalError();
}

export function notFoundHandler(req: Request, res: Response): void {
  sendProblem(res, notFound(`No route matches ${req.method} ${req.originalUrl}.`).toProblem(req.originalUrl));
}

/** Unexpected errors go to stderr for the operator; the client only ever sees the generic 500 problem. */
function reportUnexpected(err: unknown): void {
  process.stderr.write(`${inspect(err)}\n`);
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const problem = toHttpProblem(err);
  if (problem.status >= 500) reportUnexpected(err);
  sendProblem(res, problem.toProblem(req.originalUrl));
}
