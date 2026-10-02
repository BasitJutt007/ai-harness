import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.ts';

const Email = z.email().max(254);
const Name = z.string().trim().min(1, 'name is required').max(100);
const Role = z.enum(['admin', 'member']);

export const UserSchema = z.object({
  id: z.uuid(),
  email: Email,
  name: Name,
  role: Role,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const CreateUserSchema = z.object({ email: Email, name: Name, role: Role.default('member') }).strict();

export const UpdateUserSchema = z
  .object({ email: Email, name: Name, role: Role })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Provide at least one field to update' });

export const UserIdParamSchema = z.object({ userId: z.uuid({ message: 'userId must be a UUID' }) });

export const ListUsersQuerySchema = CursorQuerySchema.extend({
  role: Role.optional(),
  q: z.string().trim().min(1).optional(),
});

export const PaginatedUsersSchema = pageSchema(UserSchema);

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;
