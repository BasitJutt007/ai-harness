/**
 * Stack profiles (assignment 02): the NestJS and React checks and the Nest route lock, each with the
 * case that must not pass next to the legitimate twin.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import nestRouteGuard, { parseOptions } from '../../plugins/checks/nest-route-guard.ts';
import prismaUnbounded, { findManyCalls } from '../../plugins/checks/prisma-unbounded.ts';
import repoTypecheck, { projectsOf } from '../../plugins/checks/repo-typecheck.ts';
import routeLock from '../../plugins/gates/route-lock.ts';
import { decoratorOf, isAdminFacing, routeKey, routesOf } from '../../plugins/lib/nest-routes.ts';
import { writePolicy } from '../../plugins/lib/path-policy.ts';
import { runChecks } from '../../src/core/checks.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type { BrownfieldTask, CheckContext, CheckFinding, RunContext } from '../../src/core/types.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'stacks-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const CONTROLLER = `
import { Controller, Get, Post, Param } from '@nestjs/common';
@Controller('admin/reports')
export class AdminReportsController {
  @Get(':id') find(@Param('id') id: string) { return id; }
  @RequireAdmin() @Post() create() { return 1; }
}
@RequireAdmin()
@Controller('admins')
export class AdminsController { @Get() list() { return []; } }
@Controller('shops')
export class ShopsController {
  @Get(':shopId/reports') reports() { return []; }
  @SkipAuth() @Get('health') health() { return 'ok'; }
  @Get(PATH) dynamic() { return 1; }
}`;
/** The controller without the route whose path cannot be read. */
const READABLE = CONTROLLER.replace("@Get(PATH) dynamic() { return 1; }", '');
/** The decorator names of the codebase under test, as harness.config.json checkOptions would give them. */
const NAMES = { adminDecorators: ['RequireAdmin'], publicDecorators: ['SkipAuth'] };

describe('NestJS routes from decorators', () => {
  it('joins controller and method paths, keeps decorators, and marks unreadable paths unknown', () => {
    const routes = routesOf('src/a.controller.ts', CONTROLLER);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /admin/reports/:id', 'POST /admin/reports', 'GET /admins', 'GET /shops/:shopId/reports', 'GET /shops/health', 'GET (unknown)']);
    expect(routes.at(-1)?.unknown).toMatch(/not a string literal/);
    expect(routeKey({ method: 'GET', path: '/a/:id' })).toBe(routeKey({ method: 'GET', path: '/a/:reportId' }));
    expect(isAdminFacing({ ...routes[3]!, file: 'src/modules/users/admin/x.controller.ts' })).toBe(true);
  });

  it('decoratorOf finds a named decorator on the method or its class, and only the names asked for', () => {
    const routes = routesOf('src/a.controller.ts', READABLE);
    expect(routes.map((r) => decoratorOf(r, ['RequireAdmin']))).toEqual([null, 'RequireAdmin', 'RequireAdmin', null, null]);
    expect(routes.map((r) => decoratorOf(r, ['SkipAuth', 'Other']))).toEqual([null, null, null, null, 'SkipAuth']);
    expect(routes.map((r) => decoratorOf(r, []))).toEqual([null, null, null, null, null]);
  });
});

function checkCtx(root: string, files: string[], options?: Record<string, unknown>): CheckContext {
  return { root, sourceFiles: files, testFiles: [], read: async (rel: string) => (await import('node:fs')).readFileSync(join(root, rel), 'utf8'), exec, harnessRoot: HARNESS_ROOT, logs: { write: async () => 'x' }, ...(options !== undefined ? { options } : {}) } as unknown as CheckContext;
}

describe('nest-route-guard: who may call each route', () => {
  async function guard(text: string, options?: Record<string, unknown>): Promise<CheckFinding[]> {
    const root = tmp();
    put(root, { 'src/a.controller.ts': text });
    return nestRouteGuard.run(checkCtx(root, ['src/a.controller.ts'], options));
  }

  it('flags an admin route without the admin decorator and a public route; passes the guarded twins', async () => {
    const [f] = await guard(READABLE, NAMES);
    expect(f?.status).toBe('fail');
    expect(f?.violations.map((v) => v.message)).toEqual([
      'GET /admin/reports/:id (AdminReportsController.find) is admin-facing without @RequireAdmin(): any signed-in user can call it',
      'GET /shops/health (ShopsController.health) is @SkipAuth: callable without authentication',
    ]);
    expect(f?.units).toEqual({ passed: 3, total: 5 });
  });

  it('the decorator on the method or its class counts; a fixed controller passes', async () => {
    const fixed = READABLE.replace("@Get(':id') find", "@RequireAdmin() @Get(':id') find").replace("@SkipAuth() @Get('health')", "@Get('health')");
    expect(await guard(fixed, NAMES)).toEqual([{ rule: 'nest-route-guard', file: 'src/a.controller.ts', status: 'pass', units: { passed: 5, total: 5 }, violations: [] }]);
  });

  it('the names come from the configuration, not the code: a decorator nobody configured guards nothing', async () => {
    const [f] = await guard(READABLE, { adminDecorators: ['AdminGuarded'], publicDecorators: ['Anonymous'] });
    // @RequireAdmin is not configured here, so the create route it decorates is open too; @SkipAuth is not a public marker.
    expect(f?.violations.map((v) => v.message)).toEqual([
      'GET /admin/reports/:id (AdminReportsController.find) is admin-facing without @AdminGuarded(): any signed-in user can call it',
      'POST /admin/reports (AdminReportsController.create) is admin-facing without @AdminGuarded(): any signed-in user can call it',
    ]);
    const several = await guard(READABLE, { adminDecorators: ['AdminGuarded', 'RequireAdmin'] });
    expect(several[0]?.violations.map((v) => v.message)).toEqual([
      'GET /admin/reports/:id (AdminReportsController.find) is admin-facing without @AdminGuarded() or @RequireAdmin(): any signed-in user can call it',
    ]);
  });

  it('is n/a with the reason when no decorator names are configured, never a pass', async () => {
    const none = [{ rule: 'nest-route-guard', file: '(project)', status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: 'no access decorators configured: set adminDecorators and/or publicDecorators in harness.config.json checkOptions["nest-route-guard"]' }];
    expect(await guard(READABLE)).toEqual(none);
    expect(await guard(READABLE, {})).toEqual(none);
    expect(await guard(READABLE, { adminDecorators: [], publicDecorators: [] })).toEqual(none);
  });

  it('through the check runner: n/a without checkOptions, FAIL with them', async () => {
    const root = tmp();
    put(root, { 'src/a.controller.ts': READABLE });
    const base = { root, checks: [nestRouteGuard], exec, harnessRoot: HARNESS_ROOT, logs: { write: async () => 'x' }, stack: 'nestjs' as const };
    const without = await runChecks(base);
    expect(without.rules).toMatchObject([{ rule: 'nest-route-guard', status: 'n/a' }]);
    expect(without.text).toMatch(/nest-route-guard\s+n\/a\s+\(none\)\s+0\/0 routes\s+\(no access decorators configured/);
    const withOptions = await runChecks({ ...base, checkOptions: { 'nest-route-guard': NAMES } });
    expect(withOptions.rules).toMatchObject([{ rule: 'nest-route-guard', status: 'fail', passed: 3, total: 5 }]);
  });

  it('options it cannot read make it UNPROVEN (a typo never silently turns the rule off)', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ adminDecorator: ['RequireAdmin'] }, /adminDecorator/],
      [{ adminDecorators: 'RequireAdmin' }, /adminDecorators/],
      [{ adminDecorators: ['@RequireAdmin()'] }, /adminDecorators\.0: a decorator name without @ or \(\)/],
      [{ publicDecorators: [7] }, /publicDecorators\.0/],
    ];
    for (const [bad, why] of cases) {
      const [f] = await guard(READABLE, bad);
      expect(f?.status, JSON.stringify(bad)).toBe('skip');
      expect(f?.skipReason).toMatch(/^unreadable harness\.config\.json checkOptions\["nest-route-guard"\]: /);
      expect(f?.skipReason).toMatch(why);
    }
  });

  it('only public decorators configured: an admin-facing route is UNPROVEN; a controller without one is judged', async () => {
    const [admin] = await guard(READABLE, { publicDecorators: ['SkipAuth'] });
    expect(admin).toMatchObject({ status: 'skip', skipReason: 'GET /admin/reports/:id (AdminReportsController.find) is admin-facing, but no adminDecorators are configured in harness.config.json checkOptions["nest-route-guard"]' });
    const shops = "@Controller('shops') export class ShopsController { @Get(':id') one() {} @SkipAuth() @Get('health') health() {} }";
    const [f] = await guard(shops, { publicDecorators: ['SkipAuth'] });
    expect(f?.status).toBe('fail');
    expect(f?.violations.map((v) => v.message)).toEqual(['GET /shops/health (ShopsController.health) is @SkipAuth: callable without authentication']);
  });

  it('only admin decorators configured: admin-facing routes are judged; no decorator opens a route', async () => {
    const [f] = await guard(READABLE, { adminDecorators: ['RequireAdmin'] });
    expect(f?.violations.map((v) => v.message)).toEqual(['GET /admin/reports/:id (AdminReportsController.find) is admin-facing without @RequireAdmin(): any signed-in user can call it']);
    expect(f?.units).toEqual({ passed: 4, total: 5 });
  });

  it('is UNPROVEN (skip) when a route path cannot be read', async () => {
    const [f] = await guard(CONTROLLER, NAMES);
    expect(f?.status).toBe('skip');
    expect(f?.skipReason).toMatch(/not a string literal/);
  });

  it('the harness configuration names readable decorators for both kinds', () => {
    const parsed = parseOptions(loadConfig(HARNESS_ROOT).checkOptions['nest-route-guard']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options.adminDecorators.length).toBeGreaterThan(0);
      expect(parsed.options.publicDecorators.length).toBeGreaterThan(0);
    }
  });
});

describe('prisma-unbounded: every findMany is bounded', () => {
  const SERVICE = `
export class OrdersService {
  constructor(private prisma: any) {}
  all() { return this.prisma.order.findMany(); }
  mine(userId: string) { return this.prisma.order.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }); }
  page(userId: string, take: number, skip: number) { return this.prisma.order.findMany({ where: { userId }, take, skip }); }
  byIds(ids: string[]) { return this.prisma.order.findMany({ where: { id: { in: ids } } }); }
  one(id: string) { return this.prisma.order.findMany({ where: { id } }); }
  opaque(args: object) { return this.prisma.order.findMany(args); }
  spread(extra: object) { return this.prisma.order.findMany({ ...extra, where: { paid: false } }); }
  boundedSpread(extra: object) { return this.prisma.order.findMany({ ...extra, take: 20 }); }
  first(id: string) { return this.prisma.order.findFirst({ where: { id } }); }
}`;

  it('flags findMany without take (no arguments, a where, an opaque argument, a spread); passes take and id lookups', () => {
    const calls = findManyCalls('src/n.service.ts', SERVICE);
    expect(calls).toHaveLength(8);
    expect(calls.map((c) => c.reason === null)).toEqual([false, false, true, true, true, false, false, true]);
    expect(calls[0]?.reason).toMatch(/has no arguments: it reads every row/);
    expect(calls[1]?.reason).toMatch(/without take: it reads every matching row/);
    expect(calls[5]?.reason).toMatch(/not an object literal, so no take can be seen/);
    expect(calls[6]?.reason).toMatch(/inside the spread cannot be seen/);
  });

  it('reports per file in queries, never a skip; one-off jobs are not counted; nothing to check is n/a', async () => {
    const root = tmp();
    put(root, { 'src/n.service.ts': SERVICE, 'src/scripts/backfill.ts': 'prisma.user.findMany();\n', 'src/ok.service.ts': 'prisma.user.findMany({ take: 10 });\n' });
    const findings = await prismaUnbounded.run(checkCtx(root, ['src/n.service.ts', 'src/scripts/backfill.ts', 'src/ok.service.ts']));
    expect(findings.map((f) => [f.file, f.status, f.units])).toEqual([
      ['src/n.service.ts', 'fail', { passed: 4, total: 8 }],
      ['src/ok.service.ts', 'pass', { passed: 1, total: 1 }],
    ]);
    // The baseline comparison matches by message, so messages carry no line numbers.
    expect(findings[0]?.violations.every((v) => !/:\d+/.test(v.message))).toBe(true);
    const none = await prismaUnbounded.run(checkCtx(root, ['src/scripts/backfill.ts']));
    expect(none).toEqual([{ rule: 'prisma-unbounded', file: '(project)', status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: 'no Prisma findMany call in per-request code' }]);
  });
});

describe('repo-typecheck: the repository\'s own type check, never zero files', () => {
  function project(root: string, solution: boolean): void {
    symlinkSync(join(HARNESS_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    const app = { compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, types: [] }, include: ['src'] };
    put(root, {
      'src/a.ts': 'export function f(): string { return user; }\n',
      'tsconfig.app.json': JSON.stringify(app),
      'tsconfig.json': JSON.stringify(solution ? { files: [], references: [{ path: './tsconfig.app.json' }] } : app),
    });
  }

  it('a solution-style tsconfig (files: [] + references) is expanded: the error in the referenced project is found', async () => {
    const root = tmp();
    project(root, true);
    // tsc --noEmit on the solution config checks nothing and exits 0: the trap this check exists for.
    expect(() => execFileSync(process.execPath, [join(HARNESS_ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'], { cwd: root })).not.toThrow();
    expect(projectsOf(root).projects.map((p) => p.config.split('/').pop())).toEqual(['tsconfig.app.json']);
    const findings = await repoTypecheck.run(checkCtx(root, ['src/a.ts']));
    expect(findings.find((f) => f.file === 'src/a.ts')?.violations[0]?.message).toMatch(/TS2304: Cannot find name 'user'/);
    expect(findings.find((f) => f.file === '(project)')?.status).toBe('fail');
  });

  it('passes a clean project (the twin) and is UNPROVEN without a tsconfig', async () => {
    const root = tmp();
    project(root, false);
    writeFileSync(join(root, 'src/a.ts'), 'export function f(): string { return "ok"; }\n');
    expect((await repoTypecheck.run(checkCtx(root, ['src/a.ts']))).find((f) => f.file === '(project)')).toMatchObject({ status: 'pass', units: { passed: 1, total: 1 } });
    rmSync(join(root, 'tsconfig.json'));
    expect((await repoTypecheck.run(checkCtx(root, ['src/a.ts'])))[0]).toMatchObject({ status: 'skip', skipReason: 'no tsconfig.json at the repository root' });
  });
});

describe('route-lock: no base route disappears', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  }
  async function lock(after: string, allowBreaking = false): Promise<Awaited<ReturnType<typeof routeLock.run>>> {
    const root = tmp();
    put(root, { 'src/a.controller.ts': "@Controller('shops') export class V { @Get(':id') one() {} @Delete(':id') remove() {} }" });
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    const sha = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/a.controller.ts'), after);
    const task = { kind: 'brownfield', allowBreaking } as BrownfieldTask;
    const ctx = { task, workspace: createWorkspace(root, '.'), run: { baseSha: sha }, exec, logs: { write: async () => 'x' } } as unknown as RunContext;
    return routeLock.run(ctx, 'finish');
  }

  it('fails when a route is removed', async () => {
    const r = await lock("@Controller('shops') export class V { @Get(':id') one() {} }");
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(['removed: DELETE /shops/:param (src/a.controller.ts:1 V.remove)']);
  });

  it('passes a renamed parameter and an added route (the twins), listing the addition', async () => {
    const r = await lock("@Controller('shops') export class V { @Get(':shopId') one() {} @Delete(':shopId') remove() {} @Post() add() {} }");
    expect(r.status).toBe('pass');
    expect(r.details).toEqual(['added: POST /shops (src/a.controller.ts:1)']);
    expect(r.humanMustVerify?.[0]).toMatch(/shapes are not compared/);
  });

  it('is UNPROVEN on an unreadable path; a removal the task allows passes, named', async () => {
    expect((await lock("@Controller(P) export class V { @Get(':id') one() {} }")).status).toBe('unproven');
    const allowed = await lock("@Controller('shops') export class V { @Get(':id') one() {} }", true);
    expect(allowed.status).toBe('pass');
    expect(allowed.humanMustVerify?.join(' ')).toMatch(/removed routes allowed by the task: DELETE \/shops\/:param/);
  });
});

describe('write policy per stack', () => {
  const task = { kind: 'brownfield', scope: { allow: ['src/**'], deny: [] } } as unknown as BrownfieldTask;
  it('a .tsx component is writable only on a React target; config, lockfiles and dot-dirs never are', () => {
    expect(writePolicy(task, 'src/App.tsx', 'react-vite').allowed).toBe(true);
    expect(writePolicy(task, 'src/App.tsx', 'nestjs').allowed).toBe(false);
    expect(writePolicy(task, 'src/App.tsx').allowed).toBe(false);
    for (const f of ['eslint.config.mjs', 'vite.config.ts', 'package.json', '.vscode/settings.json', 'prisma/schema/a.prisma', 'src/.env']) {
      expect(writePolicy(task, f, 'react-vite').allowed, f).toBe(false);
    }
  });
});

describe('the prompt follows the stack and carries the approved contract', () => {
  it('names the stack the agent works in, never Express on a NestJS or React target', async () => {
    const { systemPrompt, taskBrief } = await import('../../src/core/prompt.ts');
    const { parseContract } = await import('../../src/core/items.ts');
    const task = { kind: 'brownfield', id: 'x', title: 'X', change: 'fix it', behaviours: [], limits: { maxOutputTokens: 1 }, target: '.', scope: { allow: ['src/**'], deny: [] }, allowBreaking: false } as unknown as BrownfieldTask;
    const nest = systemPrompt({ task, checks: [], tools: [], stack: 'nestjs' });
    expect(nest).toMatch(/^You change a NestJS \+ Prisma backend/);
    expect(nest).not.toMatch(/Express 5/);
    const react = systemPrompt({ task, checks: [], tools: [], stack: 'react-vite' });
    // The repository's runner first; node:test only where it has none. RTK Query rules only where it is used.
    expect(react).toMatch(/Tests run with the repository's own runner; where it has none, with node:test: put them under test\//);
    expect(react).toMatch(/With RTK Query, cache tags never cross createApi slices: .*a merge must replace a page that is fetched again, never append it twice\.$/m);
    expect(nest).toMatch(/never touch prisma\/ or the database/);
    expect(systemPrompt({ task, checks: [], tools: [] })).toMatch(/^You implement TypeScript REST APIs \(Express 5/);
    expect(nest).toMatch(/any edit before the item's contract is complete and approved/);
    const parse = parseContract('Problem: Lists go stale.\nOwner: o\nStakeholder: S\nRepo: a/b\nBase: main\nMetric: m, w before: ____ after: ____\nMeasure: node metrics/m.mjs\nScenario: WHEN a THEN b\nNot included: c\n');
    const brief = taskBrief(task, { tree: '', contract: { slug: 'x', parse } });
    expect(brief).toMatch(/Contract docs\/contracts\/x\.md, approved by S \(build exactly this\):\nProblem: Lists go stale\.\nScenario: WHEN a THEN b\nNot included \(do not build\):\n- c\nMetric \(read by the harness after the merge, not by you\): m/);
  });
});

describe('a generated Prisma client reaches the run worktree', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  }
  it('links an untracked generator output; never a tracked one or one outside the repository', async () => {
    const { prismaClientOutputs } = await import('../../src/core/target.ts');
    const { createWorktree } = await import('../../src/core/workspace.ts');
    const { loadConfig } = await import('../../src/core/config.ts');
    const root = tmp();
    put(root, {
      'prisma/schema/schema.prisma': 'generator client {\n  provider = "prisma-client-js"\n  output   = "../../generated/prisma"\n}\ngenerator docs {\n  output = "../../../outside"\n}\n',
      'prisma/schema/tracked.prisma': 'generator other {\n  output = "../../committed"\n}\n',
      'committed/index.ts': 'export const x = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      '.gitignore': 'generated/\n',
    });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    put(root, { 'generated/prisma/index.d.ts': 'export declare const client: number;\n' });
    expect(prismaClientOutputs(root, (rel) => rel === 'committed')).toEqual(['generated/prisma']);
    const harness = tmp();
    const wt = await createWorktree({ harnessRoot: harness, config: { ...loadConfig(), worktreeDir: 'wt' }, repoDir: root, runId: 'r1', branch: 'harness/r1' });
    const { lstatSync, readFileSync } = await import('node:fs');
    expect(lstatSync(join(wt.worktreeRoot, 'generated/prisma')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt.worktreeRoot, 'generated/prisma/index.d.ts'), 'utf8')).toMatch(/client/);
    expect(lstatSync(join(wt.worktreeRoot, 'committed')).isSymbolicLink()).toBe(false);
    git(root, 'worktree', 'remove', '--force', wt.worktreeRoot);
  });
});
