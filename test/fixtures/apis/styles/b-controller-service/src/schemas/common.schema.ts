import { z } from 'zod';

export const IdempotencyHeaders = z.object({ 'idempotency-key': z.string().min(8).max(128).optional() });
export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).default(10),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;
