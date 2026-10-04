/**
 * Idempotency keys for POST and PATCH.
 *
 * A client may send `Idempotency-Key: <1-255 chars>`. For a given key:
 * - first request: runs normally; a 2xx response is remembered (status, Location, body);
 * - same method + path + body again: the remembered response is replayed with
 *   `Idempotent-Replayed: true` and the handler does not run;
 * - different method, path or body: 422 problem (idempotency-key-reuse);
 * - while the first request is still running: 409 problem (idempotency-key-in-flight).
 * Non-2xx responses are not remembered, so a corrected retry may reuse the key.
 */
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { conflict, unprocessable } from './problem.ts';

export const IdempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().min(1).max(255).optional(),
});

const StoredResponseSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('in-flight'), fingerprint: z.string() }),
  z.object({
    state: z.literal('done'),
    fingerprint: z.string(),
    status: z.number().int(),
    location: z.string().optional(),
    body: z.unknown(),
  }),
]);
type StoredResponse = z.infer<typeof StoredResponseSchema>;

function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify([method, path, body ?? null])).digest('hex');
}

/** Middleware factory; each call owns its own key store (one per route). */
export function idempotency(): RequestHandler {
  const store = new Map<string, StoredResponse>();

  return (req, res, next) => {
    const key = IdempotencyHeadersSchema.parse(req.headers)['idempotency-key'];
    if (key === undefined) {
      next();
      return;
    }
    const print = fingerprint(req.method, req.originalUrl, req.body);
    const existing = store.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== print) {
        throw unprocessable('Idempotency-Key was already used with a different request.', 'idempotency-key-reuse');
      }
      if (existing.state === 'in-flight') {
        throw conflict('A request with this Idempotency-Key is still being processed.', 'idempotency-key-in-flight');
      }
      res.status(existing.status).set('Idempotent-Replayed', 'true');
      if (existing.location !== undefined) res.location(existing.location);
      if (existing.body === undefined) res.end();
      else res.json(existing.body);
      return;
    }

    store.set(key, StoredResponseSchema.parse({ state: 'in-flight', fingerprint: print }));
    const remember = (body: unknown): void => {
      if (res.statusCode < 200 || res.statusCode > 299) return;
      const location = res.get('Location');
      store.set(key, StoredResponseSchema.parse({ state: 'done', fingerprint: print, status: res.statusCode, location, body }));
    };
    // Remember a JSON response before it is sent, so a retry that races the socket still replays.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      remember(body);
      return json(body);
    };
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode > 299) store.delete(key);
      else if (store.get(key)?.state === 'in-flight') remember(undefined);
    });
    res.on('close', () => {
      if (store.get(key)?.state === 'in-flight') store.delete(key);
    });
    next();
  };
}
