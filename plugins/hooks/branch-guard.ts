/**
 * branch-guard (pre, write): in-place runs only. A session writes in the owner's own checkout, on the
 * working branch the owner was on when it started, and the owner can change that checkout at any
 * time from another terminal. So before every write-effect call the guard re-reads the checkout and
 * refuses the write, with the reason and the command that fixes it, when:
 *   - HEAD is no longer on the branch the session started on (a switch, a checkout of a commit);
 *   - a merge, rebase, cherry-pick, revert or bisect is in progress;
 *   - HEAD is detached, unborn, or on a protected branch.
 * The harness never switches branches or stashes to make a write possible: the owner does.
 *
 * A worktree run (file mode: no RunContext.inPlace) has its own branch in its own worktree; there the
 * guard has nothing to check and passes. A git query that fails is a refusal (branchVerdict).
 */
import { branchVerdict, defineHook } from '../../src/core/plugin-api.ts';

export default defineHook({
  name: 'branch-guard',
  description: 'In-place runs only: before every write, re-checks that HEAD is still on the working branch the session started on, not protected, with no merge/rebase/cherry-pick/bisect in progress.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const inPlace = ctx.inPlace;
    if (inPlace === undefined) return { decision: 'pass' }; // a worktree run: n/a
    const v = await branchVerdict(inPlace.repoTop, ctx.config, ctx.exec);
    const tail = 'The harness never switches branches or stashes on its own; nothing was written.';
    if (!v.writable) return { decision: 'block', reason: `branch-guard: write refused: ${v.reason}. Fix: ${v.fix}. ${tail}` };
    if (v.branch !== inPlace.branch) {
      return {
        decision: 'block',
        reason: `branch-guard: write refused: HEAD moved from ${inPlace.branch} (where this session started) to ${v.branch ?? 'another commit'}. Fix: switch back (git switch ${inPlace.branch}) or start a new session on ${v.branch ?? 'the new branch'}. ${tail}`,
      };
    }
    return { decision: 'pass' };
  },
});
