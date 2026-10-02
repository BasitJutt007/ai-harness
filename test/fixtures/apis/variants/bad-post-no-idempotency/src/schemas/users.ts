import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.ts';

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const CreateUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']).default('member'),
});
export const UpdateUserSchema = CreateUserSchema.partial();
export const UserParamsSchema = z.object({ userId: z.uuid() });
export const ListUsersQuerySchema = CursorQuerySchema;
export const UserPageSchema = pageSchema(UserSchema);

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
