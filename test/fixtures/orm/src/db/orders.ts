// Queries on other tables are out of the rule's scope: no finding for this file.
import { db } from './client.ts';
import { orders } from './schema.ts';

export async function listOrders() {
  return db.select().from(orders);
}
