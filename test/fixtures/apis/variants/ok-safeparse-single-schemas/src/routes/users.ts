import { Router } from 'express';
import { formatZodIssues } from '../lib/errors.ts';
import { idempotency } from '../lib/idempotency.ts';
import { notFound, unprocessable } from '../lib/problem.ts';
import { CreateUserSchema, ListUsersQuerySchema, UpdateUserSchema, UserIdSchema, UserListSchema, UserSchema } from '../schemas.ts';
import { deleteUser, findUser, insertUser, listUsers, patchUser } from '../store/users.ts';

export const usersRouter = Router();

usersRouter.get('/v1/users', (req, res) => {
  const result = ListUsersQuerySchema.safeParse(req.query);
  if (!result.success) {
    throw unprocessable(formatZodIssues(result.error));
  }
  res.json(UserListSchema.parse(listUsers(result.data)));
});

usersRouter.post('/v1/users', idempotency(), (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) throw unprocessable(formatZodIssues(parsed.error));
  const user = insertUser(parsed.data);
  res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
});

usersRouter.get('/v1/users/:userId', (req, res) => {
  const params = UserIdSchema.safeParse(req.params);
  if (!params.success) throw unprocessable(formatZodIssues(params.error));
  const user = findUser(params.data.userId);
  if (user === undefined) throw notFound(`User ${params.data.userId} not found`);
  res.json(UserSchema.parse(user));
});

usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
  const params = UserIdSchema.safeParse(req.params);
  if (!params.success) throw unprocessable(formatZodIssues(params.error));
  const body = UpdateUserSchema.safeParse(req.body);
  if (!body.success) throw unprocessable(formatZodIssues(body.error));
  const user = patchUser(params.data.userId, body.data);
  if (user === undefined) throw notFound(`User ${params.data.userId} not found`);
  res.json(UserSchema.parse(user));
});

usersRouter.delete('/v1/users/:userId', (req, res) => {
  const params = UserIdSchema.safeParse(req.params);
  if (!params.success) throw params.error;
  if (!deleteUser(params.data.userId)) throw notFound(`User ${params.data.userId} not found`);
  res.sendStatus(204);
});
