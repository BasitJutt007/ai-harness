import type { Router } from 'express';
import { router as usersRouter } from './users.ts';

export function registerRoutes(app: Router): void {
  app.use(usersRouter);
}
