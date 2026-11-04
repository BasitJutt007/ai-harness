/**
 * Stack profiles (assignment 02): the NestJS and React checks and the Nest route lock, each with the
 * case that must not pass next to the legitimate twin.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import nestRouteGuard from '../../plugins/checks/nest-route-guard.ts';
import repoTypecheck, { projectsOf } from '../../plugins/checks/repo-typecheck.ts';
import routeLock from '../../plugins/gates/route-lock.ts';
import { isAdminFacing, routeKey, routesOf } from '../../plugins/lib/nest-routes.ts';
import { writePolicy } from '../../plugins/lib/path-policy.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type { BrownfieldTask, CheckContext, RunContext } from '../../src/core/types.ts';

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
@Controller('admin/badges')
export class AdminBadgesController {
  @Get(':id') find(@Param('id') id: string) { return id; }
  @AdminOnly() @Post() create() { return 1; }
}
@AdminOnly()
@Controller('admins')
export class AdminsController { @Get() list() { return []; } }
@Controller('vendors')
export class VendorsController {
  @Get(':vendorId/badges') badges() { return []; }
  @Public() @Get('health') health() { return 'ok'; }
  @Get(PATH) dynamic() { return 1; }
}`;

describe('NestJS routes from decorators', () => {
  it('joins controller and method paths, keeps decorators, and marks unreadable paths unknown', () => {
    const routes = routesOf('src/a.controller.ts', CONTROLLER);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /admin/badges/:id', 'POST /admin/badges', 'GET /admins', 'GET /vendors/:vendorId/badges', 'GET /vendors/health', 'GET (unknown)']);
    expect(routes.at(-1)?.unknown).toMatch(/not a string literal/);
    expect(routeKey({ method: 'GET', path: '/a/:id' })).toBe(routeKey({ method: 'GET', path: '/a/:badgeId' }));
    expect(isAdminFacing({ ...routes[3]!, file: 'src/modules/users/admin/x.controller.ts' })).toBe(true);
  });
});

function checkCtx(root: string, files: string[]): CheckContext {
  return { root, sourceFiles: files, testFiles: [], read: async (rel: string) => (await import('node:fs')).readFileSync(join(root, rel), 'utf8'), exec, harnessRoot: HARNESS_ROOT, logs: { write: async () => 'x' } } as unknown as CheckContext;
}

describe('nest-route-guard: who may call each route', () => {
  it('flags an admin route without @AdminOnly and a @Public route; passes the guarded twins', async () => {
    const root = tmp();
    put(root, { 'src/a.controller.ts': CONTROLLER.replace("@Get(PATH) dynamic() { return 1; }", '') });
    const [f] = await nestRouteGuard.run(checkCtx(root, ['src/a.controller.ts']));
    expect(f?.status).toBe('fail');
    expect(f?.violations.map((v) => v.message)).toEqual([
      'GET /admin/badges/:id (AdminBadgesController.find) is admin-facing without @AdminOnly(): any signed-in user can call it',
      'GET /vendors/health (VendorsController.health) is @Public: callable without authentication',
    ]);
    expect(f?.units).toEqual({ passed: 3, total: 5 });
  });

  it('is UNPROVEN (skip) when a route path cannot be read', async () => {
    const root = tmp();
    put(root, { 'src/a.controller.ts': CONTROLLER });
    const [f] = await nestRouteGuard.run(checkCtx(root, ['src/a.controller.ts']));
    expect(f?.status).toBe('skip');
    expect(f?.skipReason).toMatch(/not a string literal/);
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
    put(root, { 'src/a.controller.ts': "@Controller('vendors') export class V { @Get(':id') one() {} @Delete(':id') remove() {} }" });
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
    const r = await lock("@Controller('vendors') export class V { @Get(':id') one() {} }");
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(['removed: DELETE /vendors/:param (src/a.controller.ts:1 V.remove)']);
  });

  it('passes a renamed parameter and an added route (the twins), listing the addition', async () => {
    const r = await lock("@Controller('vendors') export class V { @Get(':vendorId') one() {} @Delete(':vendorId') remove() {} @Post() add() {} }");
    expect(r.status).toBe('pass');
    expect(r.details).toEqual(['added: POST /vendors (src/a.controller.ts:1)']);
    expect(r.humanMustVerify?.[0]).toMatch(/shapes are not compared/);
  });

  it('is UNPROVEN on an unreadable path; a removal the task allows passes, named', async () => {
    expect((await lock("@Controller(P) export class V { @Get(':id') one() {} }")).status).toBe('unproven');
    const allowed = await lock("@Controller('vendors') export class V { @Get(':id') one() {} }", true);
    expect(allowed.status).toBe('pass');
    expect(allowed.humanMustVerify?.join(' ')).toMatch(/removed routes allowed by the task: DELETE \/vendors\/:param/);
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
    expect(systemPrompt({ task, checks: [], tools: [], stack: 'react-vite' })).toMatch(/node:test: put them under test\//);
    expect(systemPrompt({ task, checks: [], tools: [] })).toMatch(/^You implement TypeScript REST APIs \(Express 5/);
    expect(nest).toMatch(/any edit before the item's contract is complete and approved/);
    const parse = parseContract('Problem: Lists go stale.\nOwner: o\nStakeholder: S\nRepo: a/b\nBase: main\nMetric: m, w before: ____ after: ____\nMeasure: node metrics/m.mjs\nScenario: WHEN a THEN b\nNot included: c\n');
    const brief = taskBrief(task, { tree: '', contract: { slug: 'x', parse } });
    expect(brief).toMatch(/Contract docs\/contracts\/x\.md, approved by S \(build exactly this\):\nProblem: Lists go stale\.\nScenario: WHEN a THEN b\nNot included \(do not build\):\n- c\nMetric \(read by the harness after the merge, not by you\): m/);
  });
});
