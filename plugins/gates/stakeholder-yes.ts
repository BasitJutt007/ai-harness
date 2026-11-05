/**
 * stakeholder-yes (finish, ship): the item's gates, fresh, at the end of the run and again before
 * ship. Pass iff the run is bound to an item, its contract names every required field, the text is
 * the one the run started under, and the stakeholder's yes to the latest proposal of that text is a
 * typed terminal turn in items/<slug>/ledger.jsonl (src/core/items.ts approvalVerdict). Anything
 * else fails with the reason; the gate is required (src/core/gates.ts), so disabling it is UNPROVEN.
 */
import { approvalVerdict, contractVerdict, defineGate, itemPaths, pointWhenRunDirectly, readLedger } from '../../src/core/plugin-api.ts';

// Run on its own this file decides nothing (gates run at finish and ship): say how to check the gate instead.
pointWhenRunDirectly(import.meta.url, "stakeholder-yes is a harness gate: it runs at finish and ship. To check an item's human-yes gate now: harness gate human-yes <slug>");

export default defineGate({
  name: 'stakeholder-yes',
  description: "The item's contract is complete, unchanged since the run started, and approved by the stakeholder in a typed turn.",
  phases: ['finish', 'ship'],
  async run(ctx) {
    const item = ctx.item;
    if (item === undefined) return { status: 'fail', summary: 'the run is bound to no backlog item: no contract, no stakeholder yes' };
    const paths = itemPaths(item.root, item.slug);
    const c = contractVerdict(paths);
    if (!c.ok || c.parse === null) return { status: 'fail', summary: c.reason };
    if (c.parse.hash !== item.contractHash) return { status: 'fail', summary: `docs/contracts/${item.slug}.md changed after the run started: propose it again` };
    const v = approvalVerdict(readLedger(paths.ledger), c.parse.hash);
    if (!v.ok) return { status: 'fail', summary: v.reason, details: v.ignored };
    return { status: 'pass', summary: v.reason };
  },
});
