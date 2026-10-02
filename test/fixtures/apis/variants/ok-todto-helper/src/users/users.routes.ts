import { Router } from 'express';
import { idempotency } from '../lib/idempotency.ts';
import { notFound } from '../lib/problem.ts';
import { toDto, toPageDto } from './users.mapper.ts';
import { CreateUserRequestSchema, ListUsersRequestSchema, UpdateUserRequestSchema, UserPathSchema } from './users.schema.ts';
import { usersStore } from './users.store.ts';

export const usersRouter = Router();

usersRouter.get('/v1/users', (req, res) => {
  res.json(toPageDto(usersStore.page(ListUsersRequestSchema.parse(req.query))));
});

usersRouter.post('/v1/users', idempotency(), (req, res) => {
  const created = usersStore.add(CreateUserRequestSchema.parse(req.body));
  const dto = toDto(created);
  res.status(201).location(`/v1/users/${dto.id}`).json(dto);
});

usersRouter.get('/v1/users/:userId', (req, res) => {
  const { userId } = UserPathSchema.parse(req.params);
  const rec = usersStore.byId(userId);
  if (rec === undefined) throw notFound(`No user with id ${userId}`);
  res.json(toDto(rec));
});

usersRouter.patch('/v1/users/:userId', idempotency(), (req, res) => {
  const { userId } = UserPathSchema.parse(req.params);
  const rec = usersStore.change(userId, UpdateUserRequestSchema.parse(req.body));
  if (rec === undefined) throw notFound(`No user with id ${userId}`);
  res.json(toDto(rec));
});

usersRouter.delete('/v1/users/:userId', (req, res) => {
  const { userId } = UserPathSchema.parse(req.params);
  if (!usersStore.drop(userId)) throw notFound(`No user with id ${userId}`);
  res.status(204).end();
});
