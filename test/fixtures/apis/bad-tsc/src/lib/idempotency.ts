import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { conflict, unprocessable } from './problem.js';

const IdempotencyHeadersSchema = z.object({ 'idempotency-key': z.string().min(1).max(255).optional() });

const StoredSchema = z.object({
  fingerprint: z.string(),
  done: z.boolean(),
  status: z.number().int(),
  body: z.unknown(),
});
type Stored = z.infer<typeof StoredSchema>;

export function idempotency(): RequestHandler {
  const seen = new Map<string, Stored>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = IdempotencyHeadersSchema.parse(req.headers)['idempotency-key'];
    if (key === undefined) {
      next();
      return;
    }
    const slot = `${req.method} ${req.originalUrl} ${key}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(z.unknown().parse(req.body) ?? null)).digest('hex');
    const prior = seen.get(slot);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        next(unprocessable('Idempotency-Key was reused with a different request body', 'idempotency-key-reuse'));
        return;
      }
      if (!prior.done) {
        next(conflict('a request with this Idempotency-Key is still in flight'));
        return;
      }
      res.set('Idempotent-Replayed', 'true');
      res.status(prior.status).json(prior.body);
      return;
    }
    const entry: Stored = { fingerprint, done: false, status: 0, body: null };
    seen.set(slot, entry);
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 300) {
        entry.done = true;
        entry.status = res.statusCode;
        entry.body = body;
      } else {
        seen.delete(slot);
      }
      return send(body);
    };
    next();
  };
}
