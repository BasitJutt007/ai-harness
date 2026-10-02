import { UserDtoSchema, UserPageDtoSchema } from './users.schema.ts';
import type { UserDto, UserRecord } from './users.schema.ts';

/** Strip internal fields (z.object drops unknown keys) and validate the outgoing shape. */
export function toDto(user: UserRecord): UserDto {
  return UserDtoSchema.parse(user);
}

export const toPageDto = (page: { data: UserRecord[]; nextCursor: string | null }) =>
  UserPageDtoSchema.parse({ data: page.data.map(toDto), nextCursor: page.nextCursor });
