import express from 'express';
import type { Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.ts';
import { projectsRouter } from './modules/projects/routes.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb', type: ['application/json', 'application/*+json'] }));
  app.use(projectsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
