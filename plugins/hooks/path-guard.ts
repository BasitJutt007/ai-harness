/**
 * path-guard (pre, write): every path a write tool touches must stay inside the API root, avoid
 * harness-owned files and fall inside the run's write scope.
 *
 * File mode (a worktree run): a .ts file (and .tsx on a React target) inside the task scope, the 01 policy.
 * In place (a session in the owner's checkout, ctx.inPlace): a web source or text file anywhere in the
 * git-visible tree minus the supply-chain deny list (path-policy.ts inPlaceWritePolicy). A path git
 * ignores (or cannot classify) is refused too: an ignored file would never be shipped, and it is where
 * build output, local config and secrets live.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { gitHidden, toApiRel, writePolicyFor } from '../lib/path-policy.ts';

export default defineHook({
  name: 'path-guard',
  description: 'Blocks writes outside the API root, to harness-owned files, to file kinds the run may not write, or outside the write scope (in place: git-ignored paths too).',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    if (call.paths.length === 0) {
      return { decision: 'block', reason: `path-guard: write tool ${call.tool} declared no paths, so the write cannot be checked.` };
    }
    for (const p of call.paths) {
      const r = toApiRel(ctx.workspace, p);
      if (!r.ok) {
        return { decision: 'block', reason: `path-guard: ${r.reason}. Use a path relative to the API root, e.g. src/routes/items.ts.` };
      }
      const policy = writePolicyFor(ctx, r.rel);
      if (!policy.allowed) return { decision: 'block', reason: `path-guard: ${policy.reason}.` };
      if (ctx.inPlace !== undefined) {
        const hidden = await gitHidden(ctx.workspace, r.rel);
        if (hidden !== null) return { decision: 'block', reason: `path-guard: write refused: ${hidden}.` };
      }
    }
    return { decision: 'pass' };
  },
});
