/**
 * `harness ship <runId>` for a run that stopped part-way. The run's own ledger entry says NOT DONE (stopped by
 * signal), so its item cannot close on it. A ship re-runs every gate fresh on the kept worktree; only when they
 * are green, with agent code confined, does it record a DONE run of the approved text, immediately before the
 * `shipped` entry, and then the outcome check's preconditions hold. A dry run, and a fresh ship that is not
 * green (here: no working sandbox, so UNPROVEN), record nothing and leave the item unclosable.
 *
 * Offline: the scripted users-api run, stopped (as by Ctrl-C) the moment the model calls finish, a local bare
 * origin, and a fake `gh` on PATH; `harness ship` is the real CLI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createScriptedDriver } from '../../plugins/drivers/scripted.ts';
import { main } from '../../src/core/cli.ts';
import { ledgerFacts, preconditions } from '../../src/core/close.ts';
import { itemPaths, itemStatus, readLedger, SHIP_DONE_VERDICT, type LedgerEntry } from '../../src/core/items.ts';
import { defineDriver } from '../../src/core/plugin-api.ts';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import { approvedItem, bareOrigin, collector, fakeGhOnPath, git, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from './helpers.ts';

const PR_URL = 'https://example.test/fixture/repo/pull/8';
const SLUG = `ship-after-stop-${process.pid}`;

let tmp: TempRepo;
let gh: ReturnType<typeof fakeGhOnPath>;
let root = '';
let summary: RunSummary;
const saved = { runs: process.env['HARNESS_RUNS_DIR'], tokens: process.env['HARNESS_TOKENS_DIR'], sandbox: process.env['HARNESS_SANDBOX'] };

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const controller = new AbortController();
/** The scripted replay, stopped by the operator (the run's AbortSignal) the moment the model calls finish. */
const stopAtFinish = defineDriver({
  name: 'scripted',
  description: 'scripted replay, stopped when the model calls finish',
  create: (opts) => {
    const d = createScriptedDriver(opts);
    return {
      ...d,
      complete: async (req, signal) => {
        const r = await d.complete(req, signal);
        if (r.parts.some((p) => p.type === 'tool_call' && p.name === 'finish')) controller.abort();
        return r;
      },
    };
  },
});

function entries(): LedgerEntry[] {
  return readLedger(itemPaths(root, SLUG).ledger).entries;
}

function outcomePreconditions(): string[] {
  const status = itemStatus(root, SLUG);
  return preconditions({ status, ...ledgerFacts(status) });
}

async function cli(args: string[]): Promise<{ code: number; text: string }> {
  const out = collector();
  const code = await main(args, out.out);
  return { code, text: out.text() };
}

beforeAll(async () => {
  tmp = tempRepo('ship-after-stop');
  bareOrigin(tmp);
  gh = fakeGhOnPath(tmp.dir, PR_URL);
  process.env['HARNESS_RUNS_DIR'] = tmp.runsDir;
  process.env['HARNESS_TOKENS_DIR'] = tmp.tokensDir;
  root = (await approvedItem(tmp, SLUG)).root;
  summary = await executeRun({
    taskFile: USERS_TASK,
    driver: 'scripted',
    driverOptions: { script: join(SCRIPTS, 'users-api.json') },
    extraDrivers: [stopAtFinish],
    baseline: false,
    ship: true,
    item: SLUG,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    signal: controller.signal,
    log: () => undefined,
  });
}, 400_000);

afterAll(() => {
  gh.restore();
  restoreEnv('HARNESS_RUNS_DIR', saved.runs);
  restoreEnv('HARNESS_TOKENS_DIR', saved.tokens);
  restoreEnv('HARNESS_SANDBOX', saved.sandbox);
  tmp.cleanup();
});

describe('harness ship <runId> after a run that stopped part-way', () => {
  it('the stopped run: aborted, NOT DONE on its ledger entry, --ship refused, nothing pushed, the item cannot close', () => {
    expect(summary.status).toBe('aborted');
    expect(summary.ship).toMatchObject({ status: 'refused', reasons: ['stopped by signal'] });
    expect(entries().at(-1)?.event).toMatchObject({ type: 'run', runId: summary.runId, verdict: 'NOT DONE (loop ended aborted)' });
    expect(git(tmp.repo, ['ls-remote', 'origin', `refs/heads/${summary.branch}`])).toBe('');
    expect(outcomePreconditions()).toEqual(['the harness never shipped this item: there is no PR it opened (harness run <task> --item <slug> --ship)']);
  });

  it('a dry run re-runs every gate fresh and records nothing', async () => {
    const before = entries().length;
    const r = await cli(['ship', summary.runId, '--dry-run']);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/^gates \(re-run fresh, phase ship\): all green$/m);
    expect(entries()).toHaveLength(before);
  });

  it('a fresh ship that is not green (agent code would run unconfined: UNPROVEN) records no DONE run and ships nothing', async () => {
    const before = entries().length;
    process.env['HARNESS_SANDBOX'] = 'off';
    let r: { code: number; text: string };
    try {
      r = await cli(['ship', summary.runId]);
    } finally {
      restoreEnv('HARNESS_SANDBOX', saved.sandbox);
    }
    expect(r.code, r.text).toBe(1);
    expect(r.text).toMatch(/^ship {2}refused/m);
    expect(r.text).toMatch(/the ship gates ran agent code without a working sandbox \(isolation: off \(agent code ran unconfined\)\): UNPROVEN is never DONE, so no DONE run can be recorded and nothing ships/);
    expect(entries()).toHaveLength(before);
    expect(gh.calls().some((c) => c.startsWith('pr create'))).toBe(false);
    expect(git(summary.worktree, ['rev-list', '--count', `${tmp.baseSha}..HEAD`])).toBe('0');
    expect(outcomePreconditions()).toEqual(['the harness never shipped this item: there is no PR it opened (harness run <task> --item <slug> --ship)']);
  });

  it('a fresh green ship records the DONE run immediately before shipped, and the outcome preconditions hold', async () => {
    const r = await cli(['ship', summary.runId]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(new RegExp(`^ship {2}shipped {2}branch ${summary.branch} {2}commit [0-9a-f]{40} {2}${PR_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
    const [stopped, done, shipped] = entries().slice(-3);
    const hash = itemStatus(root, SLUG).contract.parse?.hash;
    expect(stopped?.event).toMatchObject({ type: 'run', runId: summary.runId, verdict: 'NOT DONE (loop ended aborted)', contractHash: hash });
    expect(done?.event).toMatchObject({ type: 'run', runId: summary.runId, status: 'ship', verdict: SHIP_DONE_VERDICT, contractHash: hash });
    expect(shipped?.event).toMatchObject({ type: 'shipped', runId: summary.runId, branch: summary.branch, prUrl: PR_URL, base: 'main' });
    expect(outcomePreconditions()).toEqual([]);
  });
});
