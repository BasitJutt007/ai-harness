import { Router } from 'express';
import { idempotency } from '../lib/idempotency.js';
import { notFound } from '../lib/problem.js';
import {
  CreateUserSchema,
  ListUsersQuerySchema,
  UpdateUserSchema,
  UserPageSchema,
  UserParamsSchema,
  UserSchema,
} from '../schemas/users.js';
import { createUserStore } from '../store/users.js';

export function createUsersRouter(): Router {
  const store = createUserStore();
  const usersRouter = Router();

  usersRouter.get('/v1/users', (req, res) => {
    const query = ListUsersQuerySchema.parse(req.query);
    res.json(UserPageSchema.parse(store.list(query)));
  });

  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const user = store.create(CreateUserSchema.parse({ ...req.body }));
    res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
  });

  usersRouter.get('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const user = store.get(userId);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    res.json(user);
  });

  usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const patch = UpdateUserSchema.parse(req.body);
    const user = store.update(userId, patch);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    const body = UserSchema.parse(user);
    res.json(body);
  });

  usersRouter.delete('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    if (!store.remove(userId)) throw notFound(`user ${userId} not found`);
    res.status(204).end();
  });

  return usersRouter;
}
