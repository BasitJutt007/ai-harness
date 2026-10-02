import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.js';

export const RoleSchema = z.enum(['admin', 'member']);

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: RoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const CreateUserSchema = z
  .object({
    email: z.email(),
    name: z.string().min(1).max(100),
    role: RoleSchema.default('member'),
  })
  .strict();
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    email: z.email().optional(),
    name: z.string().min(1).max(100).optional(),
    role: RoleSchema.optional(),
  })
  .strict();
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const UserParamsSchema = z.object({ userId: z.uuid() });

export const ListUsersQuerySchema = CursorQuerySchema.extend({ role: RoleSchema.optional() });
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const UserPageSchema = pageSchema(UserSchema);
