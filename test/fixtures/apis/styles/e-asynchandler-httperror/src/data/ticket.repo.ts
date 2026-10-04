import { randomUUID } from 'node:crypto';
import type { Ticket } from '../schemas/ticket.schema.ts';

export class TicketRepo {
  private readonly rows: Ticket[] = [];
  /** The response of each keyed insert, as first sent: a retry replays it even after the ticket changed. */
  private readonly keys = new Map<string, Ticket>();
  private readonly updates = new Map<string, Ticket>();

  async insert(input: Pick<Ticket, 'subject' | 'priority'>, key: string): Promise<{ ticket: Ticket; replayed: boolean }> {
    const prior = this.keys.get(key);
    if (prior !== undefined) return { ticket: prior, replayed: true };
    const ticket: Ticket = { id: randomUUID(), status: 'open', ...input };
    this.rows.push(ticket);
    this.keys.set(key, { ...ticket });
    return { ticket, replayed: false };
  }
  async byId(id: string): Promise<Ticket | undefined> {
    return this.rows.find((t) => t.id === id);
  }
  async page(after: string | undefined, limit: number, status?: Ticket['status']): Promise<{ data: Ticket[]; nextCursor: string | null }> {
    const rows = this.rows.filter((t) => status === undefined || t.status === status);
    const start = after === undefined ? 0 : rows.findIndex((t) => t.id === after) + 1;
    const data = rows.slice(start, start + limit);
    const last = data.at(-1);
    return { data, nextCursor: last !== undefined && start + limit < rows.length ? last.id : null };
  }
  /** Set the status; the same Idempotency-Key again returns the ticket as that first update left it. */
  async setStatus(id: string, status: Ticket['status'], key: string): Promise<Ticket | undefined> {
    const prior = this.updates.get(`${id} ${key}`);
    if (prior !== undefined) return prior;
    const t = this.rows.find((r) => r.id === id);
    if (t !== undefined) {
      t.status = status;
      this.updates.set(`${id} ${key}`, { ...t });
    }
    return t;
  }
}
