import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  registerRoutes(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
