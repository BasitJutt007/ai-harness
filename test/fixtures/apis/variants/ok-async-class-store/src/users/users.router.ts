import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { notFound } from '../lib/problem.ts';
import { UserRepository } from './user.repository.ts';
import {
  CreateUserBodySchema,
  ListUsersQuerySchema,
  UpdateUserBodySchema,
  UserIdParamsSchema,
  UserSchema,
  UsersPageSchema,
} from './user.schemas.ts';

const repo = new UserRepository();

export const usersRouter = Router();

usersRouter.get('/v1/users', async (req, res) => {
  const query = ListUsersQuerySchema.parse(req.query);
  const page = await repo.list(query);
  res.status(200).json(UsersPageSchema.parse(page));
});

usersRouter.post('/v1/users', idempotency(), async (req, res) => {
  const input = await CreateUserBodySchema.parseAsync(req.body);
  const user = await repo.create(input);
  res.status(201).location(`/v1/users/${user.id}`).json(await UserSchema.parseAsync(user));
});

usersRouter.get('/v1/users/:userId', async (req, res) => {
  const { userId } = UserIdParamsSchema.parse(req.params);
  const user = await repo.findById(userId);
  if (!user) {
    throw notFound(`User ${userId} was not found.`);
  }
  res.json(UserSchema.parse(user));
});

usersRouter.patch('/v1/users/:userId', idempotency(), async (req, res) => {
  const { userId } = UserIdParamsSchema.parse(req.params);
  const patch = UpdateUserBodySchema.parse(req.body);
  const user = await repo.update(userId, patch);
  if (!user) throw notFound(`User ${userId} was not found.`);
  res.status(200).json(UserSchema.parse(user));
});

usersRouter.delete('/v1/users/:userId', async (req, res) => {
  const { userId } = UserIdParamsSchema.parse(req.params);
  const deleted = await repo.delete(userId);
  if (!deleted) throw notFound(`User ${userId} was not found.`);
  res.status(204).send();
});
