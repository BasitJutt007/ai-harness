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
export const CreateUserSchema = UserSchema.pick({ email: true, name: true, role: true }).partial({ role: true });
export const UpdateUserSchema = CreateUserSchema.partial();
export const UserParamsSchema = UserSchema.pick({ id: true }).transform(({ id }) => ({ userId: id }));
export const UserRouteParamsSchema = z.object({ userId: z.uuid() });
export const ListQuerySchema = CursorQuerySchema;
export const UserPageSchema = pageSchema(UserSchema);
export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
