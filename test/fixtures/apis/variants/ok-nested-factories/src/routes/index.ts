import { Router } from 'express';
import { buildUserRouter } from '../modules/users/user.router.ts';

export function registerRoutes(app: Router): void {
  const v1 = Router();
  v1.use('/users', buildUserRouter());
  app.use('/v1', v1);
}
