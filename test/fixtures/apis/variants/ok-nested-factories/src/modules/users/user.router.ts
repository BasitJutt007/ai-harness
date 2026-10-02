import { Router } from 'express';
import { idempotency } from '../../lib/idempotency.ts';
import { createUser, deleteUser, getUser, listUsers, updateUser } from './user.handlers.ts';
import { createUserService } from './user.service.ts';

export function buildUserRouter(): Router {
  const svc = createUserService();
  const r = Router();
  r.get('/', listUsers(svc));
  r.post('/', idempotency(), createUser(svc));
  r.get('/:userId', getUser(svc));
  r.patch('/:userId', idempotency(), updateUser(svc));
  r.delete('/:userId', deleteUser(svc));
  return r;
}
