import express from 'express';
import type { Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.ts';
import { registerRoutes } from './routes/index.ts';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(notFoundHandler);
  registerRoutes(app);
  app.use(errorHandler);
  return app;
}
