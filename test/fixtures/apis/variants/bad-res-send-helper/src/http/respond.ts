import type { Response } from 'express';

export function respond(res: Response, status: number, body: unknown): void {
  res.status(status).send(body);
}
