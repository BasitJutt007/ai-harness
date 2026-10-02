/**
 * observed-red (pre, write): a governed (non-test) TypeScript file may only be
 * written once a covering test has been observed failing by the harness's own
 * runner at its current content (see plugins/lib/red.ts for the exact predicate).
 * Test files are always allowed. Every file it lets through is recorded, so the
 * observed-red gate can prove no governed file changed behind the hook's back.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { toApiRel, writePolicy } from '../lib/path-policy.ts';
import { isGovernedSource, lockState, lockedReason, recordUnlocked } from '../lib/red.ts';

export default defineHook({
  name: 'observed-red',
  description: 'Blocks source edits until a covering test has an observed red run at its current content.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const unlocked: string[] = [];
    for (const p of event.call.paths) {
      const r = toApiRel(ctx.workspace, p);
      // Invalid or out-of-policy paths are path-guard's business (it blocks them with the precise reason).
      if (!r.ok || !writePolicy(ctx.task, r.rel).allowed || !isGovernedSource(r.rel)) continue;
      const lock = await lockState(ctx, r.rel);
      if (!lock.unlocked) return { decision: 'block', reason: `observed-red: ${lockedReason(lock)}` };
      unlocked.push(r.rel);
    }
    for (const rel of unlocked) recordUnlocked(ctx.state, rel);
    return { decision: 'pass' };
  },
});
