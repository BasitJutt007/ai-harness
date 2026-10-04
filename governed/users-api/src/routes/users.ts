import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from '../lib/problem.ts';
import { CursorQuerySchema, pageSchema, paginate } from '../lib/pagination.ts';
import { idempotency } from '../lib/idempotency.ts';

const UserSchema = z.object({ id: z.string().uuid(), email: z.string().email(), name: z.string().min(1).max(100), role: z.enum(['admin', 'member']), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
const CreateSchema = z.object({ email: z.string().email(), name: z.string().min(1).max(100), role: z.enum(['admin', 'member']).default('member') }).strict();
const PatchSchema = z.object({ email: z.string().email().optional(), name: z.string().min(1).max(100).optional(), role: z.enum(['admin', 'member']).optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'must not be empty' });
const IdSchema = z.object({ userId: z.string().uuid() });
type User = z.infer<typeof UserSchema>;

export function usersRouter(): Router {
  const router = Router();
  const users: User[] = [];
  const find = (id: string): User => { const user = users.find((u) => u.id === id); if (!user) throw notFound(`User ${id} was not found.`); return user; };
  router.get('/v1/users', (req, res) => { const query = CursorQuerySchema.parse(req.query); res.status(200).json(pageSchema(UserSchema).parse(paginate(users, query, (u) => `${u.createdAt}|${u.id}`))); });
  router.post('/v1/users', idempotency(), (req, res) => { const input = CreateSchema.parse(req.body); if (users.some((u) => u.email === input.email)) throw conflict('email: already exists'); const now = new Date().toISOString(); const user = UserSchema.parse({ ...input, id: randomUUID(), createdAt: now, updatedAt: now }); users.push(user); res.status(201).location(`/v1/users/${user.id}`).json(user); });
  router.get('/v1/users/:userId', (req, res) => { const { userId } = IdSchema.parse(req.params); res.json(UserSchema.parse(find(userId))); });
  router.patch('/v1/users/:userId', idempotency(), (req, res) => { const { userId } = IdSchema.parse(req.params); const user = find(userId); const input = PatchSchema.parse(req.body); if (input.email !== undefined && users.some((u) => u.id !== userId && u.email === input.email)) throw conflict('email: already exists'); Object.assign(user, input, { updatedAt: new Date().toISOString() }); res.json(UserSchema.parse(user)); });
  router.delete('/v1/users/:userId', (req, res) => { const { userId } = IdSchema.parse(req.params); find(userId); users.splice(users.findIndex((u) => u.id === userId), 1); res.status(204).send(); });
  return router;
}
