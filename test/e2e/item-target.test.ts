/**
 * An approved item authorizes its own work only (file mode). Before any worktree or token:
 *   - a closed item is refused (its approval covered the work that closed it);
 *   - the target clone's origin must be the contract's Repo, and its current branch the contract's Base
 *     (the run's worktree starts from it).
 * Each refusal leaves no worktree, branch or evidence behind; the legitimate twin is every other e2e
 * run (tempRepo: origin fixture/repo, on main, as the fixture contracts say) and the bound item below.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { targetRepoProblem } from '../../src/core/item-cli.ts';
import { appendLedger, itemPaths, parseContract } from '../../src/core/items.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { bindItem, executeRun } from '../../src/core/run.ts';
import { exec } from '../../src/core/exec.ts';
import { approveForTest, contractFor } from '../support/items.ts';
import { git, SCRIPTS, tempRepo, USERS_TASK } from './helpers.ts';

const tmp = tempRepo('item-target');
const roots: string[] = [];
afterAll(() => tmp.cleanup());
afterEach(() => {
  git(tmp.repo, ['switch', '-q', 'main']);
  git(tmp.repo, ['remote', 'set-url', 'origin', join(tmp.dir, 'remotes', 'fixture', 'repo.git')]);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function run(): ReturnType<typeof executeRun> {
  return executeRun({
    taskFile: USERS_TASK,
    driver: 'scripted',
    driverOptions: { script: join(SCRIPTS, 'users-api.json') },
    baseline: false,
    ship: false,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    log: () => undefined,
  });
}

function untouched(): void {
  expect(existsSync(tmp.runsDir)).toBe(false);
  expect(git(tmp.repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
  expect(git(tmp.repo, ['branch', '--list', 'harness/*'])).toBe('');
}

describe('an approved item authorizes its own repository and base only', () => {
  it("refuses a clone whose origin is not the contract's Repo", async () => {
    git(tmp.repo, ['remote', 'set-url', 'origin', 'git@github.com:other-org/other-repo.git']);
    await expect(run()).rejects.toThrow(/refused before the first model turn \(no tokens spent\): item "users-api": the target is not the contract's Repo \(fixture\/repo\): .*origin is git@github\.com:other-org\/other-repo, not fixture\/repo/);
    untouched();
  });

  it('refuses a clone with no origin at all', async () => {
    git(tmp.repo, ['remote', 'remove', 'origin']);
    await expect(run()).rejects.toThrow(/the target is not the contract's Repo \(fixture\/repo\): .* has no origin remote/);
    git(tmp.repo, ['remote', 'add', 'origin', join(tmp.dir, 'remotes', 'fixture', 'repo.git')]);
    untouched();
  });

  it("refuses a clone on another branch than the contract's Base, or on a detached HEAD", async () => {
    git(tmp.repo, ['switch', '-q', '-c', 'some-feature']);
    await expect(run()).rejects.toThrow(/is on some-feature, but the contract's Base is main: the run would start from another branch than the approved one \(git switch main\)/);
    git(tmp.repo, ['switch', '-q', '--detach', 'main']);
    await expect(run()).rejects.toThrow(/is not on a branch \(detached HEAD\), but the run starts from the contract's Base \(main\)/);
    untouched();
  });

  it('targetRepoProblem: the matching clone is accepted (the twin), in any URL spelling of the same Repo', async () => {
    const contract = parseContract(contractFor('users-api'));
    expect(await targetRepoProblem(tmp.repo, contract, exec)).toBeNull();
    for (const url of ['https://github.com/fixture/repo.git', 'git@github.com:fixture/repo.git', 'https://github.com/FIXTURE/Repo']) {
      git(tmp.repo, ['remote', 'set-url', 'origin', url]);
      expect(await targetRepoProblem(tmp.repo, contract, exec), url).toBeNull();
    }
    git(tmp.repo, ['remote', 'set-url', 'origin', 'https://github.com/fixture/repo-fork.git']);
    expect(await targetRepoProblem(tmp.repo, contract, exec)).toMatch(/not the contract's Repo/);
  });

  it('bindItem refuses a closed item; the same item before it closed binds (the twin)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'closed-item-'));
    roots.push(root);
    approveForTest(root, 'done-item');
    const registry = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    expect(bindItem('done-item', registry, root)).toMatchObject({ slug: 'done-item' });
    const r = { value: 0, sha: 'a'.repeat(40), ref: 'main', command: 'node metrics/fixture-zero.mjs', scriptSha256: 'b'.repeat(64), stdoutSha256: 'c'.repeat(64), excerpt: '0', confinement: 'sandbox-exec' };
    appendLedger(itemPaths(root, 'done-item').ledger, { type: 'closed', before: r, after: r, prUrl: 'https://example.test/pull/1', mergeSha: 'a'.repeat(40), mergedBy: 'a-person', closeRunId: 'x' });
    expect(() => bindItem('done-item', registry, root)).toThrow(/refused before the first model turn \(no tokens spent\): item "done-item" is closed \(ledger seq \d+\): .* new work needs a new item/);
  });
});
