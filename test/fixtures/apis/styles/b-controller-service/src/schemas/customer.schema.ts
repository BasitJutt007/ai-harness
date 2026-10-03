import { z } from 'zod';
import { PaginationQuery } from './common.schema.js';

export const customerSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

export const createCustomerSchema = customerSchema.pick({ email: true, name: true });
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerIdParamsSchema = z.object({ customerId: z.uuid() });

export const listCustomersQuerySchema = PaginationQuery.extend({ email: z.string().optional() });
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export const customerListSchema = z.object({ items: z.array(customerSchema), nextCursor: z.string().nullable() });
export type CustomerList = z.infer<typeof customerListSchema>;
