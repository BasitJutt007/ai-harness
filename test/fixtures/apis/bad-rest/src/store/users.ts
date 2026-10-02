import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.js';
import { conflict } from '../lib/problem.js';
import type { CreateUser, ListUsersQuery, UpdateUser, User } from '../schemas/users.js';

export function createUserStore() {
  const users = new Map<string, User>();

  const assertUniqueEmail = (email: string, exceptId?: string): void => {
    for (const u of users.values()) {
      if (u.email === email && u.id !== exceptId) throw conflict(`a user with email ${email} already exists`);
    }
  };

  return {
    list(query: ListUsersQuery) {
      const all = [...users.values()].filter((u) => query.role === undefined || u.role === query.role);
      return paginate(all, query, (u) => u.id);
    },
    all(): User[] {
      return [...users.values()];
    },
    get(id: string): User | undefined {
      return users.get(id);
    },
    create(input: CreateUser): User {
      assertUniqueEmail(input.email);
      const now = new Date().toISOString();
      const user: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
      users.set(user.id, user);
      return user;
    },
    update(id: string, patch: UpdateUser): User | undefined {
      const current = users.get(id);
      if (current === undefined) return undefined;
      if (patch.email !== undefined) assertUniqueEmail(patch.email, id);
      const next: User = { ...current, ...patch, updatedAt: new Date().toISOString() };
      users.set(id, next);
      return next;
    },
    remove(id: string): boolean {
      return users.delete(id);
    },
  };
}
