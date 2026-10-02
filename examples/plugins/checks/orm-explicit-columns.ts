/**
 * orm-explicit-columns (category "orm"): every Prisma or Drizzle query on the users
 * table must select explicit columns, so a new column (password hash, tokens, PII)
 * never leaks into a response by default.
 *
 * Drop-in: copy this file to plugins/checks/. Nothing else changes.
 *
 * Detected (TypeScript AST, no ORM packages needed):
 *   Drizzle  db.select().from(users)                      → needs a column map: db.select({ id: users.id }).from(users)
 *            db.select(getTableColumns(users)).from(users) → selects every column
 *            db.query.users.findMany() / findFirst()       → needs { columns: { … } }
 *            db.insert(users)….returning()                 → needs .returning({ id: users.id })
 *   Prisma   prisma.user.findMany/findFirst/findUnique (+ OrThrow)  → needs { select: { … } }
 *            create/update/upsert/delete/createManyAndReturn/updateManyAndReturn called with an inline
 *            { data } / { where } (so a Map's this.users.delete(id) is never mistaken for Prisma)
 *   Raw SQL  sql`SELECT * FROM users` / prisma.$queryRaw`SELECT * FROM users`
 * One finding per file that queries users (unit: queries), one violation per offending
 * call with file:line:col. An API with no such queries gets no findings → n/a.
 */
import ts from 'typescript';
import { defineCheck, fileFinding, hasProperty, lastName, nodeLocation, walk } from '../lib/plugin-helpers.ts';
import type { CheckContext, CheckFinding, Violation } from '../lib/plugin-helpers.ts';

const RULE = 'orm-explicit-columns';

/** Table / model names governed by the rule (compared lower-case, a trailing "table" ignored). */
const TABLES = new Set(['user', 'users']);
const DRIZZLE_SELECT = new Set(['select', 'selectDistinct', 'selectDistinctOn']);
const DRIZZLE_MUTATION = new Set(['insert', 'update', 'delete']);
const DRIZZLE_RELATIONAL = new Set(['findMany', 'findFirst']);
const PRISMA_ROW_METHODS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'create', 'update', 'upsert', 'delete', 'createManyAndReturn', 'updateManyAndReturn',
]);
const SELECT_STAR_USERS = /\bselect\s+(?:distinct\s+)?\*\s+from\s+[\w."`]*?\busers?\b/i;

const DOC = `${RULE} (category: orm, unit: queries)
Every Prisma or Drizzle query on the users table selects explicit columns:
- Drizzle: db.select({ id: users.id, email: users.email }).from(users), never db.select().from(users)
  or db.select(getTableColumns(users)); db.query.users.findMany({ columns: { id: true, email: true } });
  insert/update/delete(users).returning({ id: users.id }), never a bare .returning().
- Prisma: prisma.user.findMany({ select: { id: true, email: true } }) (also findFirst/findUnique/create/update/upsert/delete).
  include/omit alone is not an explicit column list.
- Raw SQL: no SELECT * FROM users.
APIs without ORM queries on users report n/a.`;

export interface UserQuery {
  node: ts.Node;
  ok: boolean;
  message: string;
}

function isUsersName(name: string | undefined): boolean {
  if (name === undefined) return false;
  const n = name.toLowerCase().replace(/_?table$/, '');
  return TABLES.has(n);
}

function isUsersTable(expr: ts.Expression | undefined): boolean {
  return expr !== undefined && isUsersName(lastName(expr));
}

/** `<recv>.<name>(...)` → { name, call } when `expr` is such a call. */
function methodCall(expr: ts.Expression): { name: string; call: ts.CallExpression; recv: ts.Expression } | undefined {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return undefined;
  return { name: expr.expression.name.text, call: expr, recv: expr.expression.expression };
}

function firstObjectArg(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  const a = call.arguments[0];
  return a !== undefined && ts.isObjectLiteralExpression(a) ? a : undefined;
}

/** Walk down a builder chain (`db.insert(users).values(v).onConflictDoNothing()`) to the insert/update/delete call. */
function mutationTarget(expr: ts.Expression): ts.Expression | undefined {
  let cur: ts.Expression = expr;
  for (let i = 0; i < 32; i++) {
    const m = methodCall(cur);
    if (m === undefined) return undefined;
    if (DRIZZLE_MUTATION.has(m.name)) return m.call.arguments[0];
    cur = m.recv;
  }
  return undefined;
}

function needs(call: ts.CallExpression, prop: string): { ok: boolean; why: string } {
  const obj = firstObjectArg(call);
  if (obj === undefined) {
    return { ok: false, why: call.arguments.length === 0 ? 'no arguments' : 'arguments are not an inline object, so the column list cannot be proven' };
  }
  return hasProperty(obj, prop) ? { ok: true, why: '' } : { ok: false, why: `no ${prop}` };
}

/**
 * Prisma writes always take `{ data }` / `{ where }`; a Map or Set (`this.users.delete(id)`) never
 * does. Requiring that shape keeps in-memory stores from being mistaken for ORM calls.
 */
function isPrismaWriteArgs(call: ts.CallExpression): boolean {
  const obj = firstObjectArg(call);
  return obj !== undefined && (hasProperty(obj, 'data') || hasProperty(obj, 'where'));
}

function classify(node: ts.Node): UserQuery | undefined {
  if (ts.isTaggedTemplateExpression(node)) {
    const text = node.template.getText();
    if (!SELECT_STAR_USERS.test(text)) return undefined;
    return { node, ok: false, message: 'raw SQL SELECT * on users: list the columns' };
  }
  if (!ts.isCallExpression(node)) return undefined;
  const m = methodCall(node);
  if (m === undefined) return undefined;

  // Drizzle core: db.select(...).from(users)
  if (m.name === 'from' && isUsersTable(node.arguments[0])) {
    const sel = methodCall(m.recv);
    if (sel === undefined || !DRIZZLE_SELECT.has(sel.name)) return undefined;
    const cols = sel.name === 'selectDistinctOn' ? sel.call.arguments[1] : sel.call.arguments[0];
    if (cols === undefined) return { node, ok: false, message: `drizzle ${sel.name}().from(users) without a column map: select({ id: users.id, … })` };
    if (ts.isCallExpression(cols) && lastName(cols.expression) === 'getTableColumns') {
      return { node, ok: false, message: `drizzle ${sel.name}(getTableColumns(…)) selects every column of users` };
    }
    return { node, ok: true, message: '' };
  }

  // Drizzle mutations: insert/update/delete(users)….returning()
  if (m.name === 'returning') {
    if (!isUsersTable(mutationTarget(m.recv))) return undefined;
    return node.arguments.length > 0
      ? { node, ok: true, message: '' }
      : { node, ok: false, message: 'drizzle .returning() on users without a column map: returning({ id: users.id, … })' };
  }

  // <x>.query.users.findMany(...) (Drizzle relational) or <x>.user.findMany(...) (Prisma)
  if (!ts.isPropertyAccessExpression(m.recv) || !isUsersName(m.recv.name.text)) return undefined;
  const model = m.recv.name.text;
  const owner = m.recv.expression;
  if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'query') {
    if (!DRIZZLE_RELATIONAL.has(m.name)) return undefined;
    const r = needs(node, 'columns');
    return r.ok ? { node, ok: true, message: '' } : { node, ok: false, message: `drizzle query.${model}.${m.name} without columns (${r.why}): pass { columns: { id: true, … } }` };
  }
  if (!PRISMA_ROW_METHODS.has(m.name)) return undefined;
  if (!m.name.startsWith('find') && !isPrismaWriteArgs(node)) return undefined; // e.g. this.users.delete(id) on a Map
  const r = needs(node, 'select');
  return r.ok ? { node, ok: true, message: '' } : { node, ok: false, message: `prisma ${model}.${m.name} without select (${r.why}): pass { select: { id: true, … } }` };
}

/** Every ORM query on users in a parsed file, in source order. */
export function collectUserQueries(sf: ts.SourceFile): UserQuery[] {
  const out: UserQuery[] = [];
  walk(sf, (n) => {
    const q = classify(n);
    if (q !== undefined) out.push(q);
  });
  return out;
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  for (const file of ctx.sourceFiles) {
    const text = await ctx.read(file);
    if (!/user/i.test(text)) continue; // cheapest mechanism first: most files never mention users
    const sf = ctx.sourceFile(file);
    const queries = collectUserQueries(sf);
    const violations: Violation[] = queries
      .filter((q) => !q.ok)
      .map((q) => ({ location: nodeLocation(sf, q.node, file), message: q.message }));
    const f = fileFinding(RULE, file, queries.length, violations);
    if (f !== null) findings.push(f);
  }
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'orm',
  description: 'Every Prisma or Drizzle query on users selects explicit columns (no bare select(), no findMany without select/columns, no SELECT *).',
  unit: 'queries',
  doc: DOC,
  run,
});
