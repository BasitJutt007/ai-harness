import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { idempotency } from '../lib/idempotency.js';
import { CursorQuerySchema, pageSchema, paginate } from '../lib/pagination.js';
import { notFound } from '../lib/problem.js';

const ItemSchema = z.object({ id: z.uuid(), name: z.string().min(1) });
const CreateItemSchema = z.object({ name: z.string().min(1) }).strict();
const ItemPageSchema = pageSchema(ItemSchema);
const WidgetParamsSchema = z.object({ widgetId: z.uuid() });

const listGadgets = (req: Request, res: Response): void => {
  const query = CursorQuerySchema.parse(req.query);
  res.json(ItemPageSchema.parse(paginate([], query, (i: { id: string }) => i.id)));
};

function createGadget(req: Request, res: Response): void {
  const body = CreateItemSchema.parse(req.body);
  res.status(201).json(ItemSchema.parse({ id: crypto.randomUUID(), ...body }));
}

export function createApiRouter(): Router {
  const api = Router();
  const widgets = Router();

  widgets.get('/', (req, res) => {
    const query = CursorQuerySchema.parse(req.query);
    res.json(ItemPageSchema.parse(paginate([], query, (i: { id: string }) => i.id)));
  });

  widgets.get('/:widgetId', (req, res) => {
    const { widgetId } = WidgetParamsSchema.parse(req.params);
    throw notFound(`widget ${widgetId} not found`);
  });

  api.use('/widgets', widgets);
  api.route('/gadgets').get(listGadgets).post(idempotency(), createGadget);
  return api;
}
