/**
 * Writing in place (a session in the owner's checkout): writable only on a working branch, with no
 * merge/rebase/cherry-pick/bisect in progress and a clean tree at session start; the branch-guard
 * hook re-checks the branch before every write of an in-place run and has nothing to check in a
 * worktree run. Every refusal has its legitimate twin, and the harness never runs the fix itself.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import branchGuard from '../../plugins/hooks/branch-guard.ts';
import contractGate from '../../plugins/hooks/contract-gate.ts';
import problemGate from '../../plugins/hooks/problem-gate.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { missingRequiredHooks, REQUIRED_INPLACE_HOOKS } from '../../src/core/hooks.ts';
import { branchVerdict, inPlaceWritability } from '../../src/core/inplace.ts';
import { proposeItem, recordReply } from '../../src/core/items.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { bindItem, buildContext } from '../../src/core/run.ts';
import { newRunState, RunStore } from '../../src/core/run-store.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type { Exec, HookPlugin, PluginRecord, RegistryView, RunContext, ToolCallInfo } from '../../src/core/types.ts';
import { writeContract } from '../support/items.ts';
import { CONFIG, fakeCtx } from '../core-loop/fakes.ts';

const config = { protectedBranches: ['main', 'master', 'development', 'develop', 'staging', 'production', 'release/*'] };
let base: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.editor=true', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitMayFail(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // a conflict stops the operation half way, which is the state under test
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'inplace-')));
  repo = join(base, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'switch', '-q', '-c', 'fix/login');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A second branch whose a.txt conflicts with fix/login's. */
function conflictingBranches(): void {
  git(repo, 'switch', '-q', '-c', 'other', 'main');
  writeFileSync(join(repo, 'a.txt'), 'other\n');
  git(repo, 'commit', '-q', '-am', 'other');
  git(repo, 'switch', '-q', 'fix/login');
  writeFileSync(join(repo, 'a.txt'), 'mine\n');
  git(repo, 'commit', '-q', '-am', 'mine');
}

describe('inPlaceWritability', () => {
  it('a clean working branch is writable (the legitimate twin)', async () => {
    expect(await inPlaceWritability(repo, config)).toEqual({ writable: true, reason: '', fix: '', branch: 'fix/login' });
  });

  it('a protected branch is refused, with the command that fixes it', async () => {
    git(repo, 'switch', '-q', 'main');
    for (const b of ['main', 'development', 'staging', 'release/2.1']) {
      if (b !== 'main') git(repo, 'switch', '-q', '-c', b);
      const v = await inPlaceWritability(repo, config);
      expect(v.writable, b).toBe(false);
      expect(v.reason).toBe(`the branch ${b} is protected (harness.config.json protectedBranches)`);
      expect(v.fix).toMatch(/git switch -c <name>/);
    }
  });

  it('a detached HEAD is refused', async () => {
    git(repo, 'switch', '-q', '--detach', 'HEAD');
    const v = await inPlaceWritability(repo, config);
    expect(v).toMatchObject({ writable: false, reason: 'HEAD is detached (not on a branch)', branch: null });
    expect(v.fix).toMatch(/git switch -c/);
  });

  it('a branch with no commit yet is refused', async () => {
    const empty = join(base, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'feat/x');
    expect(await inPlaceWritability(empty, config)).toMatchObject({ writable: false, reason: 'the branch feat/x has no commit yet' });
  });

  it('a merge, rebase, cherry-pick or bisect in progress is refused, named as such (not as a detached HEAD)', async () => {
    conflictingBranches();
    gitMayFail(repo, 'merge', 'other');
    expect(await inPlaceWritability(repo, config)).toMatchObject({ writable: false, reason: 'a merge is in progress' });
    git(repo, 'merge', '--abort');

    gitMayFail(repo, 'rebase', 'other');
    const rebase = await inPlaceWritability(repo, config);
    expect(rebase).toMatchObject({ writable: false, reason: 'a rebase is in progress' });
    expect(rebase.fix).toMatch(/git rebase --abort/);
    git(repo, 'rebase', '--abort');

    gitMayFail(repo, 'cherry-pick', 'other');
    expect(await inPlaceWritability(repo, config)).toMatchObject({ writable: false, reason: 'a cherry-pick is in progress' });
    git(repo, 'cherry-pick', '--abort');

    git(repo, 'bisect', 'start');
    expect(await inPlaceWritability(repo, config)).toMatchObject({ writable: false, reason: 'a bisect is in progress', fix: 'end it (git bisect reset)' });
    git(repo, 'bisect', 'reset');

    expect((await inPlaceWritability(repo, config)).writable).toBe(true);
  });

  it('a dirty tree at session start is refused; the branch checks alone (made before each write) do not look at it', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const v = await inPlaceWritability(repo, config);
    expect(v.writable).toBe(false);
    expect(v.reason).toMatch(/^the working tree has 2 uncommitted change\(s\) \(a\.txt, new\.txt\)/);
    expect(v.fix).toMatch(/git stash -u/);
    // During a session the agent's own edits make the tree dirty: that never stops a write.
    expect((await branchVerdict(repo, config)).writable).toBe(true);
  });

  it("a git worktree has its own state: a merge in the main checkout does not block a worktree's branch", async () => {
    conflictingBranches();
    const wt = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/side', wt, 'main');
    gitMayFail(repo, 'merge', 'other');
    expect((await inPlaceWritability(repo, config)).writable).toBe(false);
    expect(await inPlaceWritability(wt, config)).toMatchObject({ writable: true, branch: 'feat/side' });
  });

  it('a git query that fails is a refusal (fail closed)', async () => {
    const broken: Exec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository', durationMs: 0, timedOut: false });
    const v = await inPlaceWritability(repo, config, broken);
    expect(v.writable).toBe(false);
    expect(v.reason).toMatch(/could not be read/);
  });
});

describe('branch-guard hook', () => {
  const write: ToolCallInfo = { id: 'c1', tool: 'write_file', effect: 'write', input: { path: 'a.txt' }, paths: ['a.txt'] };
  function ctx(inPlace?: RunContext['inPlace']): RunContext {
    const c = fakeCtx().ctx;
    return { ...c, config: { ...CONFIG, protectedBranches: config.protectedBranches }, exec: coreExec, ...(inPlace !== undefined ? { inPlace } : {}) };
  }
  const run = (c: RunContext) => branchGuard.run({ event: 'pre_tool', call: write }, c);

  it('in place on the working branch the session started on: the write passes', async () => {
    expect(await run(ctx({ repoTop: repo, branch: 'fix/login' }))).toEqual({ decision: 'pass' });
  });

  it('the owner switched branches since the session started: refused, naming both branches', async () => {
    const c = ctx({ repoTop: repo, branch: 'fix/login' });
    git(repo, 'switch', '-q', '-c', 'fix/other');
    const v = await run(c);
    expect(v).toMatchObject({ decision: 'block' });
    if (v.decision === 'block') expect(v.reason).toMatch(/HEAD moved from fix\/login \(where this session started\) to fix\/other.*git switch fix\/login/);
    git(repo, 'switch', '-q', 'main');
    const p = await run(c);
    if (p.decision === 'block') expect(p.reason).toMatch(/the branch main is protected.*never switches branches or stashes/);
    else throw new Error('expected a block on main');
  });

  it('a rebase started mid-session stops the next write', async () => {
    conflictingBranches();
    const c = ctx({ repoTop: repo, branch: 'fix/login' });
    gitMayFail(repo, 'rebase', 'other');
    const v = await run(c);
    expect(v.decision).toBe('block');
    if (v.decision === 'block') expect(v.reason).toMatch(/a rebase is in progress\. Fix: .*git rebase --abort/);
  });

  it('a worktree run (no inPlace) has nothing to check: it passes even on a protected branch (file mode unchanged)', async () => {
    git(repo, 'switch', '-q', 'main');
    expect(await run(ctx())).toEqual({ decision: 'pass' });
  });

  it('a run over the owner\'s checkout (git-visibility workspace) with no in-place record is refused, not waved through', async () => {
    const c = { ...ctx(), workspace: createWorkspace(repo, '.', { visibility: 'git' }) };
    const v = await run(c);
    expect(v.decision).toBe('block');
    if (v.decision === 'block') expect(v.reason).toMatch(/reads the owner's checkout \(a git-visibility workspace\) but carries no record of the branch it started on/);
    // the twin: the same workspace with its in-place record, on the working branch, passes
    expect(await run({ ...c, inPlace: { repoTop: repo, branch: 'fix/login' } })).toEqual({ decision: 'pass' });
  });

  it('is registered from plugins/hooks and runs on write-effect pre_tool calls only', async () => {
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const h = reg.hooks.find((r) => r.plugin.name === 'branch-guard');
    expect(h?.file).toBe('plugins/hooks/branch-guard.ts');
    expect(h?.plugin.events).toEqual(['pre_tool']);
    expect(h?.plugin.effects).toEqual(['write']);
  });
});

describe('required hooks of an in-place run', () => {
  const rec = (plugin: HookPlugin): PluginRecord<HookPlugin> => ({ plugin, file: 'plugins/hooks/x.ts', sha256: '0' });

  it('an in-place run needs branch-guard on top of the item hooks; a file-mode run does not (the twin)', () => {
    const itemHooks = [rec(problemGate), rec(contractGate)];
    expect(REQUIRED_INPLACE_HOOKS).toEqual(['branch-guard']);
    expect(missingRequiredHooks(itemHooks)).toEqual([]);
    expect(missingRequiredHooks(itemHooks, { inPlace: true })).toEqual(['branch-guard']);
    expect(missingRequiredHooks([...itemHooks, rec(branchGuard)], { inPlace: true })).toEqual([]);
  });

  it('bindItem refuses an in-place run whose registry lacks branch-guard, before the first model turn; in place is read from the context', () => {
    const root = join(base, 'items');
    writeContract(root, 'guard-export');
    proposeItem(root, 'guard-export', { session: 's', before: null });
    recordReply(root, 'guard-export', 'yes', 'tty', 's');
    const itemOnly = { hooks: [rec(problemGate), rec(contractGate)] } as unknown as RegistryView;
    const inPlace = { repoTop: repo, branch: 'fix/login' };
    const gitWs = createWorkspace(repo, '.', { visibility: 'git' });
    // Either sign of an in-place run is enough: its record, or a workspace over the owner's checkout.
    expect(() => bindItem('guard-export', itemOnly, root, { inPlace })).toThrow(/required hook\(s\) branch-guard not registered .* or a write on a branch other than the working branch/);
    expect(() => bindItem('guard-export', itemOnly, root, { workspace: gitWs })).toThrow(/branch-guard not registered/);
    expect(bindItem('guard-export', itemOnly, root)).toMatchObject({ slug: 'guard-export' });
    expect(bindItem('guard-export', itemOnly, root, { workspace: createWorkspace(repo, '.') })).toMatchObject({ slug: 'guard-export' });
    const all = { hooks: [rec(problemGate), rec(contractGate), rec(branchGuard)] } as unknown as RegistryView;
    expect(bindItem('guard-export', all, root, { inPlace, workspace: gitWs })).toMatchObject({ slug: 'guard-export' });
  });

  it('buildContext refuses an in-place workspace without its record, or without branch-guard; the complete twin builds', () => {
    const base0 = fakeCtx().ctx;
    const store = new RunStore(join(base, 'run'), base);
    const all = { ...base0.registry, hooks: [rec(problemGate), rec(contractGate), rec(branchGuard)] };
    const build = (o: { ws: ReturnType<typeof createWorkspace>; inPlace?: RunContext['inPlace']; registry?: RegistryView }) =>
      buildContext({ run: base0.run, task: base0.task, ws: o.ws, state: newRunState(), store, mode: base0.mode, config: CONFIG, registry: o.registry ?? all, ...(o.inPlace !== undefined ? { inPlace: o.inPlace } : {}) });
    const gitWs = createWorkspace(repo, '.', { visibility: 'git' });
    const inPlace = { repoTop: repo, branch: 'fix/login' };
    expect(() => build({ ws: gitWs })).toThrow(/git visibility\) but the run carries no in-place record/);
    expect(() => build({ ws: gitWs, inPlace, registry: { ...all, hooks: [rec(problemGate), rec(contractGate)] } })).toThrow(/needs the branch-guard hook/);
    expect(build({ ws: gitWs, inPlace }).inPlace).toEqual(inPlace);
    // file-mode twin: a worktree workspace builds without either
    expect(build({ ws: createWorkspace(repo, '.'), registry: { ...all, hooks: [] } }).inPlace).toBeUndefined();
  });
});
