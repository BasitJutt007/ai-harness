/**
 * The example ORM validator and linter rule, run directly against the parse-only
 * fixture (test/fixtures/orm) and the brownfield sample, through the core's own
 * CheckContext (same file lists and parser as `harness check`).
 */
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import type { CheckContext, CheckFinding } from '../../src/core/types.ts';
import noConsole, { consoleViolations } from '../../examples/plugins/checks/no-console.ts';
import ormCheck, { collectUserQueries } from '../../examples/plugins/checks/orm-explicit-columns.ts';
import { markerLines, memoryLogs, ORM_FIXTURE, SAMPLE_API } from './_helpers.ts';

function ctxFor(root: string): Promise<CheckContext> {
  return createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
}

function lines(findings: CheckFinding[], file: string): number[] {
  return findings.filter((f) => f.file === file).flatMap((f) => f.violations).map((v) => Number(v.location.split(':')[1]));
}

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('/x/src/q.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function verdicts(code: string): boolean[] {
  return collectUserQueries(parse(code)).map((q) => q.ok);
}

describe('orm-explicit-columns (example ORM validator)', () => {
  it('flags every Drizzle and Prisma violation in the fixture at the right line', async () => {
    const findings = await ormCheck.run(await ctxFor(ORM_FIXTURE));
    const drizzle = 'src/db/drizzle-users.ts';
    const prisma = 'src/db/prisma-users.ts';
    expect(findings.map((f) => f.file).sort()).toEqual([drizzle, prisma]);
    expect(lines(findings, drizzle)).toEqual(markerLines(join(ORM_FIXTURE, drizzle), 'VIOLATION'));
    expect(lines(findings, prisma)).toEqual(markerLines(join(ORM_FIXTURE, prisma), 'VIOLATION'));
    const d = findings.find((f) => f.file === drizzle);
    expect(d).toMatchObject({ rule: 'orm-explicit-columns', status: 'fail', units: { passed: 3, total: 8 } });
    const p = findings.find((f) => f.file === prisma);
    expect(p).toMatchObject({ status: 'fail', units: { passed: 3, total: 6 } });
    for (const v of findings.flatMap((f) => f.violations)) expect(v.location).toMatch(/^src\/db\/[a-z-]+\.ts:\d+:\d+$/);
  });

  it('ignores other tables and in-memory Map stores (no finding for those files)', async () => {
    const findings = await ormCheck.run(await ctxFor(ORM_FIXTURE));
    for (const f of ['src/db/orders.ts', 'src/store/memory.ts', 'src/db/schema.ts']) expect(findings.some((x) => x.file === f)).toBe(false);
  });

  it('emits no findings for an API without ORM usage (reported n/a, not a vacuous pass)', async () => {
    expect(await ormCheck.run(await ctxFor(SAMPLE_API))).toEqual([]);
  });

  it('classifies the documented shapes', () => {
    expect(verdicts('db.select().from(users);')).toEqual([false]);
    expect(verdicts('db.selectDistinct().from(schema.users);')).toEqual([false]);
    expect(verdicts('db.select({ id: users.id }).from(usersTable);')).toEqual([true]);
    expect(verdicts('db.select(cols).from(users).where(x);')).toEqual([true]);
    expect(verdicts('db.select().from(orders);')).toEqual([]);
    expect(verdicts('Array.from(users);')).toEqual([]);
    expect(verdicts('db.query.users.findMany();')).toEqual([false]);
    expect(verdicts('db.query.users.findFirst({ columns: { id: true } });')).toEqual([true]);
    expect(verdicts('db.update(users).set(v).returning();')).toEqual([false]);
    expect(verdicts('db.update(users).set(v).returning({ id: users.id });')).toEqual([true]);
    expect(verdicts('prisma.user.findFirst({ where: { id } });')).toEqual([false]);
    expect(verdicts('prisma.user.findMany(args);')).toEqual([false]);
    expect(verdicts('this.prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true } });')).toEqual([true]);
    expect(verdicts('tx.user.upsert({ where: { id }, create: c, update: u });')).toEqual([false]);
    expect(verdicts('this.users.delete(id); this.users.get(id);')).toEqual([]);
    expect(verdicts('prisma.order.findMany();')).toEqual([]);
    expect(verdicts('prisma.$queryRaw`select * from "public"."users" where id = ${id}`;')).toEqual([false]);
    expect(verdicts('sql`SELECT id, email FROM users`;')).toEqual([]);
    expect(verdicts('sql`SELECT * FROM user_roles`;')).toEqual([]);
  });
});

describe('no-console (example linter rule)', () => {
  it('reports one line per source file, failing files with each call location', async () => {
    const findings = await noConsole.run(await ctxFor(ORM_FIXTURE));
    const debug = findings.find((f) => f.file === 'src/routes/debug.ts');
    expect(debug).toEqual({
      rule: 'no-console', file: 'src/routes/debug.ts', status: 'fail', units: { passed: 0, total: 1 },
      violations: [{ location: 'src/routes/debug.ts:3:3', message: 'console.log(...): remove it or use the app logger' }],
    });
    expect(findings.filter((f) => f.status === 'pass').every((f) => f.units.passed === 1 && f.units.total === 1)).toBe(true);
    expect(findings.some((f) => f.file === 'src/server.ts')).toBe(false); // the entrypoint is exempt
  });

  it('passes the brownfield sample (console.error in the 5xx handler is allowed)', async () => {
    const findings = await noConsole.run(await ctxFor(SAMPLE_API));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.status === 'pass')).toBe(true);
  });

  it('catches console.x, console["x"] and globalThis.console.x; allows error/warn', () => {
    const sf = parse('console.info(1);\nconsole["debug"](2);\nglobalThis.console.table(3);\nconsole.error(4);\nconsole.warn(5);\nlogger.log(6);\n');
    expect(consoleViolations(sf, 'src/q.ts').map((v) => v.location)).toEqual(['src/q.ts:1:1', 'src/q.ts:2:1', 'src/q.ts:3:1']);
  });
});
