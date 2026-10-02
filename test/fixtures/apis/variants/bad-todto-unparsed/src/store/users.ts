import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import type { CursorQuery } from '../lib/pagination.ts';
import { conflict } from '../lib/problem.ts';
import type { CreateUser, UpdateUser, User } from '../schemas/users.ts';

const users = new Map<string, User>();

function assertUnique(email: string, id?: string): void {
  for (const u of users.values()) if (u.email === email && u.id !== id) throw conflict(`email ${email} is taken`);
}

export const store = {
  list: (q: CursorQuery) => paginate([...users.values()], q, (u) => u.id),
  get: (id: string): User | undefined => users.get(id),
  create(input: CreateUser): User {
    assertUnique(input.email);
    const now = new Date().toISOString();
    const user: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    users.set(user.id, user);
    return user;
  },
  update(id: string, patch: UpdateUser): User | undefined {
    const cur = users.get(id);
    if (cur === undefined) return undefined;
    if (patch.email !== undefined) assertUnique(patch.email, id);
    const next: User = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    users.set(id, next);
    return next;
  },
  remove: (id: string): boolean => users.delete(id),
};
