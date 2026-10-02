import type { Request, Response } from 'express';
import { asyncHandler } from '../../http/async-handler.ts';
import { notFound } from '../../lib/problem.ts';
import { NewUserSchema, UserIdSchema, UserListQuerySchema, UserListSchema, UserPatchSchema, UserSchema } from './user.model.ts';
import type { UserService } from './user.service.ts';

export const listUsers = (svc: UserService) =>
  asyncHandler(async (req: Request, res: Response) => {
    const page = await svc.list(UserListQuerySchema.parse(req.query));
    res.json(UserListSchema.parse(page));
  });

export const createUser = (svc: UserService) =>
  asyncHandler(async (req: Request, res: Response) => {
    const user = await svc.create(NewUserSchema.parse(req.body));
    res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
  });

export function getUser(svc: UserService) {
  return asyncHandler(async (req: Request, res: Response) => {
    const userId = UserIdSchema.parse(req.params.userId);
    const user = await svc.get(userId).catch(() => undefined);
    if (user === undefined) throw notFound(`user ${userId} not found`);
    res.json(UserSchema.parse(user));
  });
}

export function updateUser(svc: UserService) {
  return asyncHandler(async (req: Request, res: Response) => {
    const userId = UserIdSchema.parse(req.params.userId);
    const user = await svc.update(userId, UserPatchSchema.parse(req.body));
    res.json(UserSchema.parse(user));
  });
}

export function deleteUser(svc: UserService) {
  return asyncHandler(async (req: Request, res: Response) => {
    const userId = UserIdSchema.parse(req.params.userId);
    await svc.remove(userId);
    res.status(204).end();
  });
}
