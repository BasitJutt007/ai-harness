import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { formatZodIssues, notFoundHandler, toHttpProblem } from './lib/errors.ts';
import { registerRoutes } from './routes/index.ts';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  registerRoutes(app);
  app.use(notFoundHandler);
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const problem = toHttpProblem(err);
    const detail = problem.status >= 500 && err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err instanceof ZodError ? formatZodIssues(err) : problem.detail;
    res
      .status(problem.status)
      .type('application/problem+json')
      .json({ type: problem.type, title: problem.title, status: problem.status, detail, instance: req.originalUrl });
  });
  return app;
}
