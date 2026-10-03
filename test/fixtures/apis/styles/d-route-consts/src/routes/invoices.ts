import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { idempotencyKey } from '../lib/idempotency.js';
import { paginate } from '../lib/paginate.js';
import { notFound } from '../lib/problem.js';
import { CreateInvoiceSchema, InvoiceListQuerySchema, InvoicePageSchema, InvoiceParamsSchema, InvoiceSchema } from '../schemas/invoice.js';
import type { Invoice } from '../schemas/invoice.js';
import { INVOICE, INVOICES } from './paths.js';

export function invoicesRouter(): Router {
  const invoices = new Map<string, Invoice>();
  const router = Router();

  function list(req: Request, res: Response): void {
    const { cursor, limit } = InvoiceListQuerySchema.parse(req.query);
    res.json(InvoicePageSchema.parse(paginate([...invoices.values()], cursor, limit)));
  }

  function create(req: Request, res: Response): void {
    const invoice: Invoice = { id: randomUUID(), ...CreateInvoiceSchema.parse(req.body) };
    invoices.set(invoice.id, invoice);
    res.status(201).location(`${INVOICES}/${invoice.id}`).json(InvoiceSchema.parse(invoice));
  }

  function show(req: Request, res: Response): void {
    const { invoiceId } = InvoiceParamsSchema.parse(req.params);
    const invoice = invoices.get(invoiceId);
    if (invoice === undefined) throw notFound(`invoice ${invoiceId} does not exist`);
    res.json(InvoiceSchema.parse(invoice));
  }

  function destroy(req: Request, res: Response): void {
    const { invoiceId } = InvoiceParamsSchema.parse(req.params);
    if (!invoices.delete(invoiceId)) throw notFound(`invoice ${invoiceId} does not exist`);
    res.status(204).end();
  }

  router.route(INVOICES).get(list).post(idempotencyKey, create);
  router.route(INVOICE).get(show).delete(destroy);
  return router;
}
