import { z } from 'zod';

export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export const encodeCursor = (key: string): string => Buffer.from(key, 'utf8').toString('base64url');
export const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString('utf8');

export function paginate<T>(items: T[], query: CursorQuery, key: (item: T) => string): { data: T[]; nextCursor: string | null } {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const start = after === undefined ? 0 : items.findIndex((i) => key(i) === after) + 1;
  const data = items.slice(start, start + query.limit);
  const last = data[data.length - 1];
  const more = start + query.limit < items.length;
  return { data, nextCursor: more && last !== undefined ? encodeCursor(key(last)) : null };
}

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });
