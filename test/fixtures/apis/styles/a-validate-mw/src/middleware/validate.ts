/**
 * validate({ params, query, body }): parses the request parts with Zod before the handler runs,
 * so handlers receive typed, validated input. A ZodError goes to the error middleware (422).
 */
import type { RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';
import { z } from 'zod';

export function validate<
  P extends z.ZodType = z.ZodType<ParamsDictionary>,
  Q extends z.ZodType = z.ZodType<ParsedQs>,
  B extends z.ZodType = z.ZodType<unknown>,
>(schemas: { params?: P; query?: Q; body?: B }): RequestHandler<z.output<P>, unknown, z.output<B>, z.output<Q>> {
  return (req, _res, next) => {
    if (schemas.params !== undefined) req.params = schemas.params.parse(req.params);
    if (schemas.body !== undefined) req.body = schemas.body.parse(req.body);
    if (schemas.query !== undefined) {
      // Express 5: req.query is a getter; shadow it with the parsed value.
      Object.defineProperty(req, 'query', { value: schemas.query.parse(req.query), writable: true, enumerable: true, configurable: true });
    }
    next();
  };
}
