import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { NewProduct, Product } from './product.schemas.js';

const products = new Map<string, Product>();

export function resetProducts(): void {
  products.clear();
}
export function listProducts(after: string | undefined, limit: number): { data: Product[]; nextCursor: string | null } {
  const all = [...products.values()];
  const start = after === undefined ? 0 : all.findIndex((p) => p.id === after) + 1;
  const data = all.slice(start, start + limit);
  const last = data.at(-1);
  return { data, nextCursor: last !== undefined && start + limit < all.length ? last.id : null };
}
export const findProduct = (id: string): Product | undefined => products.get(id);
export const findBySku = (sku: string): Product | undefined => [...products.values()].find((p) => p.sku === sku);
export function insertProduct(input: z.infer<typeof NewProduct>): Product {
  const product = { id: randomUUID(), ...input };
  products.set(product.id, product);
  return product;
}
export function replaceProduct(product: Product): void {
  products.set(product.id, product);
}
export const deleteProduct = (id: string): boolean => products.delete(id);
