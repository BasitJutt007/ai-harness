/**
 * nest-route-guard (nestjs; access): who may call each route. In a NestJS app that authenticates every
 * route globally and enforces admin access only where @AdminOnly() is declared (an admin guard that lets
 * a route through when the metadata is absent):
 *   - an admin-facing route (an `admin` path segment, or a controller under an admin/ directory)
 *     without @AdminOnly on the method or its class can be called by ANY signed-in user;
 *   - a @Public() route can be called by anyone at all.
 * Both are violations. Like every non-standards rule they block only what a run introduces (the standards
 * gate compares with the base commit); the ones the base already had are listed, not blocking.
 *
 * The habit it encodes (docs/workflow.md, What breaks): routes shipped without the access check they
 * needed, caught in review more than once.
 * UNPROVEN: a route whose path is not a string literal (the extractor cannot say what it guards).
 */
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { isAdminFacing, isAdminOnly, isPublic, routesOf } from '../lib/nest-routes.ts';

const RULE = 'nest-route-guard';

const DOC = `nest-route-guard: every route says who may call it.
- An admin-facing route (a path segment "admin", or a controller under an admin/ directory) carries
  @AdminOnly() on the method or its controller class: the admin guard lets any signed-in user through otherwise.
- A @Public() route is reachable without authentication: do not add one unless the contract names it.
Example:
  @AdminOnly()
  @Controller('admin/badges')
  export class AdminBadgesController { @Get(':id') find(@Param('id') id: string) { ... } }`;

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  for (const file of ctx.sourceFiles) {
    const text = await ctx.read(file);
    if (!text.includes('@Controller')) continue;
    const routes = routesOf(file, text);
    if (routes.length === 0) continue;
    const unknown = routes.filter((r) => r.unknown !== undefined);
    if (unknown.length > 0) {
      findings.push({ rule: RULE, file, status: 'skip', units: { passed: 0, total: routes.length }, violations: [], skipReason: `${unknown[0]?.handler ?? 'a route'}: ${unknown[0]?.unknown ?? 'unreadable path'}` });
      continue;
    }
    const violations: Violation[] = [];
    for (const r of routes) {
      const at = `${file}:${r.line}:1`;
      if (isPublic(r)) violations.push({ location: at, message: `${r.method} ${r.path} (${r.handler}) is @Public: callable without authentication` });
      else if (isAdminFacing(r) && !isAdminOnly(r)) violations.push({ location: at, message: `${r.method} ${r.path} (${r.handler}) is admin-facing without @AdminOnly(): any signed-in user can call it` });
    }
    const bad = new Set(violations.map((v) => v.location));
    const passed = routes.filter((r) => !bad.has(`${file}:${r.line}:1`)).length;
    findings.push({ rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total: routes.length }, violations });
  }
  return findings;
}

export default defineCheck({
  id: RULE,
  stacks: ['nestjs'],
  category: 'access',
  description: 'Admin-facing routes carry @AdminOnly(); no route is @Public unless the contract names it.',
  unit: 'routes',
  doc: DOC,
  run,
});
