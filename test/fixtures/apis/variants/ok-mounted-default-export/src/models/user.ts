import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.ts';

export const userSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']).optional().default('member'),
});

export const updateUserSchema = createUserSchema.partial();
export const userParamsSchema = z.object({ userId: z.uuid() });
export const listUsersQuerySchema = CursorQuerySchema.extend({ email: z.email().optional() });
export const userPageSchema = pageSchema(userSchema);

export type User = z.infer<typeof userSchema>;
export type CreateUser = z.infer<typeof createUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
