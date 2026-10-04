import { z } from 'zod';

export const OrderStatus = z.enum(['pending', 'paid', 'cancelled']);
export const Order = z.object({
  id: z.uuid(),
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  status: OrderStatus,
  createdAt: z.iso.datetime(),
});
export type Order = z.infer<typeof Order>;

export const CreateOrder = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(1000),
  status: OrderStatus.default('pending'),
}).strict();
export type CreateOrder = z.infer<typeof CreateOrder>;

export const OrderParams = z.object({ orderId: z.uuid() });

export const ListOrdersQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuery>;

export const OrderPage = z.object({ data: z.array(Order), nextCursor: z.string().nullable() });
export type OrderPage = z.infer<typeof OrderPage>;
