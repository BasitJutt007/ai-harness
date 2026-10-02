import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { paginate } from '../lib/pagination.ts';
import { conflict, notFound } from '../lib/problem.ts';
import {
  CreateUserSchema,
  ListUsersQuerySchema,
  PaginatedUsersSchema,
  UpdateUserSchema,
  UserIdParamSchema,
  UserSchema,
} from '../schemas/user.schema.ts';
import type { User } from '../schemas/user.schema.ts';

const users: User[] = [];

function findIndex(id: string): number {
  return users.findIndex((u) => u.id === id);
}

function ensureUniqueEmail(email: string, selfId?: string): void {
  if (users.some((u) => u.email === email && u.id !== selfId)) throw conflict(`User with email "${email}" already exists`);
}

export const router = Router();

router
  .route('/v1/users')
  .get((req, res) => {
    const { role, q, ...cursor } = ListUsersQuerySchema.parse(req.query);
    const filtered = users.filter((u) => (role === undefined || u.role === role) && (q === undefined || u.name.includes(q)));
    res.json(PaginatedUsersSchema.parse(paginate(filtered, cursor, (u) => `${u.createdAt}|${u.id}`)));
  })
  .post(idempotency(), (req, res) => {
    const input = CreateUserSchema.parse(req.body);
    ensureUniqueEmail(input.email);
    const now = new Date().toISOString();
    const user = UserSchema.parse({ id: randomUUID(), ...input, createdAt: now, updatedAt: now });
    users.push(user);
    res.status(201).setHeader('Location', `/v1/users/${user.id}`).json(user);
  });

router
  .route('/v1/users/:userId')
  .get((req, res) => {
    const { userId } = UserIdParamSchema.parse(req.params);
    const user = users[findIndex(userId)];
    if (user === undefined) throw notFound(`User ${userId} not found`);
    res.json(UserSchema.parse(user));
  })
  .patch(idempotency(), (req, res) => {
    const { userId } = UserIdParamSchema.parse(req.params);
    const patch = UpdateUserSchema.parse(req.body);
    const i = findIndex(userId);
    const existing = users[i];
    if (existing === undefined) throw notFound(`User ${userId} not found`);
    if (patch.email !== undefined) ensureUniqueEmail(patch.email, userId);
    const updated = UserSchema.parse({ ...existing, ...patch, updatedAt: new Date().toISOString() });
    users[i] = updated;
    res.json(updated);
  })
  .delete((req, res) => {
    const { userId } = UserIdParamSchema.parse(req.params);
    const i = findIndex(userId);
    if (i === -1) throw notFound(`User ${userId} not found`);
    users.splice(i, 1);
    res.status(204).end();
  });
