import express from 'express';
import type { Express } from 'express';
import { buildContainer } from './container.js';
import { errorHandler, notFoundRoute } from './middleware/error-handler.js';
import { customerRoutes } from './routes/customer.routes.js';

export function createApp(): Express {
  const { customerController } = buildContainer();
  const app = express();
  app.use(express.json());
  app.use('/v1/customers', customerRoutes(customerController));
  app.use(notFoundRoute);
  app.use(errorHandler);
  return app;
}
