import { randomUUID } from 'node:crypto';
import type { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../lib/problem.ts';
import { idempotency } from '../lib/idempotency.ts';
import { CursorQuerySchema, paginate, pageSchema } from '../lib/pagination.ts';

const UserSchema = z.object({ id: z.uuid(), email: z.email(), name: z.string().min(1).max(100), role: z.enum(['admin', 'member']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
const CreateSchema = z.object({ email: z.email(), name: z.string().min(1).max(100), role: z.enum(['admin', 'member']).default('member') }).strict();
const PatchSchema = z.object({ email: z.email().optional(), name: z.string().min(1).max(100).optional(), role: z.enum(['admin', 'member']).optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
const IdSchema = z.object({ userId: z.uuid() });
type User = z.infer<typeof UserSchema>;

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const r = schema.safeParse(input); if (!r.success) throw unprocessable(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')); return r.data; };
const output = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);

export function registerRoutes(app: Router): void {
  const users: User[] = [];
  const find = (id: string): User => { const user = users.find((u) => u.id === id); if (user === undefined) throw notFound(`User ${id} was not found.`); return user; };
  const unique = (email: string, except?: string): void => { if (users.some((u) => u.email === email && u.id !== except)) throw conflict('Email address is already in use.'); };
  app.post('/v1/users', idempotency(), (req: Request, res: Response) => { const data = parse(CreateSchema, req.body); unique(data.email); const now = new Date().toISOString(); const user = output(UserSchema, { ...data, id: randomUUID(), createdAt: now, updatedAt: now }); users.push(user); res.location(`/v1/users/${user.id}`).status(201).json(output(UserSchema, user)); });
  app.get('/v1/users', (req: Request, res: Response) => { const q = parse(CursorQuerySchema, req.query); res.json(pageSchema(UserSchema).parse(paginate(users, q, (u) => `${u.createdAt}|${u.id}`))); });
  app.get('/v1/users/:userId', (req: Request, res: Response) => res.json(output(UserSchema, find(parse(IdSchema, req.params).userId))));
  app.patch('/v1/users/:userId', idempotency(), (req: Request, res: Response) => { const id = parse(IdSchema, req.params).userId; const user = find(id); const data = parse(PatchSchema, req.body); if (data.email !== undefined) unique(data.email, id); Object.assign(user, data, { updatedAt: new Date().toISOString() }); res.json(output(UserSchema, user)); });
  app.delete('/v1/users/:userId', (req: Request, res: Response) => { const id = parse(IdSchema, req.params).userId; find(id); users.splice(users.findIndex((u) => u.id === id), 1); res.status(204).end(); });
}
