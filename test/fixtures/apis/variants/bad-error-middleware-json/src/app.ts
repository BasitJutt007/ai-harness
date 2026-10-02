import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { HttpProblem } from './lib/problem.ts';
import { notFoundHandler } from './lib/errors.ts';
import { registerRoutes } from './routes/index.ts';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  registerRoutes(app);
  app.use(notFoundHandler);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpProblem ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(status).json({ error: message });
  });
  return app;
}
