import { randomUUID } from 'node:crypto';
import { paginate } from '../lib/pagination.ts';
import type { CursorQuery } from '../lib/pagination.ts';
import { conflict } from '../lib/problem.ts';
import type { CreateUserRequest, UpdateUserRequest, UserRecord } from './users.schema.ts';

const records = new Map<string, UserRecord>();

const normalize = (email: string): string => email.trim().toLowerCase();

function assertFree(email: string, id?: string): void {
  const n = normalize(email);
  for (const r of records.values()) if (r.emailNormalized === n && r.id !== id) throw conflict(`${email} is already registered`);
}

export const usersStore = {
  page: (q: CursorQuery) => paginate([...records.values()], q, (r) => r.id),
  byId: (id: string): UserRecord | undefined => records.get(id),
  add(input: CreateUserRequest): UserRecord {
    assertFree(input.email);
    const now = new Date().toISOString();
    const rec: UserRecord = { id: randomUUID(), ...input, emailNormalized: normalize(input.email), createdAt: now, updatedAt: now };
    records.set(rec.id, rec);
    return rec;
  },
  change(id: string, input: UpdateUserRequest): UserRecord | undefined {
    const rec = records.get(id);
    if (rec === undefined) return undefined;
    if (input.email !== undefined) assertFree(input.email, id);
    const next: UserRecord = {
      ...rec,
      ...input,
      emailNormalized: normalize(input.email ?? rec.email),
      updatedAt: new Date().toISOString(),
    };
    records.set(id, next);
    return next;
  },
  drop: (id: string): boolean => records.delete(id),
};
