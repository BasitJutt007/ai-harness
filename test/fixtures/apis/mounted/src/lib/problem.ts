import type { Response } from 'express';
import { z } from 'zod';

export const PROBLEM_BASE = 'https://api.sf/problems/';

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const ProblemInitSchema = ProblemSchema.omit({ instance: true });
export type ProblemInit = z.infer<typeof ProblemInitSchema>;

export class HttpProblem extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;

  constructor(init: ProblemInit) {
    super(init.detail);
    this.type = init.type;
    this.title = init.title;
    this.status = init.status;
    this.detail = init.detail;
  }

  toProblem(instance: string): Problem {
    return ProblemSchema.parse({ type: this.type, title: this.title, status: this.status, detail: this.detail, instance });
  }
}

export const badRequest = (detail: string): HttpProblem =>
  new HttpProblem({ type: `${PROBLEM_BASE}malformed-json`, title: 'Malformed JSON', status: 400, detail });
export const notFound = (detail: string): HttpProblem =>
  new HttpProblem({ type: `${PROBLEM_BASE}not-found`, title: 'Not Found', status: 404, detail });
export const conflict = (detail: string): HttpProblem =>
  new HttpProblem({ type: `${PROBLEM_BASE}conflict`, title: 'Conflict', status: 409, detail });
export const unprocessable = (detail: string, slug = 'validation'): HttpProblem =>
  new HttpProblem({ type: `${PROBLEM_BASE}${slug}`, title: 'Unprocessable Content', status: 422, detail });
export const internal = (): HttpProblem =>
  new HttpProblem({ type: `${PROBLEM_BASE}internal`, title: 'Internal Server Error', status: 500, detail: 'unexpected error' });

export function sendProblem(res: Response, problem: Problem): void {
  res.status(problem.status).type('application/problem+json').json(ProblemSchema.parse(problem));
}
