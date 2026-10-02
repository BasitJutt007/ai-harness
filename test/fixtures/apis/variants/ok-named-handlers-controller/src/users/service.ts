import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import type { CursorQuery } from '../lib/pagination.ts';
import { conflict } from '../lib/problem.ts';
import type { CreateUserBody, UpdateUserBody, User } from './schemas.ts';

export class UserService {
  readonly #users = new Map<string, User>();

  list(query: CursorQuery) {
    return paginate([...this.#users.values()], query, (u) => u.id);
  }

  get(id: string): User | undefined {
    return this.#users.get(id);
  }

  create(body: CreateUserBody): User {
    this.#assertUnique(body.email);
    const now = new Date().toISOString();
    const user = { id: randomUUID(), ...body, createdAt: now, updatedAt: now };
    this.#users.set(user.id, user);
    return user;
  }

  update(id: string, body: UpdateUserBody): User | undefined {
    const user = this.#users.get(id);
    if (user === undefined) return undefined;
    if (body.email !== undefined) this.#assertUnique(body.email, id);
    const updated = { ...user, ...body, updatedAt: new Date().toISOString() };
    this.#users.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.#users.delete(id);
  }

  #assertUnique(email: string, except?: string): void {
    for (const u of this.#users.values()) {
      if (u.email === email && u.id !== except) throw conflict(`email ${email} is taken`);
    }
  }
}
