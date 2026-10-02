import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import type { CursorQuery } from '../lib/pagination.ts';
import { conflict } from '../lib/problem.ts';
import type { CreateUserInput, UpdateUserInput, User } from '../schemas.ts';

const users = new Map<string, User>();

function emailTaken(email: string, ignoreId?: string): boolean {
  return [...users.values()].some((u) => u.email.toLowerCase() === email.toLowerCase() && u.id !== ignoreId);
}

export function listUsers(query: CursorQuery) {
  return paginate([...users.values()], query, (u) => u.id);
}

export function findUser(id: string): User | undefined {
  return users.get(id);
}

export function insertUser(input: CreateUserInput): User {
  if (emailTaken(input.email)) throw conflict(`A user with email ${input.email} already exists.`);
  const timestamp = new Date().toISOString();
  const user: User = { id: randomUUID(), ...input, createdAt: timestamp, updatedAt: timestamp };
  users.set(user.id, user);
  return user;
}

export function patchUser(id: string, input: UpdateUserInput): User | undefined {
  const current = users.get(id);
  if (current === undefined) return undefined;
  if (input.email !== undefined && emailTaken(input.email, id)) throw conflict(`A user with email ${input.email} already exists.`);
  const next: User = { ...current, ...input, updatedAt: new Date().toISOString() };
  users.set(id, next);
  return next;
}

export function deleteUser(id: string): boolean {
  return users.delete(id);
}
