import { z } from 'zod';

export const ticketSchema = z.object({
  id: z.uuid(),
  subject: z.string().min(3).max(140),
  priority: z.enum(['low', 'normal', 'high']),
  status: z.enum(['open', 'closed']),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const createTicketBody = ticketSchema.pick({ subject: true, priority: true });
export const updateTicketBody = z.object({ status: z.enum(['open', 'closed']) });
export const ticketParams = z.object({ ticketId: z.uuid() });
export const listTicketsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['open', 'closed']).optional(),
});
export const ticketListResponse = z.object({ data: z.array(ticketSchema), nextCursor: z.string().nullable() });
