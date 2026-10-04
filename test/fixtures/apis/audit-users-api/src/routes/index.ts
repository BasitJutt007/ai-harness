import type { Router } from 'express';
import { createUsersRouter } from './users.ts';

/**
 * Mount resource routers here, e.g. `app.use(usersRouter)`.
 * Routers register full versioned paths (`/v1/users`, `/v1/users/:userId`).
 */
export function registerRoutes(app: Router): void {
  app.use(createUsersRouter());
}
