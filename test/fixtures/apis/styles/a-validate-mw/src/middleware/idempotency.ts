import type { RequestHandler } from 'express';
import { z } from 'zod';
import { unprocessable } from '../lib/problem.ts';

const IdempotencyHeaders = z.object({ 'idempotency-key': z.string().min(1).max(255).optional() });
const Remembered = z.object({ fingerprint: z.string(), status: z.number().int(), body: z.unknown() });
type Remembered = z.infer<typeof Remembered>;

/** Replays the first 2xx response for a repeated Idempotency-Key with the same request. */
export function idempotency(): RequestHandler {
  const seen = new Map<string, Remembered>();
  return (req, res, next) => {
    const key = IdempotencyHeaders.parse(req.headers)['idempotency-key'];
    if (key === undefined) return next();
    const fingerprint = JSON.stringify([req.method, req.originalUrl, req.body ?? null]);
    const hit = seen.get(key);
    if (hit !== undefined) {
      if (hit.fingerprint !== fingerprint) throw unprocessable('Idempotency-Key reused with a different request');
      res.status(hit.status).json(hit.body);
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) seen.set(key, Remembered.parse({ fingerprint, status: res.statusCode, body }));
      return json(body);
    };
    next();
  };
}
