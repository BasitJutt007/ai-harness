import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { paginate } from '../lib/pagination.ts';
import { EmailAlreadyRegisteredError, UserNotFoundError } from './errors.ts';
import { CreateUserSchema, ListQuerySchema, UpdateUserSchema, UserPageSchema, UserRouteParamsSchema, UserSchema } from './schema.ts';
import type { User } from './schema.ts';

const users = new Map<string, User>();

function requireUser(userId: string): User {
  const user = users.get(userId);
  if (user === undefined) throw new UserNotFoundError(userId);
  return user;
}

function assertEmailAvailable(email: string, ownerId?: string): void {
  for (const u of users.values()) if (u.email === email && u.id !== ownerId) throw new EmailAlreadyRegisteredError(email);
}

export const usersRouter = Router();
usersRouter.use(idempotency());

usersRouter.get('/v1/users', (req, res) => {
  const query = ListQuerySchema.parse(req.query);
  res.json(UserPageSchema.parse(paginate([...users.values()], query, (u) => u.id)));
});

usersRouter.post('/v1/users', (req, res) => {
  const input = CreateUserSchema.parse(req.body);
  assertEmailAvailable(input.email);
  const now = new Date().toISOString();
  const user = UserSchema.parse({ role: 'member', ...input, id: randomUUID(), createdAt: now, updatedAt: now });
  users.set(user.id, user);
  res.status(201).location(`/v1/users/${user.id}`).json(user);
});

usersRouter.get('/v1/users/:userId', (req, res) => {
  const { userId } = UserRouteParamsSchema.parse(req.params);
  res.json(UserSchema.parse(requireUser(userId)));
});

usersRouter.patch('/v1/users/:userId', (req, res) => {
  const { userId } = UserRouteParamsSchema.parse(req.params);
  const changes = UpdateUserSchema.parse(req.body);
  const user = requireUser(userId);
  if (changes.email !== undefined) assertEmailAvailable(changes.email, userId);
  const updated = UserSchema.parse({ ...user, ...changes, updatedAt: new Date().toISOString() });
  users.set(userId, updated);
  res.json(updated);
});

usersRouter.delete('/v1/users/:userId', (req, res) => {
  const { userId } = UserRouteParamsSchema.parse(req.params);
  requireUser(userId);
  users.delete(userId);
  res.status(204).end();
});
