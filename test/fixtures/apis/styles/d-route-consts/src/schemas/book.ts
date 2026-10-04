import { z } from 'zod';

export const BookSchema = z.object({ id: z.uuid(), isbn: z.string().min(10).max(17), title: z.string().min(1) });
export type Book = z.infer<typeof BookSchema>;
export const CreateBookSchema = BookSchema.omit({ id: true });
export const BookParamsSchema = z.object({ bookId: z.uuid() });
export const BookListQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(10) });
export const BookPageSchema = z.object({ data: z.array(BookSchema), nextCursor: z.string().nullable() });
