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
 * the @). An admin-facing route the rule cannot judge (no adminDecorators configured) is UNPROVEN,
 * route by route; everything it can judge is still judged. So:
 *   - neither configured: every admin-facing route is UNPROVEN; the rule is n/a (and says why) only
 *     when the repository has no admin-facing route at all. It never passes a route it cannot judge.
 *   - only public decorators: a route carrying one still FAILS; admin-facing routes are UNPROVEN.
 *   - only admin decorators: an empty public list means the codebase has no decorator that opens a route.
 * Options it cannot read (a typo'd key, a value that is not a list of identifiers) make it UNPROVEN.
 *
 * The habit it encodes (docs/workflow.md, What breaks): routes shipped without the access check they
 * needed, caught in review more than once.
 * UNPROVEN: a route whose path is not a string literal (the extractor cannot say what it guards).
 */
import { z } from 'zod';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { decoratorOf, isAdminFacing, routesOf, type NestRoute } from '../lib/nest-routes.ts';

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

/** Why an admin-facing route cannot be judged with these options (no adminDecorators configured). */
function unjudgedReason(r: NestRoute, more: number, configured: boolean): string {
  const which = `${r.method} ${r.path} (${r.handler})${more > 0 ? ` and ${more} more admin-facing route(s)` : ''}`;
  return configured
    ? `${which} ${more > 0 ? 'are' : 'is'} admin-facing, but no adminDecorators are configured in ${CONFIG_KEY}`
    : `${which} ${more > 0 ? 'are' : 'is'} admin-facing, but ${NOT_CONFIGURED}`;
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const parsed = parseOptions(ctx.options);
  if (!parsed.ok) return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: parsed.reason }];
  const { adminDecorators: admin, publicDecorators: open } = parsed.options;
  const configured = admin.length > 0 || open.length > 0;
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
    // Each route is judged when the options say enough about it; an admin-facing one without admin names is not.
    const judged: NestRoute[] = [];
    const unjudged: NestRoute[] = [];
    const violations: Violation[] = [];
    for (const r of routes) {
      const at = `${file}:${r.line}:1`;
      const pub = decoratorOf(r, open);
      if (pub !== null) {
        judged.push(r);
        violations.push({ location: at, message: `${r.method} ${r.path} (${r.handler}) is @${pub}: callable without authentication` });
      } else if (isAdminFacing(r)) {
        if (admin.length === 0) {
          unjudged.push(r);
          continue;
        }
        judged.push(r);
        if (decoratorOf(r, admin) === null) violations.push({ location: at, message: `${r.method} ${r.path} (${r.handler}) is admin-facing without ${list(admin)}: any signed-in user can call it` });
      } else if (configured) {
        judged.push(r); // with no names at all, nothing says whether a plain route is open: not counted
      }
    }
    if (judged.length > 0) {
      const bad = new Set(violations.map((v) => v.location));
      const passed = judged.filter((r) => !bad.has(`${file}:${r.line}:1`)).length;
      findings.push({ rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total: judged.length }, violations });
    }
    const first = unjudged[0];
    if (first !== undefined) {
      findings.push({ rule: RULE, file, status: 'skip', units: { passed: 0, total: unjudged.length }, violations: [], skipReason: unjudgedReason(first, unjudged.length - 1, configured) });
    }
  }
  // Nothing configured and no admin-facing route anywhere: there is nothing this rule could judge.
  if (!configured && findings.length === 0) return [{ rule: RULE, file: PROJECT, status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: NOT_CONFIGURED }];
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
