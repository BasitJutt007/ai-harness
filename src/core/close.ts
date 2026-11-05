/**
 * Closing a backlog item: the outcome check (assignment 02). An item closes only when the metric its
 * contract names has been read by the harness AFTER the merge and written next to the value it had
 * before. Nobody's word closes it: not the agent's (no model tool reaches this code), and not the
 * operator's (there is no flag that supplies a value, and a value typed into the contract is ignored
 * and reported as hand-written).
 *
 * Facts, gathered in order, each one a refusal when it does not hold:
 *   1. the item ledger is intact, the contract is complete and its text is approved (typed yes);
 *   2. the harness shipped it: a `shipped` ledger entry with the PR the harness opened;
 *   3. a `before` reading exists (taken when the contract was proposed);
 *   4. GitHub says that PR is MERGED, by a person (not a "[bot]" account), into the contract's Base, with the head commit the
 *      harness shipped (a PR that gained commits after ship is not what the gates cleared);
 *   5. the merge commit is on origin/<Base>;
 *   6. the Measure command, run by the harness at the merge commit, prints the same number twice.
 * Only then are the after reading and the `closed` entry appended and the contract's Metric line
 * filled in (before and after side by side).
 */
import { randomUUID } from 'node:crypto';
import { exec as coreExec, passThroughEnv } from './exec.ts';
import { appendLedger, itemPaths, itemStatus, writeMetricValues, type ItemStatus, type LedgerEntry, type LedgerEvent, type MetricReading } from './items.ts';
import { readMetric, type MeasureResult } from './measure.ts';
import type { Exec } from './types.ts';

export interface PrState {
  url: string;
  number: number;
  state: string;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeSha: string | null;
  baseRef: string;
  headSha: string;
}

type Shipped = Extract<LedgerEvent, { type: 'shipped' }>;

export interface OutcomeFacts {
  status: ItemStatus;
  shipped: { entry: LedgerEntry; event: Shipped } | null;
  before: MetricReading | null;
  pr: PrState | { error: string } | null;
  onBase: true | { error: string } | null;
  after: MeasureResult | null;
}

export interface OutcomeVerdict {
  ok: boolean;
  /** Why the item cannot close (empty when ok). */
  reasons: string[];
}

/** Steps 1-3: what the item's own records must show before GitHub or the metric is consulted (empty = all hold). */
export function preconditions(f: Pick<OutcomeFacts, 'status' | 'shipped' | 'before'>): string[] {
  const reasons: string[] = [];
  const s = f.status;
  if (s.ledger.problems.length > 0) reasons.push(`the item ledger is broken (${s.ledger.problems.join('; ')})`);
  if (!s.contract.ok) reasons.push(s.contract.reason);
  else if (s.approval?.ok !== true) reasons.push(`no stakeholder yes: ${s.approval?.reason ?? 'not proposed'}`);
  const closed = s.ledger.entries.find((e) => e.event.type === 'closed');
  if (closed !== undefined) reasons.push(`already closed (ledger seq ${closed.seq})`);
  if (reasons.length > 0) return reasons;
  if (f.shipped === null) return ['the harness never shipped this item: there is no PR it opened (harness run <task> --item <slug> --ship)'];
  if (f.shipped.event.prUrl === null) return [`run ${f.shipped.event.runId} pushed ${f.shipped.event.branch} but opened no PR`];
  if (f.before === null) return ['no before value: the metric was not read when the contract was proposed (harness item propose <slug> --repo <dir>)'];
  return [];
}

/** The decision, as a pure function of the gathered facts (null = not gathered: an earlier fact failed). */
export function outcomeVerdict(f: OutcomeFacts): OutcomeVerdict {
  const pre = preconditions(f);
  if (pre.length > 0) return { ok: false, reasons: pre };
  if (f.shipped === null || f.before === null) return { ok: false, reasons: ['unreachable: preconditions passed without a shipped entry or a before reading'] };

  if (f.pr === null) return { ok: false, reasons: ['the PR was not checked'] };
  if ('error' in f.pr) return { ok: false, reasons: [`cannot read the PR from GitHub: ${f.pr.error}`] };
  const pr = f.pr;
  if (pr.state !== 'MERGED' || pr.mergeSha === null) return { ok: false, reasons: [`PR #${pr.number} is ${pr.state}, not merged: the metric is read after the merge`] };
  if (pr.mergedBy === null || pr.mergedBy.length === 0) return { ok: false, reasons: [`PR #${pr.number} has no merger on record`] };
  // A person merges: a GitHub App or bot account ("name[bot]", e.g. an auto-merge action) is not a person.
  if (/\[bot\]$/i.test(pr.mergedBy)) return { ok: false, reasons: [`PR #${pr.number} was merged by ${pr.mergedBy}, a bot: a person must merge what the harness opened`] };
  const base = (f.status.contract.parse?.fields.Base ?? '').trim();
  if (pr.baseRef !== base) return { ok: false, reasons: [`PR #${pr.number} merged into ${pr.baseRef}, but the contract's Base is ${base}`] };
  if (pr.headSha !== f.shipped.event.headSha) {
    return { ok: false, reasons: [`PR #${pr.number}'s head is ${pr.headSha.slice(0, 12)}, but the harness shipped ${f.shipped.event.headSha.slice(0, 12)}: commits were added after ship, so what merged is not what the gates cleared`] };
  }

  if (f.onBase === null) return { ok: false, reasons: ['the merge commit was not checked against the base branch'] };
  if (f.onBase !== true) return { ok: false, reasons: [f.onBase.error] };

  if (f.after === null) return { ok: false, reasons: ['the metric was not read after the merge'] };
  if (!f.after.ok) return { ok: false, reasons: [`the metric could not be read after the merge: ${f.after.reason}`] };
  if (f.after.reading.sha !== pr.mergeSha) return { ok: false, reasons: [`the after reading is at ${f.after.reading.sha.slice(0, 12)}, not the merge commit ${pr.mergeSha.slice(0, 12)}`] };
  if (f.after.reading.command !== f.before.command) {
    return { ok: false, reasons: [`the Measure command changed since the before reading ("${f.before.command}" -> "${f.after.reading.command}"): the two numbers are not comparable`] };
  }
  if (f.after.reading.scriptSha256 !== f.before.scriptSha256) {
    return { ok: false, reasons: [`the Measure script changed since the before reading (${f.before.scriptSha256.slice(0, 12)} -> ${f.after.reading.scriptSha256.slice(0, 12)}): the two numbers are not comparable`] };
  }
  return { ok: true, reasons: [] };
}

/** `gh pr view` as PrState (gh runs as the operator, read-only). */
export async function prState(url: string, cwd: string, run: Exec = coreExec): Promise<PrState | { error: string }> {
  const r = await run('gh', ['pr', 'view', url, '--json', 'url,number,state,mergedAt,mergedBy,mergeCommit,baseRefName,headRefOid'], {
    cwd,
    timeoutMs: 60_000,
    env: passThroughEnv(['GH_TOKEN', 'GITHUB_TOKEN']),
  });
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim().split('\n')[0] ?? `gh exited ${String(r.code)}` };
  try {
    const j = JSON.parse(r.stdout) as {
      url: string; number: number; state: string; mergedAt: string | null;
      mergedBy: { login?: string } | null; mergeCommit: { oid?: string } | null; baseRefName: string; headRefOid: string;
    };
    return {
      url: j.url,
      number: j.number,
      state: j.state,
      mergedAt: j.mergedAt,
      mergedBy: j.mergedBy?.login ?? null,
      mergeSha: j.mergeCommit?.oid ?? null,
      baseRef: j.baseRefName,
      headSha: j.headRefOid,
    };
  } catch (e) {
    return { error: `gh printed no JSON (${e instanceof Error ? e.message : String(e)})` };
  }
}

export interface CloseOptions {
  /** Directory holding docs/contracts/ and items/. */
  root: string;
  harnessRoot: string;
  slug: string;
  /** The target repository clone (its origin is the contract's Repo). */
  repoDir: string;
  exec?: Exec;
  now?: () => Date;
}

export interface CloseResult extends OutcomeVerdict {
  facts: OutcomeFacts;
  lines: string[];
}

export async function closeItem(opts: CloseOptions): Promise<CloseResult> {
  const run = opts.exec ?? coreExec;
  const status = itemStatus(opts.root, opts.slug);
  const facts: OutcomeFacts = { status, shipped: null, before: null, pr: null, onBase: null, after: null };
  const finish = (): CloseResult => {
    const v = outcomeVerdict(facts);
    return { ...v, facts, lines: v.ok ? [] : v.reasons.map((r) => `outcome  REFUSE  ${r}`) };
  };

  for (const e of status.ledger.entries) {
    if (e.event.type === 'shipped') facts.shipped = { entry: e, event: e.event };
    if (e.event.type === 'metric' && e.event.phase === 'before') facts.before = e.event.reading;
  }
  if (preconditions(facts).length > 0) return finish();
  const shipped = facts.shipped;
  if (shipped === null || shipped.event.prUrl === null) return finish();

  facts.pr = await prState(shipped.event.prUrl, opts.repoDir, run);
  if ('error' in facts.pr || facts.pr.state !== 'MERGED' || facts.pr.mergeSha === null) return finish();
  const mergeSha = facts.pr.mergeSha;
  const base = facts.pr.baseRef;

  const fetch = await run('git', ['-C', opts.repoDir, 'fetch', '--quiet', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: opts.repoDir, timeoutMs: 120_000, env: passThroughEnv(['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN']) });
  if (fetch.code !== 0) facts.onBase = { error: `git fetch origin ${base} failed: ${(fetch.stderr || fetch.stdout).trim().split('\n')[0] ?? ''}` };
  else {
    const anc = await run('git', ['-C', opts.repoDir, 'merge-base', '--is-ancestor', mergeSha, `origin/${base}`], { cwd: opts.repoDir });
    facts.onBase = anc.code === 0 ? true : { error: `the merge commit ${mergeSha.slice(0, 12)} is not on origin/${base}` };
  }
  if (facts.onBase !== true) return finish();

  const measure = status.contract.parse?.measure ?? null;
  if (measure === null) return finish();
  facts.after = await readMetric({ harnessRoot: opts.harnessRoot, itemsRoot: opts.root, repoDir: opts.repoDir, ref: mergeSha, measure, exec: run, label: opts.slug });
  const result = finish();
  if (!result.ok || facts.after.ok !== true || facts.before === null) return result;

  // Record: the after reading, the closed entry, and both values side by side in the contract.
  const paths = itemPaths(opts.root, opts.slug);
  const after = facts.after.reading;
  const before = facts.before;
  const pr = facts.pr as PrState;
  appendLedger(paths.ledger, { type: 'metric', phase: 'after', reading: after }, opts.now);
  appendLedger(paths.ledger, { type: 'closed', before, after, prUrl: pr.url, mergeSha, mergedBy: pr.mergedBy ?? '', closeRunId: randomUUID().slice(0, 8) }, opts.now);
  writeMetricValues(paths.contract, String(before.value), String(after.value));
  return {
    ...result,
    lines: [
      `outcome  pass  PR #${pr.number} merged by ${pr.mergedBy ?? '?'} at ${pr.mergedAt ?? '?'} (${mergeSha.slice(0, 12)} on origin/${base})`,
      `metric   ${status.contract.parse?.metric?.name ?? 'metric'}: before ${before.value} (at ${before.sha.slice(0, 12)}) -> after ${after.value} (at ${after.sha.slice(0, 12)})`,
    ],
  };
}
