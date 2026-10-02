import { randomUUID } from 'node:crypto';
import { paginate } from '../../lib/pagination.ts';
import type { CursorQuery } from '../../lib/pagination.ts';
import { conflict, notFound } from '../../lib/problem.ts';
import type { NewUser, User, UserPatch } from './user.model.ts';

export function createUserService() {
  const byId = new Map<string, User>();
  const unique = (email: string, id?: string): void => {
    if ([...byId.values()].some((u) => u.email === email && u.id !== id)) throw conflict(`email ${email} already exists`);
  };
  return {
    async list(q: CursorQuery) {
      return paginate([...byId.values()], q, (u) => u.id);
    },
    async get(id: string): Promise<User> {
      const user = byId.get(id);
      if (user === undefined) throw notFound(`user ${id} not found`);
      return user;
    },
    async create(input: NewUser): Promise<User> {
      unique(input.email);
      const now = new Date().toISOString();
      const user: User = { id: randomUUID(), role: 'member', ...input, createdAt: now, updatedAt: now };
      byId.set(user.id, user);
      return user;
    },
    async update(id: string, patch: UserPatch): Promise<User> {
      const user = await this.get(id);
      if (patch.email !== undefined) unique(patch.email, id);
      const next: User = { ...user, ...patch, updatedAt: new Date().toISOString() };
      byId.set(id, next);
      return next;
    },
    async remove(id: string): Promise<void> {
      if (!byId.delete(id)) throw notFound(`user ${id} not found`);
    },
  };
}
export type UserService = ReturnType<typeof createUserService>;
