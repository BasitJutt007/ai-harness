import type { RequestHandler } from 'express';
import { IdempotencyHeaders } from '../schemas/common.schema.js';

const replays = new Map<string, { status: number; body: unknown }>();

/** Requires nothing; replays a cached 2xx for a repeated Idempotency-Key. */
export const requireIdempotencyKey: RequestHandler = (req, res, next) => {
  const { 'idempotency-key': key } = IdempotencyHeaders.parse(req.headers);
  if (key === undefined) return next();
  const cacheKey = `${req.method} ${req.originalUrl} ${key}`;
  const cached = replays.get(cacheKey);
  if (cached !== undefined) {
    res.status(cached.status).json(cached.body);
    return;
  }
  const original = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 300) replays.set(cacheKey, { status: res.statusCode, body });
    return original(body);
  };
  next();
};
