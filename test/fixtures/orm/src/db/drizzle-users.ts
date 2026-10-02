// Drizzle queries on users: five violations, three compliant queries.
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from './client.ts';
import { users } from './schema.ts';

export async function listUsersBad() {
  return db.select().from(users); // VIOLATION drizzle-bare-select
}

export async function listUsersAllColumns() {
  return db.select(getTableColumns(users)).from(users); // VIOLATION drizzle-table-columns
}

export async function findUserBad(id: string) {
  return db.query.users.findFirst({ where: eq(users.id, id) }); // VIOLATION drizzle-relational
}

export async function rawBad() {
  return db.execute(sql`SELECT * FROM users`); // VIOLATION raw-select-star
}

export async function listUsersGood() {
  return db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, 'a@b.c'));
}

export async function findUserGood(id: string) {
  return db.query.users.findMany({ columns: { id: true, email: true }, where: eq(users.id, id) });
}

export async function createUserGood(email: string) {
  return db.insert(users).values({ email, passwordHash: 'x' }).returning({ id: users.id });
}

export async function deleteUserBad(id: string) {
  return db.delete(users).where(eq(users.id, id)).returning(); // VIOLATION drizzle-returning
}
