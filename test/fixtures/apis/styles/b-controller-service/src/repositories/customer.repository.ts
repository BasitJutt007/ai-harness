import type { Customer } from '../schemas/customer.schema.js';

/** Persistence port; the in-memory adapter below is swapped for a DB adapter in production. */
export interface CustomerRepository {
  findById(id: string): Promise<Customer | undefined>;
  findByEmail(email: string): Promise<Customer | undefined>;
  list(): Promise<Customer[]>;
  save(customer: Customer): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly rows = new Map<string, Customer>();
  async findById(id: string): Promise<Customer | undefined> {
    return this.rows.get(id);
  }
  async findByEmail(email: string): Promise<Customer | undefined> {
    return [...this.rows.values()].find((c) => c.email === email);
  }
  async list(): Promise<Customer[]> {
    return [...this.rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async save(customer: Customer): Promise<void> {
    this.rows.set(customer.id, customer);
  }
  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}
