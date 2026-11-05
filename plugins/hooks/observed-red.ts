/**
 * observed-red (pre, write): a governed (non-test) source file may only be written once a covering test
 * has been observed failing by the harness's own runner at its current content (see plugins/lib/red.ts
 * for the exact predicate). Test files are always allowed. Every file it lets through is recorded, so the
 * observed-red gate can prove no governed file changed behind the hook's back.
 *
 * In place (a session in any web repository) logic whose proof tier is UNPROVEN (no supported test
 * runner, or a component kind the runner cannot load; plugins/lib/proof.ts) is let through without a red
 * the run could never get, with a note: the observed-red gate then reports it UNPROVEN by name, so such an
 * edit never ends "Work completed". File mode has no such tier: every governed file needs its red.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { toApiRel, writePolicyFor } from '../lib/path-policy.ts';
import { proofTier } from '../lib/proof.ts';
import { isGovernedSource, lockState, lockedReason, recordUnlocked } from '../lib/red.ts';

export default defineHook({
  name: 'observed-red',
  description: 'Blocks source edits until a covering test has an observed red run at its current content.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const unlocked: string[] = [];
    const unprovable: string[] = [];
    for (const p of event.call.paths) {
      const r = toApiRel(ctx.workspace, p);
      // Invalid or out-of-policy paths are path-guard's business (it blocks them with the precise reason).
      if (!r.ok || !writePolicyFor(ctx, r.rel).allowed || !isGovernedSource(r.rel)) continue;
      // Deleting a file this run created only returns to the run-start state: no red needed.
      if (event.call.preview?.get(p) === null && !ctx.state.initialHashes.has(r.rel)) continue;
      const tier = proofTier(ctx, r.rel);
      if (tier.tier === 'unproven') {
        unprovable.push(`${r.rel} (${tier.why})`);
        continue;
      }
      const lock = await lockState(ctx, r.rel);
      if (!lock.unlocked) return { decision: 'block', reason: `observed-red: ${lockedReason(lock)}` };
      unlocked.push(r.rel);
    }
    for (const rel of unlocked) recordUnlocked(ctx.state, rel);
    if (unprovable.length > 0) {
      return {
        decision: 'record',
        note: `observed-red: no test can prove ${unprovable.join('; ')}. The edit is allowed, but the verdict will be UNPROVEN for it and a human must verify it by hand.`,
      };
    }
    return { decision: 'pass' };
  },
});
