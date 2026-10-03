import { randomUUID } from 'node:crypto';
import { DuplicateEntityError, EntityNotFoundError, InvalidCursorError } from '../errors/domain-errors.js';
import type { CustomerRepository } from '../repositories/customer.repository.js';
import type { CreateCustomerInput, Customer, CustomerList, ListCustomersQuery, UpdateCustomerInput } from '../schemas/customer.schema.js';

export class CustomerService {
  constructor(private readonly repo: CustomerRepository) {}

  async list(query: ListCustomersQuery): Promise<CustomerList> {
    const all = (await this.repo.list()).filter((c) => query.email === undefined || c.email === query.email);
    let start = 0;
    if (query.cursor !== undefined) {
      const idx = all.findIndex((c) => c.id === query.cursor);
      if (idx === -1) throw new InvalidCursorError();
      start = idx + 1;
    }
    const items = all.slice(start, start + query.limit);
    const last = items.at(-1);
    return { items, nextCursor: last !== undefined && start + query.limit < all.length ? last.id : null };
  }

  async get(id: string): Promise<Customer> {
    const customer = await this.repo.findById(id);
    if (customer === undefined) throw new EntityNotFoundError('customer', id);
    return customer;
  }

  async create(input: CreateCustomerInput): Promise<Customer> {
    if ((await this.repo.findByEmail(input.email)) !== undefined) throw new DuplicateEntityError('customer', 'email');
    const customer: Customer = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    await this.repo.save(customer);
    return customer;
  }

  async update(id: string, patch: UpdateCustomerInput): Promise<Customer> {
    const current = await this.get(id);
    if (patch.email !== undefined && patch.email !== current.email && (await this.repo.findByEmail(patch.email)) !== undefined) {
      throw new DuplicateEntityError('customer', 'email');
    }
    const next: Customer = { ...current, ...patch };
    await this.repo.save(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) throw new EntityNotFoundError('customer', id);
  }
}
