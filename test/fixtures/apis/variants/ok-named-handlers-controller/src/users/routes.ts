import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { UsersController, bindService, createUser, listUsers } from './controller.ts';
import { UserService } from './service.ts';

export function usersRoutes(): Router {
  const service = new UserService();
  bindService(service);
  const controller = new UsersController(service);
  const router = Router();
  router.get('/v1/users', listUsers);
  router.post('/v1/users', idempotency(), createUser);
  router.get('/v1/users/:userId', controller.getUser);
  router.patch('/v1/users/:userId', idempotency(), controller.updateUser);
  router.delete('/v1/users/:userId', controller.deleteUser.bind(controller));
  return router;
}
