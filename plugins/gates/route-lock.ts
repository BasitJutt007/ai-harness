/**
 * route-lock (nestjs, brownfield; finish and ship): a change keeps every route the base commit served,
 * unless the task allows breaking changes. Routes come from the controller decorators
 * (plugins/lib/nest-routes.ts) at the base commit (read from git, not a working tree) and in the run's
 * worktree; a route is METHOD + path with parameter names normalised, so renaming :id is no change.
 *   breaking  a base route that is gone (removed, renamed, or moved to another method or path);
 *   added     a new route (listed, never blocking; nest-route-guard judges who may call it);
 *   unproven  a route whose path is not a string literal on either side, or no routes on either side.
 *
 * The habit it encodes (docs/workflow.md, What breaks): backend changes the frontends did not match,
 * e.g. a removed route that answers 404 to a caller nobody checked. Response and DTO shapes are NOT
 * compared: the gate says so in every result, so a pass is never read as "the payloads did not change".
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { GateResult, RunContext } from '../../src/core/plugin-api.ts';
import { routeKey, routesOf, type NestRoute } from '../lib/nest-routes.ts';

const SHAPES = 'response and DTO shapes are not compared (human must verify the frontends still match)';

/** Routes of every controller file at the base commit, read with git show (nothing is checked out). */
async function baseRoutes(ctx: RunContext): Promise<NestRoute[] | { error: string }> {
  const { repoRoot, rootRel } = ctx.workspace;
  const prefix = rootRel === '' || rootRel === '.' ? '' : `${rootRel.replace(/\/+$/, '')}/`;
  const ls = await ctx.exec('git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', ctx.run.baseSha, '--', prefix === '' ? '.' : prefix], { cwd: repoRoot });
  if (ls.code !== 0) return { error: `git ls-tree ${ctx.run.baseSha.slice(0, 12)} failed: ${ls.stderr.trim()}` };
  const out: NestRoute[] = [];
  for (const path of ls.stdout.split('\n').map((l) => l.trim()).filter((l) => /\.ts$/.test(l) && !/\.(spec|test)\.ts$/.test(l) && !l.endsWith('.d.ts'))) {
    const show = await ctx.exec('git', ['-C', repoRoot, 'show', `${ctx.run.baseSha}:${path}`], { cwd: repoRoot });
    if (show.code !== 0) return { error: `git show ${path} failed: ${show.stderr.trim()}` };
    if (!show.stdout.includes('@Controller')) continue;
    out.push(...routesOf(prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path, show.stdout));
  }
  return out;
}

async function headRoutes(ctx: RunContext): Promise<NestRoute[]> {
  const out: NestRoute[] = [];
  for (const rel of await ctx.workspace.list(['**/*.ts'])) {
    if (/\.(spec|test)\.ts$/.test(rel) || rel.endsWith('.d.ts')) continue;
    const text = await ctx.workspace.read(rel);
    if (text === null || !text.includes('@Controller')) continue;
    out.push(...routesOf(rel, text));
  }
  return out;
}

export default defineGate({
  name: 'route-lock',
  stacks: ['nestjs'],
  description: 'No route the base commit served is removed or moved (METHOD + path), unless the task allows breaking changes; payload shapes are not compared.',
  phases: ['finish', 'ship'],
  appliesTo: ['brownfield'],
  async run(ctx): Promise<GateResult> {
    if (ctx.task.kind !== 'brownfield') return { status: 'n/a', summary: 'not applicable to greenfield tasks' };
    const before = await baseRoutes(ctx);
    if ('error' in before) return { status: 'unproven', summary: `the base routes could not be read: ${before.error}` };
    const after = await headRoutes(ctx);
    const unknown = [...before, ...after].filter((r) => r.unknown !== undefined);
    if (unknown.length > 0) {
      return { status: 'unproven', summary: `${unknown.length} route(s) with a path that is not a string literal: the lock cannot compare them`, details: unknown.slice(0, 10).map((r) => `${r.file}:${r.line}  ${r.handler}: ${r.unknown ?? ''}`) };
    }
    if (before.length === 0 && after.length === 0) return { status: 'unproven', summary: 'no controller routes on either side: nothing proves the API is unchanged' };
    const afterKeys = new Set(after.map(routeKey));
    const beforeKeys = new Set(before.map(routeKey));
    const removed = [...new Map(before.filter((r) => !afterKeys.has(routeKey(r))).map((r) => [routeKey(r), r])).values()];
    const added = [...new Map(after.filter((r) => !beforeKeys.has(routeKey(r))).map((r) => [routeKey(r), r])).values()];
    await ctx.logs.write('route-lock.txt', [
      `base ${ctx.run.baseSha.slice(0, 12)}: ${before.length} routes; worktree: ${after.length} routes`,
      ...removed.map((r) => `removed  ${routeKey(r)}  (${r.file}:${r.line} ${r.handler})`),
      ...added.map((r) => `added    ${routeKey(r)}  (${r.file}:${r.line} ${r.handler})`),
    ].join('\n'));
    const counts = `${beforeKeys.size} → ${afterKeys.size} routes`;
    const addedLines = added.map((r) => `added: ${routeKey(r)} (${r.file}:${r.line})`);
    if (removed.length > 0 && !ctx.task.allowBreaking) {
      return {
        status: 'fail',
        summary: `${removed.length} route(s) the base served are gone (${counts}): a frontend calling them gets a 404; set allowBreaking only if intended`,
        details: [...removed.map((r) => `removed: ${routeKey(r)} (${r.file}:${r.line} ${r.handler})`), ...addedLines],
        humanMustVerify: [SHAPES],
      };
    }
    return {
      status: 'pass',
      summary: `every base route is still served (${counts}${added.length > 0 ? `; ${added.length} added` : ''}${removed.length > 0 ? `; ${removed.length} removed, allowed by the task` : ''})`,
      details: addedLines,
      humanMustVerify: [SHAPES, ...(removed.length > 0 ? [`removed routes allowed by the task: ${removed.map(routeKey).join(', ')}`] : [])],
    };
  },
});
