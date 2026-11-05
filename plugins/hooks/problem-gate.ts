/**
 * problem-gate (pre, write): the problem-statement gate. No edit happens until
 * docs/contracts/<slug>.md exists for the run's item and names every required field: Problem,
 * Owner, Stakeholder, Repo, Base, Metric (name, window, before/after slots), Measure (the command
 * the harness runs to read the metric), at least one WHEN ... THEN ... Scenario, and Not included.
 * The refusal names each missing field.
 *
 * Fail closed: a run bound to no item is refused (there is no edit without a contract), and the
 * contract is re-read on every write, so a contract emptied or changed mid-run stops edits at once
 * (a changed text needs a new proposal and a new yes: see contract-gate).
 *
 * "Measure: none" (no metric script) is for an interactive session only (a run in place, read from the
 * context: writesInPlace): such an item can ship but never close. A file-mode run exists to be closed on
 * its metric, so there it is refused, naming the field.
 */
import { contractVerdict, defineHook, fileModeMeasureProblem, itemPaths, pointWhenRunDirectly, writesInPlace } from '../../src/core/plugin-api.ts';

// Run on its own this file enforces nothing (hooks act inside a run): say how to check the gate instead.
pointWhenRunDirectly(import.meta.url, "problem-gate is a harness hook: it blocks edits inside a run. To check an item's problem-statement gate now: harness gate problem-statement <slug>");

export default defineHook({
  name: 'problem-gate',
  description: 'Blocks every edit until docs/contracts/<slug>.md names the owner, metric, measure, WHEN/THEN scenarios and the not-included list; names each missing field.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const item = ctx.item;
    if (item === undefined) {
      return { decision: 'block', reason: 'problem-gate: this run is bound to no backlog item, and no edit happens without a contract: write docs/contracts/<slug>.md and run with --item <slug>.' };
    }
    const v = contractVerdict(itemPaths(item.root, item.slug));
    if (!v.ok || v.parse === null) return { decision: 'block', reason: `problem-gate: ${v.reason}.` };
    const noMeasure = writesInPlace(ctx) ? null : fileModeMeasureProblem(v.parse, item.slug);
    if (noMeasure !== null) return { decision: 'block', reason: `problem-gate: ${noMeasure}.` };
    if (v.parse.hash !== item.contractHash) {
      return { decision: 'block', reason: `problem-gate: docs/contracts/${item.slug}.md changed after this run started (the approved text was ${item.contractHash.slice(0, 12)}, it is now ${v.parse.hash.slice(0, 12)}): stop; the changed contract must be proposed again and get a new yes.` };
    }
    return { decision: 'pass' };
  },
});
