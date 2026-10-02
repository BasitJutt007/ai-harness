import type { Router } from 'express';
import { usersRouter } from '../users/users.routes.ts';

export function registerRoutes(app: Router): void {
  app.use(usersRouter);
}
