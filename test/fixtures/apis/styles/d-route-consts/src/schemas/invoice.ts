import { z } from 'zod';

export const InvoiceSchema = z.object({ id: z.uuid(), customer: z.string(), amountCents: z.number().int().positive(), currency: z.enum(['USD', 'EUR']) });
export type Invoice = z.infer<typeof InvoiceSchema>;
export const CreateInvoiceSchema = InvoiceSchema.omit({ id: true });
export const InvoiceParamsSchema = z.object({ invoiceId: z.uuid() });
export const InvoiceListQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(10) });
export const InvoicePageSchema = z.object({ data: z.array(InvoiceSchema), nextCursor: z.string().nullable() });
