import express from 'express';
import type { Express } from 'express';
import { notFoundHandler } from './lib/errors.ts';
import { registerRoutes } from './routes/index.ts';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  registerRoutes(app);
  app.use(notFoundHandler);
  return app;
}
