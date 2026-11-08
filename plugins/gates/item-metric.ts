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
 *
 * Measured files (the task's `measured` globs: files the Measure probes that no unit test can load, edited
 * without an agent-written red) carry their proof here: each changed one is put back ALONE at its
 * run-start content and the metric read again; it must read something other than the run tree's value, so
 * a measured file whose own change moves nothing fails. The file is restored before the gate returns.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { posix } from 'node:path';
import { contractVerdict, defineGate, itemPaths, readLedger, readTreeMetric } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { isMeasured } from '../lib/path-policy.ts';

const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');

/** Measured files whose content differs from the run start (deleted ones included), API-relative and sorted. */
async function changedMeasured(ctx: RunContext): Promise<string[]> {
  if (ctx.task.kind !== 'brownfield' || ctx.task.measured === undefined) return [];
  const out = new Set<string>();
  for (const f of await ctx.workspace.list(ctx.task.measured)) {
    const now = await ctx.workspace.read(f);
    if (now !== null && sha256(now) !== ctx.state.initialHashes.get(f)) out.add(f);
  }
  for (const f of ctx.state.initialHashes.keys()) {
    if (isMeasured(ctx.task, f) && (await ctx.workspace.read(f)) === null) out.add(f);
  }
  return [...out].sort();
}

/** The run-start content of an API-relative file (null: it did not exist at the base commit). */
async function baseContent(ctx: RunContext, rel: string): Promise<string | null | { error: string }> {
  if (!ctx.state.initialHashes.has(rel)) return null;
  const repoRel = posix.join(ctx.workspace.rootRel === '' ? '.' : ctx.workspace.rootRel, rel).replace(/^\.\//, '');
  const r = await ctx.exec('git', ['-C', ctx.workspace.repoRoot, 'show', `${ctx.run.baseSha}:${repoRel}`], { cwd: ctx.workspace.repoRoot });
  if (r.code !== 0) return { error: `git show ${ctx.run.baseSha.slice(0, 12)}:${repoRel} failed: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}` };
  if (sha256(r.stdout) !== ctx.state.initialHashes.get(rel)) return { error: `${rel} at ${ctx.run.baseSha.slice(0, 12)} is not the content the run started with` };
  return r.stdout;
}

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
    // Each changed measured file, alone back at its run-start content, must change the reading.
    const measured = await changedMeasured(ctx);
    const stuck: string[] = [];
    for (const f of measured) {
      const base = await baseContent(ctx, f);
      if (base !== null && typeof base === 'object') return { status: 'unproven', summary: `revert check of measured ${f}: ${base.error}` };
      const current = await ctx.workspace.read(f);
      const abs = ctx.workspace.resolve(f);
      let reverted: Awaited<ReturnType<typeof readTreeMetric>>;
      try {
        if (base === null) rmSync(abs, { force: true });
        else await ctx.workspace.write(f, base);
        reverted = await readTreeMetric({ harnessRoot: ctx.run.harnessRoot, treeDir: ctx.workspace.repoRoot, measure, exec: ctx.exec, label: `${item.slug}-revert` });
      } finally {
        if (current === null) rmSync(abs, { force: true });
        else await ctx.workspace.write(f, current);
      }
      if (!reverted.ok) return { status: 'unproven', summary: `revert check of measured ${f}: the metric could not be read: ${reverted.reason}` };
      if (reverted.value === now.value) stuck.push(`${f}: with this file alone at its run-start content the metric still reads ${String(now.value)}: its own change moves nothing`);
    }
    if (stuck.length > 0) {
      return { status: 'fail', summary: `${stuck.length} of ${measured.length} changed measured file(s) not proven by their own revert (${line})`, details: stuck };
    }
    const proof = measured.length > 0 ? `; each of ${measured.length} changed measured file(s) moves it back when reverted alone (${measured.join(', ')})` : '';
    return { status: 'pass', summary: `${line} (the direction and size are judged at close)${proof}` };
  },
});
