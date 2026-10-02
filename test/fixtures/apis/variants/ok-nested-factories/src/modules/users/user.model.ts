import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../../lib/pagination.ts';

export const UserIdSchema = z.uuid();
export const UserSchema = z.object({
  id: UserIdSchema,
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const NewUserSchema = UserSchema.pick({ email: true, name: true, role: true }).partial({ role: true });
export const UserPatchSchema = NewUserSchema.partial();
export const UserListQuerySchema = CursorQuerySchema;
export const UserListSchema = pageSchema(UserSchema);

export type User = z.infer<typeof UserSchema>;
export type NewUser = z.infer<typeof NewUserSchema>;
export type UserPatch = z.infer<typeof UserPatchSchema>;
