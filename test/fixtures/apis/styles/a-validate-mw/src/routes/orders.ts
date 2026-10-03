import { Router } from 'express';
import { idempotency } from '../middleware/idempotency.ts';
import { validate } from '../middleware/validate.ts';
import { conflict, notFound } from '../lib/problem.ts';
import { CreateOrder, ListOrdersQuery, Order, OrderPage, OrderParams } from '../schemas.ts';
import type { OrderStore } from '../store.ts';

export function ordersRouter(store: OrderStore): Router {
  const router = Router();

  router.get('/v1/orders', validate({ query: ListOrdersQuery }), (req, res) => {
    res.json(OrderPage.parse(store.list(req.query)));
  });

  router.post('/v1/orders', idempotency(), validate({ body: CreateOrder }), (req, res) => {
    const order = store.create(req.body);
    res.status(201).location(`/v1/orders/${order.id}`).json(Order.parse(order));
  });

  router.get('/v1/orders/:orderId', validate({ params: OrderParams }), (req, res) => {
    const order = store.get(req.params.orderId);
    if (order === undefined) throw notFound(`order ${req.params.orderId} not found`);
    res.json(Order.parse(order));
  });

  router.delete('/v1/orders/:orderId', validate({ params: OrderParams }), (req, res) => {
    const order = store.get(req.params.orderId);
    if (order === undefined) throw notFound(`order ${req.params.orderId} not found`);
    if (order.status === 'paid') throw conflict(`order ${order.id} is paid and cannot be deleted`);
    store.remove(order.id);
    res.status(204).end();
  });

  return router;
}
