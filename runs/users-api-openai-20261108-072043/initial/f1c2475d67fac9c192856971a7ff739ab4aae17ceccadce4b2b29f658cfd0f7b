/**
 * Cursor pagination. A cursor is the opaque (base64url) sort key of the last
 * item on the previous page; the next page holds the items whose key is greater.
 * Keys must be unique and totally ordered (e.g. `${createdAt}|${id}`).
 */
import { z } from 'zod';
import { unprocessable } from './problem.ts';

export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

const CursorPayloadSchema = z.object({ after: z.string() });

export function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify(CursorPayloadSchema.parse({ after: key })), 'utf8').toString('base64url');
}

/** Returns the sort key encoded in `cursor`; throws a 422 problem for anything that is not a cursor we issued. */
export function decodeCursor(cursor: string): string {
  try {
    const json: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return CursorPayloadSchema.parse(json).after;
  } catch {
    throw unprocessable('cursor: Invalid cursor', 'invalid-cursor');
  }
}

/** `{ data: T[], nextCursor: string | null }`: the response schema of every paginated list. */
export function pageSchema<T extends z.ZodType>(item: T): z.ZodObject<{ data: z.ZodArray<T>; nextCursor: z.ZodNullable<z.ZodString> }> {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export function paginate<T>(items: readonly T[], query: CursorQuery, key: (item: T) => string): { data: T[]; nextCursor: string | null } {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const sorted = [...items].sort((a, b) => compareKeys(key(a), key(b)));
  const remaining = after === undefined ? sorted : sorted.filter((item) => compareKeys(key(item), after) > 0);
  const data = remaining.slice(0, query.limit);
  const last = data.at(-1);
  const nextCursor = remaining.length > data.length && last !== undefined ? encodeCursor(key(last)) : null;
  return { data, nextCursor };
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
