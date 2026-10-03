import { z } from 'zod';

export const Product = z.object({ id: z.uuid(), sku: z.string(), name: z.string(), priceCents: z.number().int().nonnegative() });
export type Product = z.infer<typeof Product>;
export const NewProduct = Product.omit({ id: true });
export const ProductPatch = NewProduct.partial();
export const ProductParams = z.object({ productId: z.uuid() });
export const ProductQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const ProductPage = z.object({ data: z.array(Product), nextCursor: z.string().nullable() });
export const WriteHeaders = z.object({ 'idempotency-key': z.string().min(1) });
