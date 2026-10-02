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

export const UserParamsSchema = z.object({ userId: z.uuid() });

export const CreateUserSchema = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema.default('member'),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .strictObject({
    email: z.email().optional(),
    name: z.string().min(1).max(100).optional(),
    role: UserRoleSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' });
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const ListUsersQuerySchema = CursorQuerySchema;
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const UserPageSchema = pageSchema(UserSchema);
export type UserPage = z.infer<typeof UserPageSchema>;
