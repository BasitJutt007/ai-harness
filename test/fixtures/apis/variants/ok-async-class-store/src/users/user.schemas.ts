import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.ts';

export const UserRoleSchema = z.enum(['admin', 'member']);

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const CreateUserBodySchema = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema.default('member'),
});
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

export const UpdateUserBodySchema = CreateUserBodySchema.partial();
export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;

export const UserIdParamsSchema = z.object({ userId: z.uuid() });

export const ListUsersQuerySchema = CursorQuerySchema.extend({ role: UserRoleSchema.optional() });
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const UsersPageSchema = pageSchema(UserSchema);
