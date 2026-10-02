import { Router } from 'express';
import { idempotency } from '../lib/idempotency.js';
import { badRequest, notFound } from '../lib/problem.js';
import {
  CreateUserSchema,
  ListUsersQuerySchema,
  OffsetQuerySchema,
  UpdateUserSchema,
  UserListSchema,
  UserPageSchema,
  UserParamsSchema,
  UserSchema,
} from '../schemas/users.js';
import { createUserStore } from '../store/users.js';

export function createUsersRouter(): Router {
  const store = createUserStore();
  const usersRouter = Router();

  // unversioned path
  usersRouter.get('/users', (req, res) => {
    const query = ListUsersQuerySchema.parse(req.query);
    res.json(UserPageSchema.parse(store.list(query)));
  });

  // offset pagination
  usersRouter.get('/v1/users', (req, res) => {
    const query = OffsetQuerySchema.parse(req.query);
    const all = store.all();
    res.json(UserListSchema.parse({ data: all.slice(query.offset, query.offset + query.limit), total: all.length }));
  });

  // POST answers 200
  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const body = CreateUserSchema.parse(req.body);
    const user = store.create(body);
    res.json(UserSchema.parse(user));
  });

  // compliant
  usersRouter.get('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const user = store.get(userId);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    res.json(UserSchema.parse(user));
  });

  // singular noun
  usersRouter.get('/v1/user/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const user = store.get(userId);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    res.json(UserSchema.parse(user));
  });

  // no idempotency
  usersRouter.patch('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const patch = UpdateUserSchema.parse(req.body);
    const user = store.update(userId, patch);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    res.json(UserSchema.parse(user));
  });

  // literal 400 in a handler
  usersRouter.put('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const body = CreateUserSchema.parse(req.body);
    if (body.email.endsWith('.invalid')) throw badRequest('reserved email domain');
    const user = store.update(userId, body);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    res.json(UserSchema.parse(user));
  });

  // DELETE answers 200 with a body
  usersRouter.delete('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const user = store.get(userId);
    if (user === undefined || !store.remove(userId)) throw notFound(`user ${userId} not found`);
    res.json(UserSchema.parse(user));
  });

  return usersRouter;
}
