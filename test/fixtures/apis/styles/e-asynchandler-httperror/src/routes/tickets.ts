import { Router } from 'express';
import { TicketRepo } from '../data/ticket.repo.ts';
import { ConflictError, NotFoundError } from '../errors/http-error.ts';
import { idempotencyHeaders } from '../schemas/headers.schema.ts';
import { createTicketBody, listTicketsQuery, ticketListResponse, ticketParams, ticketSchema, updateTicketBody } from '../schemas/ticket.schema.ts';
import { asyncHandler } from '../utils/async-handler.ts';

export function ticketsRouter(repo = new TicketRepo()): Router {
  const router = Router();

  router.get(
    '/v1/tickets',
    asyncHandler(async (req, res) => {
      const q = listTicketsQuery.parse(req.query);
      res.json(ticketListResponse.parse(await repo.page(q.cursor, q.limit, q.status)));
    }),
  );

  router.post(
    '/v1/tickets',
    asyncHandler(async (req, res) => {
      const headers = idempotencyHeaders.parse(req.headers);
      const body = createTicketBody.parse(req.body);
      const { ticket } = await repo.insert(body, headers['idempotency-key']);
      res.status(201).location(`/v1/tickets/${ticket.id}`).json(ticketSchema.parse(ticket));
    }),
  );

  router.get(
    '/v1/tickets/:ticketId',
    asyncHandler(async (req, res) => {
      const { ticketId } = ticketParams.parse(req.params);
      const ticket = await repo.byId(ticketId);
      if (!ticket) throw new NotFoundError('ticket', ticketId);
      res.json(ticketSchema.parse(ticket));
    }),
  );

  router.patch(
    '/v1/tickets/:ticketId',
    asyncHandler(async (req, res) => {
      idempotencyHeaders.parse(req.headers);
      const { ticketId } = ticketParams.parse(req.params);
      const { status } = updateTicketBody.parse(req.body);
      const current = await repo.byId(ticketId);
      if (!current) throw new NotFoundError('ticket', ticketId);
      if (current.status === 'closed' && status === 'closed') throw new ConflictError('ticket is already closed');
      res.json(ticketSchema.parse(await repo.setStatus(ticketId, status)));
    }),
  );

  return router;
}
