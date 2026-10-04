import { Router } from 'express';
import type { RequestHandler } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { notFound } from '../lib/problem.ts';
import { CreateUserSchema, ListUsersQuerySchema, UpdateUserSchema, UserPageSchema, UserParamsSchema, UserSchema } from '../schemas/users.ts';
import type { User } from '../schemas/users.ts';
import { store } from '../store/users.ts';

export const usersRouter = Router();

const recent = new Map<string, User>();

/** Answers from the recently-read cache before the handler runs (the cached value is sent unparsed). */
function serveRecent(): RequestHandler {
  return (req, res, next) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const hit = recent.get(userId);
    if (hit !== undefined) {
      res.json(hit);
      return;
    }
    next();
  };
}

usersRouter.get('/v1/users', (req, res) => {
  const query = ListUsersQuerySchema.parse(req.query);
  res.json(UserPageSchema.parse(store.list(query)));
});

usersRouter.post('/v1/users', idempotency(), (req, res) => {
  const user = store.create(CreateUserSchema.parse(req.body));
  res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
});

usersRouter.get('/v1/users/:userId', serveRecent(), (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  const user = store.get(userId);
  if (user === undefined) throw notFound(`user ${userId} not found`);
  recent.set(userId, user);
  res.json(UserSchema.parse(user));
});

usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  const user = store.update(userId, UpdateUserSchema.parse(req.body));
  if (user === undefined) throw notFound(`user ${userId} not found`);
  recent.delete(userId);
  res.json(UserSchema.parse(user));
});

usersRouter.delete('/v1/users/:userId', (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  if (!store.remove(userId)) throw notFound(`user ${userId} not found`);
  recent.delete(userId);
  res.status(204).end();
});
