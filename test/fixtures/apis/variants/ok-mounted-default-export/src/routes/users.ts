import { randomUUID } from 'node:crypto';
import express from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { paginate } from '../lib/pagination.ts';
import { conflict, notFound } from '../lib/problem.ts';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userPageSchema,
  userParamsSchema,
  userSchema,
} from '../models/user.ts';
import type { User } from '../models/user.ts';

const router = express.Router();
const db = new Map<string, User>();

router.get('/', (req, res) => {
  const { email, ...page } = listUsersQuerySchema.parse(req.query);
  const matches = [...db.values()].filter((u) => email === undefined || u.email === email);
  res.json(userPageSchema.parse(paginate(matches, page, (u) => u.id)));
});

router.post('/', idempotency(), (req, res) => {
  const data = createUserSchema.parse(req.body);
  if ([...db.values()].some((u) => u.email === data.email)) throw conflict('Email already in use');
  const now = new Date().toISOString();
  const user: User = { id: randomUUID(), ...data, createdAt: now, updatedAt: now };
  db.set(user.id, user);
  res.status(201).location(`${req.baseUrl}/${user.id}`).json(userSchema.parse(user));
});

router.get('/:userId', (req, res) => {
  const { userId } = userParamsSchema.parse(req.params);
  const user = db.get(userId);
  if (!user) throw notFound(`User ${userId} not found`);
  res.json(userSchema.parse(user));
});

router.patch('/:userId', idempotency(), (req, res) => {
  const { userId } = userParamsSchema.parse(req.params);
  const changes = updateUserSchema.parse(req.body);
  const user = db.get(userId);
  if (!user) throw notFound(`User ${userId} not found`);
  if (changes.email !== undefined && [...db.values()].some((u) => u.email === changes.email && u.id !== userId)) {
    throw conflict('Email already in use');
  }
  const updated: User = { ...user, ...changes, updatedAt: new Date().toISOString() };
  db.set(userId, updated);
  res.json(userSchema.parse(updated));
});

router.delete('/:userId', (req, res) => {
  const { userId } = userParamsSchema.parse(req.params);
  if (!db.has(userId)) throw notFound(`User ${userId} not found`);
  db.delete(userId);
  res.status(204).end();
});

export default router;
