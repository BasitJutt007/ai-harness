import type { Response } from 'express';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Writes an RFC 7807 problem document. */
export function sendProblem(res: Response, status: number, detail: string, type = 'about:blank'): void {
  res
    .status(status)
    .type('application/problem+json')
    .json({ type, title: TITLES[status] ?? 'Error', status, detail, instance: res.req.originalUrl });
}
