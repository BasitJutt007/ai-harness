import type { Response } from 'express';
import { z } from 'zod';

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly type: string = `https://errors.example.com/${title.toLowerCase().replace(/\s+/g, '-')}`,
  ) {
    super(detail);
  }
}

export const notFound = (detail: string): ProblemError => new ProblemError(404, 'Not Found', detail);
export const conflict = (detail: string): ProblemError => new ProblemError(409, 'Conflict', detail);
export const unprocessable = (detail: string): ProblemError => new ProblemError(422, 'Unprocessable Content', detail);

export function writeProblem(res: Response, p: Problem): void {
  res.status(p.status).type('application/problem+json').json(ProblemSchema.parse(p));
}
