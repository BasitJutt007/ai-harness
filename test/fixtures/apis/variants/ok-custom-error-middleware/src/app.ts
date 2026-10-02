import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { formatZodIssues, toHttpProblem } from './lib/errors.ts';
import { PROBLEM_CONTENT_TYPE, typeUri } from './lib/problem.ts';
import { registerRoutes } from './routes/index.ts';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  registerRoutes(app);

  app.use((req: Request, res: Response) => {
    res
      .status(404)
      .type(PROBLEM_CONTENT_TYPE)
      .json({ type: typeUri('not-found'), title: 'Not Found', status: 404, detail: `Cannot ${req.method} ${req.path}`, instance: req.originalUrl });
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const problem = toHttpProblem(err);
    if (problem.status >= 500) console.error('unhandled error', err);
    const detail = err instanceof ZodError ? formatZodIssues(err) : problem.detail;
    res.status(problem.status).set('Content-Type', 'application/problem+json').json({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      detail,
      instance: req.originalUrl,
    });
  });
  return app;
}
