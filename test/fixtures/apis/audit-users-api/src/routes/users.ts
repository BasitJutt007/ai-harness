import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { idempotency } from '../lib/idempotency.ts';
import { CursorQuerySchema, pageSchema, paginate } from '../lib/pagination.ts';
import { conflict, notFound } from '../lib/problem.ts';

const UserRoleSchema = z.enum(['admin', 'member']);

const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

type User = z.infer<typeof UserSchema>;

const CreateUserBodySchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema.default('member'),
});

const PatchUserBodySchema = z
  .object({
    email: z.email().optional(),
    name: z.string().min(1).max(100).optional(),
    role: UserRoleSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided.' });

const UserIdParamsSchema = z.object({
  userId: z.uuid(),
});

const UserListSchema = pageSchema(UserSchema);

export function createUsersRouter(): Router {
  const router = Router();
  const users = new Map<string, User>();

  router.get('/v1/users', (req, res) => {
    const query = CursorQuerySchema.parse(req.query);
    const page = paginate(Array.from(users.values()), query, (user) => `${user.createdAt}|${user.id}`);
    res.json(UserListSchema.parse(page));
  });

  router.get('/v1/users/:userId', (req, res) => {
    const { userId } = UserIdParamsSchema.parse(req.params);
    const user = users.get(userId);
    if (user === undefined) throw notFound(`User ${userId} was not found.`);
    res.json(UserSchema.parse(user));
  });

  router.post('/v1/users', idempotency(), (req, res) => {
    const body = CreateUserBodySchema.parse(req.body);
    assertEmailUnique(users, body.email);

    const now = new Date().toISOString();
    const user = UserSchema.parse({
      id: randomUUID(),
      email: body.email,
      name: body.name,
      role: body.role,
      createdAt: now,
      updatedAt: now,
    });

    users.set(user.id, user);
    res.location(`/v1/users/${user.id}`).status(201).json(UserSchema.parse(user));
  });

  router.patch('/v1/users/:userId', idempotency(), (req, res) => {
    const { userId } = UserIdParamsSchema.parse(req.params);
    const body = PatchUserBodySchema.parse(req.body);
    const existing = users.get(userId);
    if (existing === undefined) throw notFound(`User ${userId} was not found.`);

    if (body.email !== undefined && body.email !== existing.email) {
      assertEmailUnique(users, body.email, userId);
    }

    const updated = UserSchema.parse({
      ...existing,
      ...body,
      updatedAt: new Date().toISOString(),
    });

    users.set(userId, updated);
    res.json(UserSchema.parse(updated));
  });

  router.delete('/v1/users/:userId', (req, res) => {
    const { userId } = UserIdParamsSchema.parse(req.params);
    if (!users.has(userId)) throw notFound(`User ${userId} was not found.`);
    users.delete(userId);
    res.status(204).send();
  });

  return router;
}

function assertEmailUnique(users: Map<string, User>, email: string, ignoreUserId?: string): void {
  for (const user of users.values()) {
    if (user.email === email && user.id !== ignoreUserId) {
      throw conflict(`email: User with email ${email} already exists.`);
    }
  }
}
