/**
 * observed-red (pre, write): a governed (non-test) source file may only be written once a covering test
 * has been observed failing by the harness's own runner at its current content (see plugins/lib/red.ts
 * for the exact predicate). Test files are always allowed. Every file it lets through is recorded, so the
 * observed-red gate can prove no governed file changed behind the hook's back.
 *
 * One write passes a locked file: an EXPORT-ONLY edit (src/core/export-only.ts), which compared with the
 * file's current content only exports existing top-level declarations. A test that imports a module-private
 * function cannot load, a load failure is no red for a file that existed at run start, and adding `export`
 * is the only edit that lets the test load: without this the run deadlocks. The edit is judged on the
 * write's post-image (ToolCallInfo.preview; none, no allowance), recorded with its content hashes
 * (recordExportOnly) and unlocks nothing: the test must still be seen failing on an assertion before any
 * other edit. A call that writes several files passes only when each locked one is export-only. Export-only
 * writes to unlocked files are recorded too, so the gate knows a file that only gained exports has no
 * behaviour of its own to prove.
 *
 * In place (a session in any web repository) logic whose proof tier is UNPROVEN (no supported test
 * runner, or a component kind the runner cannot load; plugins/lib/proof.ts) is let through without a red
 * the run could never get, with a note: the observed-red gate then reports it UNPROVEN by name, so such an
 * edit never ends "Work completed". File mode has no such tier: every governed file needs its red. The
 * export-only allowance applies in both modes: it is behaviour-neutral by construction, and file mode has
 * the same deadlock.
 */
import { defineHook, exportOnlyEdit } from '../../src/core/plugin-api.ts';
import type { ExportOnlyVerdict } from '../../src/core/plugin-api.ts';
import { toApiRel, writePolicyFor } from '../lib/path-policy.ts';
import { proofTier } from '../lib/proof.ts';
import { isGovernedSource, lockState, lockedReason, recordExportOnly, recordUnlocked, sha256, type ExportOnlyRecord } from '../lib/red.ts';

export default defineHook({
  name: 'observed-red',
  description: 'Blocks source edits until a covering test has an observed red run at its current content (an export-only edit is the one exception).',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const unlocked: string[] = [];
    const unprovable: string[] = [];
    const exportOnly: ExportOnlyRecord[] = [];
    /** Locked files this call may still write because the write only exports existing declarations. */
    const lockedExportOnly: ExportOnlyRecord[] = [];
    for (const p of event.call.paths) {
      const r = toApiRel(ctx.workspace, p);
      // Invalid or out-of-policy paths are path-guard's business (it blocks them with the precise reason).
      if (!r.ok || !writePolicyFor(ctx, r.rel).allowed || !isGovernedSource(r.rel)) continue;
      const next = event.call.preview?.get(p);
      // Deleting a file this run created only returns to the run-start state: no red needed.
      if (next === null && !ctx.state.initialHashes.has(r.rel)) continue;
      const tier = proofTier(ctx, r.rel);
      if (tier.tier === 'unproven') {
        unprovable.push(`${r.rel} (${tier.why})`);
        continue;
      }
      const current = typeof next === 'string' ? await ctx.workspace.read(r.rel) : null;
      const verdict: ExportOnlyVerdict | null = typeof next === 'string' && current !== null && next !== current ? exportOnlyEdit(r.rel, current, next) : null;
      const record = verdict?.ok === true && typeof next === 'string' && current !== null ? { file: r.rel, from: sha256(current), to: sha256(next), names: verdict.names } : null;
      if (record !== null) exportOnly.push(record);
      const lock = await lockState(ctx, r.rel);
      if (lock.unlocked) {
        unlocked.push(r.rel);
        continue;
      }
      if (record !== null) {
        lockedExportOnly.push(record);
        continue;
      }
      const attempt = verdict !== null && !verdict.ok && verdict.addsExports
        ? `\nThis write is not export-only: ${verdict.why}. While ${r.rel} is locked, the only write it takes is adding \`export\` to existing top-level declarations, with nothing else changed.`
        : '';
      return { decision: 'block', reason: `observed-red: ${lockedReason(lock)}${attempt}` };
    }
    for (const rel of unlocked) recordUnlocked(ctx.state, rel);
    for (const e of exportOnly) recordExportOnly(ctx.state, e);
    const notes = lockedExportOnly.map((e) =>
      `observed-red: export-only edit of ${e.file} allowed while it is locked (exports ${e.names.join(', ')}; nothing else changed). It unlocks nothing: run the test that imports ${e.names.length === 1 ? 'it' : 'them'} and observe a case fail on an assertion before changing ${e.file} further.`);
    if (unprovable.length > 0) {
      notes.push(`observed-red: no test can prove ${unprovable.join('; ')}. The edit is allowed, but the verdict will be UNPROVEN for it and a human must verify it by hand.`);
    }
    return notes.length > 0 ? { decision: 'record', note: notes.join('\n') } : { decision: 'pass' };
  },
});
