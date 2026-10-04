/**
 * E2E (a) greenfield users-api on a throwaway git repo, then (e) ship it: dry run first,
 * then a real commit + push to a local bare remote with `gh` unavailable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/core/cli.ts';
import { loadConfig } from '../../src/core/config.ts';
import { loadRegistry, toolSpecs } from '../../src/core/registry.ts';
import { executeRun, openRun, type RunSummary } from '../../src/core/run.ts';
import { detectMechanism, POLICY_SUMMARY } from '../../src/core/sandbox.ts';
import { ship } from '../../src/core/ship.ts';
import {
  changedFiles,
  collector,
  execWithoutGh,
  git,
  readEvents,
  readRunJson,
  ROOT,
  SCRIPTS,
  tempRepo,
  TokenFileSchema,
  USERS_TASK,
  type TempRepo,
} from './helpers.ts';

let tmp: TempRepo;
let summary: RunSummary;
const printed = collector();
const commands: string[] = [];

beforeAll(async () => {
  tmp = tempRepo('greenfield');
  summary = await executeRun({
    taskFile: USERS_TASK,
    driver: 'scripted',
    driverOptions: { script: join(SCRIPTS, 'users-api.json') },
    baseline: false,
    ship: false,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(commands),
    log: printed.out,
  });
}, 300_000);

afterAll(() => tmp.cleanup());

describe('greenfield users-api (scripted) in a throwaway repo', () => {
  it('finishes done with every gate green (contract-lock n/a)', () => {
    expect(summary.error).toBeUndefined();
    expect(summary.status).toBe('done');
    expect(summary.ok).toBe(true);
    const byGate = Object.fromEntries(summary.gates.map((g) => [g.gate, g.status]));
    expect(byGate).toMatchObject({ 'contract-lock': 'n/a', 'observed-red': 'pass', scope: 'pass', standards: 'pass', 'tests-green': 'pass' });
    for (const g of summary.gates) expect(['pass', 'n/a'], `${g.gate}: ${g.summary}`).toContain(g.status);
    expect(summary.standards).toEqual({ status: 'pass', percent: 100 });
  });

  it('targets the temp repo, worktree under the harness, evidence outside runs/ and tokens/', () => {
    expect(summary.targetRepo).toBe(tmp.repo);
    expect(summary.worktree.startsWith(join(ROOT, '.harness', 'worktrees'))).toBe(true);
    expect(summary.runDir.startsWith(tmp.runsDir)).toBe(true);
    expect(summary.tokensPath.startsWith(tmp.tokensDir)).toBe(true);
    expect(existsSync(join(ROOT, 'runs', summary.runId))).toBe(false);
    expect(existsSync(join(ROOT, 'tokens', `${summary.runId}.json`))).toBe(false);
  });

  it('never dirties the target checkout: main unchanged and clean; only the worktree changed', () => {
    expect(git(tmp.repo, ['rev-parse', 'main'])).toBe(tmp.baseSha);
    expect(git(tmp.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(git(summary.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(summary.branch);
    const changed = changedFiles(summary.worktree);
    expect(changed).toContain('generated/users-api/src/routes/users.ts');
    for (const f of changed) expect(f.startsWith('generated/users-api/'), f).toBe(true);
  });

  it('writes a per-turn token report', () => {
    const report = TokenFileSchema.parse(JSON.parse(readFileSync(summary.tokensPath, 'utf8')));
    expect(report.runId).toBe(summary.runId);
    expect(report.turns).toHaveLength(summary.turns);
    expect(report.totals.baseline_input_tokens).toBeGreaterThan(report.totals.actual_input_tokens);
    expect(report.totals.reduction_pct).toBeGreaterThan(50);
  });

  it('records run.json with fingerprint and an honesty section', async () => {
    const run = readRunJson(summary.runDir);
    expect(run.status).toBe('done');
    expect(Object.keys(run.pluginFingerprint).some((f) => f.startsWith('plugins/hooks/'))).toBe(true);
    expect(Object.keys(run.pluginFingerprint).some((f) => f.startsWith('plugins/drivers/'))).toBe(false);
    // shared helpers are fingerprinted too, so a zero agnostic diff covers the logic plugins import
    expect(run.pluginFingerprint).toHaveProperty(['plugins/lib/red.ts']);
    expect(run.pluginFingerprint).toHaveProperty(['plugins/lib/contract.ts']);
    // the tools exactly as offered to the model (order included) and the registered checks
    const registry = await loadRegistry(loadConfig(ROOT), ROOT);
    expect(run.toolsOffered).toEqual(toolSpecs(registry.tools, 'greenfield').map((t) => t.name));
    expect(run.toolsOffered).toEqual(expect.arrayContaining(['write_file', 'run_tests', 'finish']));
    expect(run.checksRegistered).toEqual(registry.checks.map((c) => c.plugin.id));
    expect(run.checksRegistered).toEqual(expect.arrayContaining(['problem-json', 'rest-conventions', 'tsc-strict', 'zod-boundary']));
    expect(run.honesty.proven).toEqual(expect.arrayContaining(['gate:tests-green', 'gate:observed-red', 'check:zod-boundary']));
    expect(run.honesty.notApplicable).toContain('gate:contract-lock');
    expect(run.honesty.failed).toEqual([]);
    expect(run.honesty.unproven).toEqual([]);
    // agent code (tests, probes, contract runtime) ran confined by the OS sandbox, and the run says so
    const mechanism = detectMechanism();
    expect(mechanism).not.toBe('none');
    expect(run['isolation']).toEqual({ mode: 'auto', mechanism, policy: POLICY_SUMMARY });
    expect(run.honesty.proven).toContain(`isolation:${mechanism} (${POLICY_SUMMARY})`);
    for (const f of ['events.jsonl', 'transcript.jsonl', 'gates.json', 'standards.txt', 'state.json']) {
      expect(existsSync(join(summary.runDir, f)), f).toBe(true);
    }
    expect(readEvents(summary.runDir).some((e) => e.source === 'finish' && e.decision === 'pass')).toBe(true);
  });

  it('prints status, every gate, standards, tokens, evidence and honesty', () => {
    // The preflight target profile is printed before the first model turn; the run summary follows at the end.
    const text = printed.text();
    expect(text.endsWith(summary.text)).toBe(true);
    expect(text).toMatch(/^target\s+framework express \S+\s+runner vitest/);
    expect(text).toMatch(/^\s+source src\/\s+tests test\//m);
    expect(text).toMatch(/^status\s+done\s+turns \d+/m);
    for (const g of summary.gates) expect(text).toContain(`gate  ${g.gate}`);
    expect(text).toMatch(/^standards\s+pass 100%/m);
    expect(text).toMatch(/^tokens\s+actual \d+\s+baseline \d+\s+reduction [\d.]+%/m);
    expect(text).toMatch(/^evidence\s+/m);
    expect(text).toMatch(/^honesty$/m);
    expect(text).toMatch(/human must verify/);
    expect(text).toMatch(/^verdict\s+DONE/m);
  });

  it('the generated API passes `harness check --api` at 100%', async () => {
    const out = collector();
    const code = await main(['check', '--api', join(summary.worktree, 'generated', 'users-api')], out.out);
    expect(code, out.text()).toBe(0);
    expect(out.text()).toMatch(/verdict\s+100%/);
  });
});

describe('ship (the harness ships; never the agent)', () => {
  it('dry run lists the commands and executes none of them', async () => {
    const { ctx, registry } = await openRun(summary.runId, { runsDir: tmp.runsDir, tokensDir: tmp.tokensDir, exec: execWithoutGh() });
    const r = await ship({ ctx, registry, dryRun: true });
    expect(r.status).toBe('dry-run');
    const plan = r.commands ?? [];
    expect(plan.some((c) => c.includes(' add '))).toBe(true);
    expect(plan.some((c) => c.includes(' commit '))).toBe(true);
    expect(plan.some((c) => c.includes(' push --no-force '))).toBe(true);
    expect(plan.some((c) => c.startsWith('gh pr create'))).toBe(true);
    // the PR body carries the report verdict and the ship-phase standards gate result
    const pr = plan.find((c) => c.startsWith('gh pr create')) ?? '';
    // tolerant of extra (grader-added) checks: column widths and rule counts may change
    expect(pr).toMatch(/verdict\s+100%/);
    expect(pr).toMatch(/standards gate \(ship\): pass verdict 100% \(\d+ rules/);
    expect(r.gates?.ok).toBe(true);
    expect(r.gates?.text).toMatch(/^gate\s+standards\s+pass/m);
    expect(git(summary.worktree, ['rev-parse', 'HEAD'])).toBe(tmp.baseSha);
    expect(git(summary.worktree, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('the CLI dry run accepts a run directory and exits 0', async () => {
    const out = collector();
    const code = await main(['ship', summary.runDir, '--dry-run'], out.out);
    expect(code, out.text()).toBe(0);
    expect(out.text()).toMatch(/^ship\s+dry-run/m);
    // the fresh ship-phase gate lines come before the plan
    const lines = out.text().split('\n');
    const gatesAt = lines.findIndex((l) => l.startsWith('gates (re-run fresh, phase ship): all green'));
    const standardsAt = lines.findIndex((l) => /^ {2}gate\s+standards\s+pass/.test(l));
    const planAt = lines.findIndex((l) => l.includes('plan: '));
    expect(gatesAt, out.text()).toBeGreaterThan(-1);
    expect(standardsAt).toBeGreaterThan(gatesAt);
    expect(planAt).toBeGreaterThan(standardsAt);
    expect(git(summary.worktree, ['rev-parse', 'HEAD'])).toBe(tmp.baseSha);
  });

  it('commits and pushes the run branch to a local bare remote; no gh → committed; main untouched', async () => {
    const bare = join(tmp.dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(tmp.repo, ['remote', 'add', 'origin', bare]);
    const seen: string[] = [];
    const { ctx, registry } = await openRun(summary.runDir, { runsDir: tmp.runsDir, tokensDir: tmp.tokensDir, exec: execWithoutGh(seen) });
    const r = await ship({ ctx, registry, dryRun: false });
    expect(r.status, r.reasons.join('\n')).toBe('committed');
    expect(r.reasons.join(' ')).toMatch(/gh/);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(seen.some((c) => c.startsWith('gh pr'))).toBe(false);

    const remoteRefs = git(tmp.repo, ['ls-remote', bare]);
    expect(remoteRefs).toContain(`refs/heads/${summary.branch}`);
    expect(remoteRefs).not.toMatch(/refs\/heads\/main\b/);
    expect(git(bare, ['rev-parse', `refs/heads/${summary.branch}`])).toBe(r.commit);
    // Only the API root is committed, by the harness identity.
    const files = git(tmp.repo, ['diff', '--name-only', `${tmp.baseSha}..${r.commit ?? ''}`]).split('\n');
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(f.startsWith('generated/users-api/'), f).toBe(true);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(git(tmp.repo, ['log', '-1', '--format=%an', r.commit ?? ''])).toBe('sf-harness');
    // The target checkout and main are untouched.
    expect(git(tmp.repo, ['rev-parse', 'main'])).toBe(tmp.baseSha);
    expect(git(tmp.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });
});
