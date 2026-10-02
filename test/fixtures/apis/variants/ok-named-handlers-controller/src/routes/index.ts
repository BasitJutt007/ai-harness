import type { Router } from 'express';
import { usersRoutes } from '../users/routes.ts';

export function registerRoutes(app: Router): void {
  app.use(usersRoutes());
}
