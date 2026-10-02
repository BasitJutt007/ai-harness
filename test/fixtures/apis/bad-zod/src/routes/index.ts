import type { Router } from 'express';
import { createUsersRouter } from './users.js';

export function registerRoutes(app: Router): void {
  app.use(createUsersRouter());
}
