import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { ProblemSchema, notFound, typeUri } from '../lib/problem.ts';
import { CreateUserSchema, ListUsersQuerySchema, UpdateUserSchema, UserPageSchema, UserParamsSchema, UserSchema } from '../schemas/users.ts';
import { store } from '../store/users.ts';

export const usersRouter = Router();

usersRouter.get('/v1/users', (req, res) => {
  const query = ListUsersQuerySchema.parse(req.query);
  res.json(UserPageSchema.parse(store.list(query)));
});

usersRouter.post('/v1/users', idempotency(), (req, res) => {
  const input = CreateUserSchema.parse(req.body);
  if (store.emailTaken(input.email)) {
    // A typed problem body, but sent as application/json (no problem Content-Type).
    res.status(409).json(ProblemSchema.parse({ type: typeUri('conflict'), title: 'Conflict', status: 409, detail: `email ${input.email} is taken`, instance: req.originalUrl }));
    return;
  }
  const user = store.create(input);
  res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
});

usersRouter.get('/v1/users/:userId', (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  const user = store.get(userId);
  if (user === undefined) throw notFound(`user ${userId} not found`);
  res.json(UserSchema.parse(user));
});

usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  const user = store.update(userId, UpdateUserSchema.parse(req.body));
  if (user === undefined) throw notFound(`user ${userId} not found`);
  res.json(UserSchema.parse(user));
});

usersRouter.delete('/v1/users/:userId', (req, res) => {
  const { userId } = UserParamsSchema.parse(req.params);
  if (!store.remove(userId)) throw notFound(`user ${userId} not found`);
  res.status(204).end();
});
