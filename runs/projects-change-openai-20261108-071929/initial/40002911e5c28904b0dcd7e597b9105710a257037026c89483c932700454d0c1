/**
 * Idempotency keys for POST and PATCH.
 *
 * A client may send `Idempotency-Key: <1-255 chars>`. For a given key:
 * - first request: runs normally; a 2xx response is remembered (status, Location, Content-Type and
 *   the exact serialized body, captured as it is sent, so a later change to the object the handler
 *   sent, e.g. a PATCH that mutates the stored resource in place, cannot change the replay);
 * - same method + path + body again: the remembered response is replayed byte for byte with
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
    contentType: z.string().optional(),
    /** The bytes sent (a JSON response is captured after serialization), or undefined for no body. */
    body: z.union([z.string(), z.instanceof(Buffer)]).optional(),
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
      if (existing.contentType !== undefined) res.set('Content-Type', existing.contentType);
      if (existing.body === undefined) res.end();
      else res.send(existing.body);
      return;
    }

    store.set(key, StoredResponseSchema.parse({ state: 'in-flight', fingerprint: print }));
    const remember = (body: string | Buffer | undefined): void => {
      if (res.statusCode < 200 || res.statusCode > 299) return;
      const location = res.get('Location');
      const contentType = res.get('Content-Type');
      store.set(key, StoredResponseSchema.parse({ state: 'done', fingerprint: print, status: res.statusCode, location, contentType, body }));
    };
    // Remember the serialized response before it is sent, so a retry that races the socket still replays.
    // res.json (and res.send of an object) serialize and then call res.send with the string: capture that,
    // a snapshot no later mutation of the sent object can reach.
    const send = res.send.bind(res);
    res.send = (body?: unknown) => {
      if (typeof body === 'string') remember(body);
      else if (Buffer.isBuffer(body)) remember(Buffer.from(body));
      return send(body);
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
