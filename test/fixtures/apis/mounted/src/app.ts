import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { createApiRouter } from './routes/api.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/v1', createApiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
