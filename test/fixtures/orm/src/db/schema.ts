// Drizzle table definitions (parse-only fixture).
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
});
