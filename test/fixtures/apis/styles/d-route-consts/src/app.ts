import express from 'express';
import type { Express } from 'express';
import { fallthrough, problemMiddleware } from './lib/problem.js';
import { v1Router } from './routes/index.js';
import { invoicesRouter } from './routes/invoices.js';
import { API_V1 } from './routes/paths.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(invoicesRouter());
  app.use(API_V1, v1Router());
  app.use(fallthrough);
  app.use(problemMiddleware);
  return app;
}
