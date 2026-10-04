import type { RequestHandler } from 'express';
import { z } from 'zod';
import { preconditionRequired } from './problem.js';

const Headers = z.object({ 'idempotency-key': z.string().min(1).optional() });

/** POST must carry an Idempotency-Key; 428 Precondition Required otherwise. */
export const idempotencyKey: RequestHandler = (req, _res, next) => {
  if (Headers.parse(req.headers)['idempotency-key'] === undefined) throw preconditionRequired('Idempotency-Key header is required');
  next();
};
