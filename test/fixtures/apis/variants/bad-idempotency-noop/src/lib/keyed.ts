import type { RequestHandler } from 'express';
import { IdempotencyHeadersSchema } from './idempotency.ts';

/** Validates the Idempotency-Key header and lets the request through: nothing is remembered or replayed. */
export const keyed: RequestHandler = (req, _res, next) => {
  const key = IdempotencyHeadersSchema.parse(req.headers)['idempotency-key'];
  if (key === undefined) {
    next();
    return;
  }
  next();
};
