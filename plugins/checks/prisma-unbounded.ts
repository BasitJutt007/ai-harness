/**
 * prisma-unbounded (nestjs; orm): every Prisma `findMany` is bounded. A findMany without `take` reads
 * every matching row, so a list endpoint becomes a full table scan per request as the table grows.
 *
 * The habit it encodes (docs/workflow.md, What breaks 4): unbounded queries (findMany with no take,
 * in-memory filters over growing tables, a full scan per request) flagged in review more than once.
 *
 * Bounded: an explicit `take` in the call's argument, or a `where` on `id` (equality or `in`: at most
 * as many rows as ids given). Everything else is a violation, including a call whose bound the check
 * cannot see (an argument that is not an object literal, a spread without an explicit take): fail
 * closed per call, never a skip, so one opaque call cannot make the rule unproven. Like every
 * non-standards rule it blocks only what a run introduces (the standards gate compares with the base
 * commit); the base's own calls are listed as pre-existing, not blocking. One-off jobs (files under
 * scripts/, seed/ or migrations/) are not per-request code and are not counted.
 */
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';

const RULE = 'prisma-unbounded';
const ONE_OFF = /(^|\/)(scripts?|seeds?|migrations?)\//;

const DOC = `prisma-unbounded: every findMany is bounded.
- Give each findMany a take (with skip or a cursor for pages), or select by id:
  { where: { id } } or { where: { id: { in: ids } } }.
- Write take in the call itself: a take inside a variable or a spread cannot be seen.
Example:
  this.prisma.order.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset })`;

function nameOf(p: ts.ObjectLiteralElementLike): string | null {
  if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
    const n = p.name;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  }
  return null;
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  return x;
}

/** where: { id } / { id: x } / { id: { in: ids } } / { id: { equals: x } }: at most as many rows as ids. */
function boundedById(where: ts.Expression): boolean {
  const w = unwrap(where);
  if (!ts.isObjectLiteralExpression(w)) return false;
  const id = w.properties.find((p) => nameOf(p) === 'id');
  if (id === undefined) return false;
  if (ts.isShorthandPropertyAssignment(id)) return true;
  if (!ts.isPropertyAssignment(id)) return false;
  const v = unwrap(id.initializer);
  if (ts.isObjectLiteralExpression(v)) return v.properties.some((p) => nameOf(p) === 'in' || nameOf(p) === 'equals');
  return true;
}

/** Why a findMany call is unbounded, or null when it is bounded. The text carries no line number (the baseline matches by message). */
export function unboundedReason(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  const callee = call.expression.getText(sf).replace(/\s+/g, '');
  const arg = call.arguments[0];
  if (arg === undefined) return `${callee}() has no arguments: it reads every row`;
  const o = unwrap(arg);
  if (!ts.isObjectLiteralExpression(o)) return `${callee}(${arg.getText(sf).slice(0, 40)}): the argument is not an object literal, so no take can be seen; write take in the call`;
  if (o.properties.some((p) => nameOf(p) === 'take')) return null;
  const where = o.properties.find((p) => nameOf(p) === 'where');
  if (where !== undefined && ts.isPropertyAssignment(where) && boundedById(where.initializer)) return null;
  if (where !== undefined && ts.isShorthandPropertyAssignment(where)) return `${callee}({ where }) without take: the where is a variable, so no bound can be seen`;
  if (o.properties.some((p) => ts.isSpreadAssignment(p))) return `${callee}({ ...spread }) without an explicit take: a take inside the spread cannot be seen`;
  return `${callee}() without take: it reads every matching row, a full scan per request as the table grows`;
}

/** Every `<x>.findMany(...)` call in a file, with its verdict. */
export function findManyCalls(file: string, text: string): Array<{ line: number; column: number; reason: string | null }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; column: number; reason: string | null }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const method = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isElementAccessExpression(c) && ts.isStringLiteral(c.argumentExpression) ? c.argumentExpression.text : null;
      if (method === 'findMany') {
        const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        out.push({ line: pos.line + 1, column: pos.character + 1, reason: unboundedReason(n, sf) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  for (const file of ctx.sourceFiles) {
    if (ONE_OFF.test(file)) continue;
    const text = await ctx.read(file);
    if (!text.includes('findMany')) continue;
    const calls = findManyCalls(file, text);
    if (calls.length === 0) continue;
    const violations: Violation[] = calls.filter((c) => c.reason !== null).map((c) => ({ location: `${file}:${c.line}:${c.column}`, message: c.reason ?? '' }));
    findings.push({ rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed: calls.length - violations.length, total: calls.length }, violations });
  }
  if (findings.length === 0) return [{ rule: RULE, file: '(project)', status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: 'no Prisma findMany call in per-request code' }];
  return findings;
}

export default defineCheck({
  id: RULE,
  stacks: ['nestjs'],
  category: 'orm',
  description: 'Every Prisma findMany is bounded: an explicit take, or a where on id; a bound the check cannot see is a violation.',
  unit: 'queries',
  doc: DOC,
  run,
});
