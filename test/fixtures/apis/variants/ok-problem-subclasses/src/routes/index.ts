import type { Router } from 'express';
import { usersRouter } from '../users/router.ts';

export function registerRoutes(app: Router): void {
  app.use(usersRouter);
}
