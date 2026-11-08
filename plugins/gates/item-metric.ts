/**
 * item-metric (finish, ship): the item's own metric, read by the harness on this run's tree, must
 * differ from the before value read when the contract was proposed. A run can pass every test the
 * agent wrote and still leave the item's problem as it was (a helper written but never called); this
 * gate reads the contract's Measure on the run's working tree, confined and twice like any reading
 * (src/core/measure.ts), so DONE means the number the stakeholder approved has moved. Which way it
 * should move, and by how much, stays the human's call at close: the gate checks only that it moved.
 *
 * No item: n/a (stakeholder-yes already fails such a run). No before value, a different Measure
 * script from the one that read it, or no reading: UNPROVEN, never a pass.
 */
import { contractVerdict, defineGate, itemPaths, readLedger, readTreeMetric } from '../../src/core/plugin-api.ts';

export default defineGate({
  name: 'item-metric',
  description: "The item's metric, read by the harness on this run's tree, has moved from the value read at proposal.",
  phases: ['finish', 'ship'],
  async run(ctx) {
    const item = ctx.item;
    if (item === undefined) return { status: 'n/a', summary: 'the run is bound to no backlog item (stakeholder-yes refuses it)' };
    const paths = itemPaths(item.root, item.slug);
    const c = contractVerdict(paths);
    if (!c.ok || c.parse === null) return { status: 'fail', summary: c.reason };
    const measure = c.parse.measure;
    if (measure === null) return { status: 'fail', summary: `docs/contracts/${item.slug}.md has no runnable Measure` };
    const ledger = readLedger(paths.ledger);
    if (ledger.problems.length > 0) return { status: 'unproven', summary: `the item ledger is broken (${ledger.problems.join('; ')}): no trusted before value` };
    const proposal = ledger.entries.filter((e) => e.event.type === 'proposed' && e.event.contractHash === item.contractHash).at(-1);
    const before = proposal !== undefined && proposal.event.type === 'proposed' ? proposal.event.before : null;
    if (before === null) return { status: 'unproven', summary: 'no before value was read when this contract was proposed: nothing to compare the run tree with' };
    const now = await readTreeMetric({ harnessRoot: ctx.run.harnessRoot, treeDir: ctx.workspace.repoRoot, measure, exec: ctx.exec, label: item.slug });
    if (!now.ok) return { status: 'unproven', summary: `the metric could not be read on the run tree: ${now.reason}` };
    if (now.scriptSha256 !== before.scriptSha256) return { status: 'unproven', summary: `${measure.script} changed since the before value was read (sha256 ${before.scriptSha256.slice(0, 12)} then, ${now.scriptSha256.slice(0, 12)} now): the readings are not comparable` };
    const line = `${measure.text}: before ${String(before.value)} (at ${before.sha.slice(0, 12)}), this run's tree ${String(now.value)}`;
    if (now.value === before.value) {
      return { status: 'fail', summary: `the item's metric did not move: ${line}. The change does not reach the problem the contract names yet`, details: now.excerpt.split('\n') };
    }
    return { status: 'pass', summary: `${line} (the direction and size are judged at close)` };
  },
});
