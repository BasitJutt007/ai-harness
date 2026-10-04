import express from 'express';
import type { Express } from 'express';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { ordersRouter } from './routes/orders.ts';
import { OrderStore } from './store.ts';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(ordersRouter(new OrderStore()));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
