import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Forward rejected promises to the error middleware. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
