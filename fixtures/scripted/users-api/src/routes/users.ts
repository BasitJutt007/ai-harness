import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { notFound } from '../lib/problem.ts';
import {
  CreateUserSchema,
  ListUsersQuerySchema,
  UpdateUserSchema,
  UserPageSchema,
  UserParamsSchema,
  UserSchema,
} from '../schemas/user.ts';
import { createUser, getUser, listUsers, removeUser, updateUser } from '../store/users.ts';

export const usersRouter = Router();

usersRouter.get('/v1/users', (req, res) => {
  const query = ListUsersQuerySchema.parse(req.query);
  res.json(UserPageSchema.parse(listUsers(query)));
});

usersRouter.post('/v1/users', idempotency(), (req, res) => {
  const body = CreateUserSchema.parse(req.body);
  const user = createUser(body);
  res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
});

usersRouter.get('/v1/users/:userId', (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  const user = getUser(userId);
  if (user === undefined) throw notFound(`user ${userId} not found`);
  res.json(UserSchema.parse(user));
});

usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  const patch = UpdateUserSchema.parse(req.body);
  const user = updateUser(userId, patch);
  if (user === undefined) throw notFound(`user ${userId} not found`);
  res.json(UserSchema.parse(user));
});

usersRouter.delete('/v1/users/:userId', (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  if (!removeUser(userId)) throw notFound(`user ${userId} not found`);
  res.status(204).end();
});
