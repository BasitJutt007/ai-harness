import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from './lib/pagination.ts';

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const CreateUserSchema = UserSchema.pick({ email: true, name: true }).extend({
  role: UserSchema.shape.role.default('member'),
});

export const UpdateUserSchema = CreateUserSchema.partial().strict();

export const UserIdSchema = z.object({ userId: z.uuid() });

export const ListUsersQuerySchema = CursorQuerySchema;

export const UserListSchema = pageSchema(UserSchema);

export type User = z.infer<typeof UserSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
