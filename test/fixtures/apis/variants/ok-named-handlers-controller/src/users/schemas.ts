import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.ts';

export const User = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof User>;

export const CreateUserBody = User.omit({ id: true, createdAt: true, updatedAt: true }).extend({
  role: User.shape.role.default('member'),
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = CreateUserBody.partial();
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const UserParams = z.object({ userId: z.uuid() });
export const ListUsersQuery = CursorQuerySchema;
export const UserPage = pageSchema(User);
