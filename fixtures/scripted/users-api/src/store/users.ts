import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import { conflict } from '../lib/problem.ts';
import type { CreateUser, ListUsersQuery, UpdateUser, User, UserPage } from '../schemas/user.ts';

/** In-memory user store, ordered by creation time (ties broken by id). Emails are unique, case-insensitively. */
const users = new Map<string, User>();

const sortKey = (user: User): string => `${user.createdAt}|${user.id}`;

function assertEmailFree(email: string, exceptId?: string): void {
  const wanted = email.toLowerCase();
  for (const user of users.values()) {
    if (user.id !== exceptId && user.email.toLowerCase() === wanted) {
      throw conflict(`a user with email ${email} already exists`);
    }
  }
}

export function listUsers(query: ListUsersQuery): UserPage {
  return paginate([...users.values()], query, sortKey);
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function createUser(input: CreateUser): User {
  assertEmailFree(input.email);
  const now = new Date().toISOString();
  const user: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
  users.set(user.id, user);
  return user;
}

export function updateUser(id: string, patch: UpdateUser): User | undefined {
  const current = users.get(id);
  if (current === undefined) return undefined;
  if (patch.email !== undefined) assertEmailFree(patch.email, id);
  const updated: User = { ...current, ...patch, updatedAt: new Date().toISOString() };
  users.set(id, updated);
  return updated;
}

export function removeUser(id: string): boolean {
  return users.delete(id);
}
