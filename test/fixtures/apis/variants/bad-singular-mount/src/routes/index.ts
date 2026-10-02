import type { Router } from 'express';
import { usersRouter } from './users.ts';

export function registerRoutes(app: Router): void {
  app.use('/v1/user', usersRouter);
}
