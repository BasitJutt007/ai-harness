/**
 * RFC 9457 problem details. Every error response of this API is a Problem sent
 * with `Content-Type: application/problem+json`.
 */
import type { Response } from 'express';
import { z } from 'zod';

export const PROBLEM_TYPE_BASE = 'https://api.sf/problems/';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const ProblemSchema = z.object({
  type: z.url(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
});
export type Problem = z.infer<typeof ProblemSchema>;

/** What a thrower supplies; `instance` is filled in by the error middleware from the request. */
export const ProblemInitSchema = ProblemSchema.omit({ instance: true });
export type ProblemInit = z.infer<typeof ProblemInitSchema>;

/** The problem `type` URI for a slug, e.g. typeUri('not-found'). */
export function typeUri(slug: string): string {
  return `${PROBLEM_TYPE_BASE}${slug}`;
}

/** Throw this from a handler (or middleware); the error middleware turns it into a Problem response. */
export class HttpProblem extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;

  constructor(init: ProblemInit) {
    super(init.detail);
    this.name = 'HttpProblem';
    this.type = init.type;
    this.title = init.title;
    this.status = init.status;
    this.detail = init.detail;
  }

  toProblem(instance: string): Problem {
    return ProblemSchema.parse({ type: this.type, title: this.title, status: this.status, detail: this.detail, instance });
  }
}

export function badRequest(detail: string, slug = 'malformed-json'): HttpProblem {
  return new HttpProblem({ type: typeUri(slug), title: 'Bad Request', status: 400, detail });
}

export function notFound(detail: string, slug = 'not-found'): HttpProblem {
  return new HttpProblem({ type: typeUri(slug), title: 'Not Found', status: 404, detail });
}

export function conflict(detail: string, slug = 'conflict'): HttpProblem {
  return new HttpProblem({ type: typeUri(slug), title: 'Conflict', status: 409, detail });
}

export function unprocessable(detail: string, slug = 'validation'): HttpProblem {
  return new HttpProblem({ type: typeUri(slug), title: 'Unprocessable Content', status: 422, detail });
}

export function internalError(detail = 'An unexpected error occurred.'): HttpProblem {
  return new HttpProblem({ type: typeUri('internal'), title: 'Internal Server Error', status: 500, detail });
}

export function sendProblem(res: Response, problem: Problem): void {
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(ProblemSchema.parse(problem));
}
