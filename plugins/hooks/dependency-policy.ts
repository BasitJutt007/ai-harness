/**
 * dependency-policy (pre, write of TypeScript): nothing can be installed during a run, so every
 * bare module specifier a write ADDS to a TypeScript file (import / export-from / import-equals /
 * dynamic import / require / vi.mock of a literal) must name
 *   - a Node builtin (`node:fs`, `fs`), or
 *   - a package the API's package.json declares (dependencies, devDependencies, peer or optional)
 *     AND that resolves from the API root (a node_modules directory in it or one of its ancestors),
 *     or the API's own package name, or
 *   - a module of the API itself through its tsconfig `paths` or `baseUrl`.
 * Anything else is refused on the first write that adds it, with the packages that ARE available,
 * instead of surfacing much later as a failed test run or type check. Judged on the post-image
 * (the loop's preview); specifiers the file already had are left alone. A write tool without
 * preview() is refused (fail closed).
 */
import { isBuiltin } from 'node:module';
import { defineHook } from '../../src/core/plugin-api.ts';
import { dependencyView, isBare, moduleSpecifiers, packageOf } from '../lib/dependencies.ts';
import type { DependencyView } from '../lib/dependencies.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { postImage } from '../lib/post-image.ts';

const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
/** Packages named in the "available" list at most. */
const MAX_LISTED = 12;

/** Why `spec` cannot be imported by the API, or null when it can. */
export function unavailable(spec: string, view: DependencyView): string | null {
  if (!isBare(spec)) return null;
  if (spec.startsWith('node:')) return isBuiltin(spec) ? null : `"${spec}" is not a Node builtin, and dependencies cannot be added in this run`;
  if (isBuiltin(spec)) return null;
  if (view.localAlias(spec)) return null;
  const name = packageOf(spec);
  if (name === view.self) return null;
  const declared = view.declared.includes(name);
  const resolves = view.resolves(name);
  if (declared && resolves) return null;
  if (!resolves) return `package ${name} is not installed and dependencies cannot be added in this run`;
  return `package ${name} is not declared in the API's package.json and dependencies cannot be added in this run`;
}

/** Short list of what may be imported: declared packages that resolve (no @types), then Node builtins. */
export function availableList(view: DependencyView): string {
  const usable = view.declared.filter((d) => !d.startsWith('@types/') && view.resolves(d));
  const shown = usable.slice(0, MAX_LISTED);
  const more = usable.length > shown.length ? `, … +${usable.length - shown.length}` : '';
  return `${shown.length > 0 ? `${shown.join(', ')}${more}, ` : ''}node: builtins`;
}

export default defineHook({
  name: 'dependency-policy',
  description: 'Blocks imports of packages the API does not declare and have installed (nothing can be installed during a run).',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    let view: DependencyView | undefined;
    for (const p of call.paths) {
      const r = toApiRel(ctx.workspace, p);
      if (!r.ok || !TS_FILE.test(r.rel)) continue; // path-guard reports bad paths; other files import nothing
      const img = postImage(call, p);
      if (!img.ok) return { decision: 'block', reason: `dependency-policy: ${img.reason}` };
      if (img.after === null) continue; // no file afterwards
      const before = await ctx.workspace.read(r.rel);
      const had = new Set(before === null ? [] : moduleSpecifiers(r.rel, before));
      const added = [...new Set(moduleSpecifiers(r.rel, img.after))].filter((s) => !had.has(s) && isBare(s));
      if (added.length === 0) continue;
      const deps = (view ??= dependencyView(ctx.workspace.root));
      const refused = added.flatMap((s) => {
        const why = unavailable(s, deps);
        return why === null ? [] : [`  ${r.rel} imports "${s}": ${why}`];
      });
      if (refused.length === 0) continue;
      return {
        decision: 'block',
        reason: [
          `dependency-policy: ${r.rel} would import what the API does not have:`,
          ...refused,
          `available: ${availableList(deps)}. Use one of these, or write the code yourself in the API.`,
        ].join('\n'),
      };
    }
    return { decision: 'pass' };
  },
});
