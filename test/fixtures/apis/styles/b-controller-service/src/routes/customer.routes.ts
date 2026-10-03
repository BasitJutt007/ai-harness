import { Router } from 'express';
import type { CustomerController } from '../controllers/customer.controller.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';

export function customerRoutes(controller: CustomerController): Router {
  const router = Router();
  router.get('/', controller.list);
  router.post('/', requireIdempotencyKey, controller.create);
  router.get('/:customerId', controller.getById);
  router.patch('/:customerId', requireIdempotencyKey, controller.update);
  router.delete('/:customerId', controller.remove);
  return router;
}
