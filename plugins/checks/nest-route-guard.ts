/**
 * nest-route-guard (nestjs; access): who may call each route. In a NestJS app that authenticates every
 * route globally and enforces admin access only where an admin decorator is declared (an admin guard
 * that lets a route through when the metadata is absent):
 *   - an admin-facing route (an `admin` path segment, or a controller under an admin/ directory)
 *     without an admin decorator on the method or its class can be called by ANY signed-in user;
 *   - a route with a public decorator can be called by anyone at all.
 * Both are violations. Like every non-standards rule they block only what a run introduces (the standards
 * gate compares with the base commit); the ones the base already had are listed, not blocking.
 *
 * Which decorators those are differs per codebase, so the names come from harness.config.json
 * `checkOptions["nest-route-guard"]`: `adminDecorators` and `publicDecorators` (identifiers, without
 * the @). With neither configured the rule is n/a and says why: it cannot tell a guarded route from an
 * open one, so it never passes one. With only public decorators configured, an admin-facing route is
 * UNPROVEN (it is known to need an admin check the rule cannot see); an empty public list means the
 * codebase has no decorator that opens a route. Options it cannot read (a typo'd key, a value that is
 * not a list of identifiers) make it UNPROVEN.
 *
 * The habit it encodes (docs/workflow.md, What breaks): routes shipped without the access check they
 * needed, caught in review more than once.
 * UNPROVEN: a route whose path is not a string literal (the extractor cannot say what it guards).
 */
import { z } from 'zod';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { decoratorOf, isAdminFacing, routesOf } from '../lib/nest-routes.ts';

const RULE = 'nest-route-guard';
const PROJECT = '(project)';
const CONFIG_KEY = `harness.config.json checkOptions["${RULE}"]`;

/** A decorator name as written after the @ (no call parentheses, no arguments). */
const DECORATOR_NAME = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'a decorator name without @ or ()');

const OptionsSchema = z
  .object({
    /** Decorators that restrict a route to admins (on the method or its controller class). */
    adminDecorators: z.array(DECORATOR_NAME).default([]),
    /** Decorators that make a route reachable without authentication. */
    publicDecorators: z.array(DECORATOR_NAME).default([]),
  })
  .strict();

export type RouteGuardOptions = z.infer<typeof OptionsSchema>;

/** The check's options from ctx.options (absent = none configured), or why they cannot be read. */
export function parseOptions(raw: unknown): { ok: true; options: RouteGuardOptions } | { ok: false; reason: string } {
  const r = OptionsSchema.safeParse(raw ?? {});
  if (r.success) return { ok: true, options: r.data };
  const issues = r.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(options)'}: ${i.message}`).join('; ');
  return { ok: false, reason: `unreadable ${CONFIG_KEY}: ${issues}` };
}

const NOT_CONFIGURED = `no access decorators configured: set adminDecorators and/or publicDecorators in ${CONFIG_KEY}`;

const DOC = `nest-route-guard: every route says who may call it. The decorator names are the repository's own,
configured in ${CONFIG_KEY} (adminDecorators, publicDecorators).
- An admin-facing route (a path segment "admin", or a controller under an admin/ directory) carries an
  admin decorator on the method or its controller class: a global admin guard that only enforces routes
  declaring it lets any signed-in user through otherwise.
- A route with a public decorator is reachable without authentication: do not add one unless the contract names it.
Example (adminDecorators: ["RequireAdmin"]):
  @RequireAdmin()
  @Controller('admin/reports')
  export class AdminReportsController { @Get(':id') find(@Param('id') id: string) { ... } }`;

function list(names: readonly string[]): string {
  return names.map((n) => `@${n}()`).join(' or ');
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const parsed = parseOptions(ctx.options);
  if (!parsed.ok) return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: parsed.reason }];
  const { adminDecorators: admin, publicDecorators: open } = parsed.options;
  if (admin.length === 0 && open.length === 0) return [{ rule: RULE, file: PROJECT, status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: NOT_CONFIGURED }];
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
    const unjudged = admin.length === 0 ? routes.find(isAdminFacing) : undefined;
    if (unjudged !== undefined) {
      findings.push({ rule: RULE, file, status: 'skip', units: { passed: 0, total: routes.length }, violations: [], skipReason: `${unjudged.method} ${unjudged.path} (${unjudged.handler}) is admin-facing, but no adminDecorators are configured in ${CONFIG_KEY}` });
      continue;
    }
    const violations: Violation[] = [];
    for (const r of routes) {
      const at = `${file}:${r.line}:1`;
      const pub = decoratorOf(r, open);
      if (pub !== null) violations.push({ location: at, message: `${r.method} ${r.path} (${r.handler}) is @${pub}: callable without authentication` });
      else if (isAdminFacing(r) && decoratorOf(r, admin) === null) violations.push({ location: at, message: `${r.method} ${r.path} (${r.handler}) is admin-facing without ${list(admin)}: any signed-in user can call it` });
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
  description: 'Admin-facing routes carry an admin decorator; no route carries a public decorator unless the contract names it (names from checkOptions).',
  unit: 'routes',
  doc: DOC,
  run,
});
