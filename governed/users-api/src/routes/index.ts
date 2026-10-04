import { Router } from 'express';
import { z } from 'zod';
import { idempotency } from '../lib/idempotency.ts';
import { CursorQuerySchema, pageSchema, paginate } from '../lib/pagination.ts';
import { conflict, notFound, unprocessable } from '../lib/problem.ts';

const UserIdSchema = z.uuid();

const UserSchema = z.object({
  id: UserIdSchema,
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

type User = z.infer<typeof UserSchema>;

const CreateUserBodySchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']).default('member'),
});

const PatchUserBodySchema = z
  .object({
    email: z.email().optional(),
    name: z.string().min(1).max(100).optional(),
    role: z.enum(['admin', 'member']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided.' });

const UserPathSchema = z.object({ userId: UserIdSchema });
const UserListSchema = pageSchema(UserSchema);

function userKey(user: User): string {
  return `${user.createdAt}|${user.id}`;
}

function problemForMissingUser(userId: string) {
  return notFound(`User ${userId} was not found.`);
}

/**
 * Mount resource routers here, e.g. `app.use(usersRouter)`.
 * Routers register full versioned paths (`/v1/users`, `/v1/users/:userId`).
 */
export function registerRoutes(app: Router): void {
  const users = new Map<string, User>();
  const userIdsByEmail = new Map<string, string>();

  const usersRouter = Router();

  usersRouter.get('/v1/users', (req, res) => {
    const query = CursorQuerySchema.parse(req.query);
    const page = paginate([...users.values()], query, userKey);
    const body = UserListSchema.parse({ data: page.data.map((user) => UserSchema.parse(user)), nextCursor: page.nextCursor });
    res.json(body);
  });

  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const body = CreateUserBodySchema.parse(req.body);
    if (userIdsByEmail.has(body.email)) {
      throw conflict(`A user with email ${body.email} already exists.`);
    }

    const now = new Date().toISOString();
    const user = UserSchema.parse({
      id: crypto.randomUUID(),
      email: body.email,
      name: body.name,
      role: body.role,
      createdAt: now,
      updatedAt: now,
    });

    users.set(user.id, user);
    userIdsByEmail.set(user.email, user.id);

    res.location(`/v1/users/${user.id}`).status(201).json(UserSchema.parse(user));
  });

  usersRouter.get('/v1/users/:userId', (req, res) => {
    const { userId } = UserPathSchema.parse(req.params);
    const user = users.get(userId);
    if (user === undefined) throw problemForMissingUser(userId);
    res.json(UserSchema.parse(user));
  });

  usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
    const { userId } = UserPathSchema.parse(req.params);
    const patch = PatchUserBodySchema.parse(req.body);
    const current = users.get(userId);
    if (current === undefined) throw problemForMissingUser(userId);

    if (patch.email !== undefined) {
      const ownerId = userIdsByEmail.get(patch.email);
      if (ownerId !== undefined && ownerId !== userId) {
        throw conflict(`A user with email ${patch.email} already exists.`);
      }
    }

    const updated = UserSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });

    if (updated.email !== current.email) {
      userIdsByEmail.delete(current.email);
      userIdsByEmail.set(updated.email, updated.id);
    }
    users.set(updated.id, updated);

    res.json(UserSchema.parse(updated));
  });

  usersRouter.delete('/v1/users/:userId', (req, res) => {
    const { userId } = UserPathSchema.parse(req.params);
    const user = users.get(userId);
    if (user === undefined) throw problemForMissingUser(userId);
    users.delete(userId);
    userIdsByEmail.delete(user.email);
    res.status(204).end();
  });

  app.use(usersRouter);
}
