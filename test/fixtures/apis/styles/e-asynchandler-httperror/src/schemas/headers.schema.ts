import { z } from 'zod';

export const idempotencyHeaders = z.object({ 'idempotency-key': z.string().uuid() });
