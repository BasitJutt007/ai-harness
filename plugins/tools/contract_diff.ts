/**
 * contract_diff: compare the API's current public contract with the base commit
 * (same extraction and rules as the contract-lock gate), so the model can check
 * before calling finish. BREAKING and UNPROVEN lines block finish (BREAKING only
 * without allowBreaking); additive and info lines do not.
 */
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { compareWithBase, formatDiff } from '../lib/contract.ts';

export default defineTool({
  name: 'contract_diff',
  description: 'Diff the public API contract against the base commit.',
  input: z.object({}),
  effect: 'exec',
  availableIn: ['brownfield'],
  async run(_input, ctx) {
    try {
      const { before, after, diff } = await compareWithBase(ctx);
      const head = `contract: ${before.endpoints.length} → ${after.endpoints.length} endpoints; `
        + `${diff.breaking.length} breaking, ${diff.unproven.length} unproven, ${diff.additive.length} additive, ${diff.informational.length} informational`;
      const allowed = ctx.task.kind === 'brownfield' && ctx.task.allowBreaking ? ' (task allows breaking changes)' : '';
      const summary = [head + allowed, ...formatDiff(diff, 30)].join('\n');
      // Baseline (naive) return: the same diff, uncapped.
      const raw = [head + allowed, ...formatDiff(diff, Number.POSITIVE_INFINITY)].join('\n');
      return { ok: true, summary, raw: raw.length >= summary.length ? raw : summary, data: diff };
    } catch (e) {
      return { ok: false, summary: `contract extraction failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
