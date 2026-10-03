import { randomUUID } from 'node:crypto';
import { unprocessable } from './lib/problem.ts';
import type { CreateOrder, ListOrdersQuery, Order, OrderPage } from './schemas.ts';

export class OrderStore {
  private readonly orders = new Map<string, Order>();

  create(input: CreateOrder): Order {
    const order: Order = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    this.orders.set(order.id, order);
    return order;
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  remove(id: string): boolean {
    return this.orders.delete(id);
  }

  list(query: ListOrdersQuery): OrderPage {
    const all = [...this.orders.values()].sort((a, b) => (a.createdAt + a.id).localeCompare(b.createdAt + b.id));
    let start = 0;
    if (query.cursor !== undefined) {
      const after = Buffer.from(query.cursor, 'base64url').toString('utf8');
      const idx = all.findIndex((o) => o.id === after);
      if (idx < 0) throw unprocessable('cursor: invalid cursor');
      start = idx + 1;
    }
    const data = all.slice(start, start + query.limit);
    const last = data.at(-1);
    const nextCursor = start + query.limit < all.length && last !== undefined ? Buffer.from(last.id, 'utf8').toString('base64url') : null;
    return { data, nextCursor };
  }
}
