import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination.ts';

/** Public representation. */
export const UserDtoSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

/** Stored record: the DTO plus internal fields that must never leave the API. */
export const UserRecordSchema = UserDtoSchema.extend({ emailNormalized: z.string() });
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const CreateUserRequestSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'member']).default('member'),
});
export const UpdateUserRequestSchema = CreateUserRequestSchema.partial();
export const UserPathSchema = z.object({ userId: z.uuid() });
export const ListUsersRequestSchema = CursorQuerySchema;
export const UserPageDtoSchema = pageSchema(UserDtoSchema);

export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;
