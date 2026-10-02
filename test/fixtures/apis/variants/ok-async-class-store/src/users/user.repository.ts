import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import { conflict } from '../lib/problem.ts';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody, User } from './user.schemas.ts';

export class UserRepository {
  private readonly users = new Map<string, User>();

  async list(query: ListUsersQuery): Promise<{ data: User[]; nextCursor: string | null }> {
    const rows = [...this.users.values()].filter((u) => query.role === undefined || u.role === query.role);
    return paginate(rows, query, (u) => `${u.createdAt}|${u.id}`);
  }

  async findById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async create(input: CreateUserBody): Promise<User> {
    await this.ensureEmailFree(input.email);
    const now = new Date().toISOString();
    const user: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.users.set(user.id, user);
    return user;
  }

  async update(id: string, patch: UpdateUserBody): Promise<User | undefined> {
    const existing = this.users.get(id);
    if (existing === undefined) return undefined;
    if (patch.email !== undefined) await this.ensureEmailFree(patch.email, id);
    const updated: User = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.users.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  private async ensureEmailFree(email: string, exceptId?: string): Promise<void> {
    for (const u of this.users.values()) {
      if (u.email === email && u.id !== exceptId) throw conflict(`email ${email} is already registered`);
    }
  }
}
