import type { RequestHandler } from 'express';
import { z } from 'zod';
import { preconditionRequired } from './problem.js';

const Headers = z.object({ 'idempotency-key': z.string().min(1).optional() });

/** 2xx responses already sent, by method, path and Idempotency-Key: the status and a copy of the body. */
const replies = new Map<string, { status: number; location: string | undefined; body: unknown }>();

/** POST must carry an Idempotency-Key (428 Precondition Required otherwise); a repeat replays the first response. */
export const idempotencyKey: RequestHandler = (req, res, next) => {
  const key = Headers.parse(req.headers)['idempotency-key'];
  if (key === undefined) throw preconditionRequired('Idempotency-Key header is required');
  const scoped = `${req.method} ${req.originalUrl} ${key}`;
  const prior = replies.get(scoped);
  if (prior !== undefined) {
    if (prior.location !== undefined) res.location(prior.location);
    res.status(prior.status).json(prior.body);
    return;
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300) replies.set(scoped, { status: res.statusCode, location: res.get('Location'), body: structuredClone(body) });
    return json(body);
  };
  next();
};
