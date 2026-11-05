/**
 * The session state directory lives outside the repository and outside the harness repo
 * (SF_HARNESS_HOME, else ~/.sf-harness), one per checkout, and one live session holds a checkout's
 * lock at a time. Every test uses a temp SF_HARNESS_HOME.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireCheckoutLock, lockPath, pidAlive, repoStateDir, repoStateId, safeDirName, stateHome } from '../../src/core/state-home.ts';

let base: string;
let home: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'state-home-')));
  home = join(base, 'home');
  repo = join(base, 'my-app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('stateHome', () => {
  it('is SF_HARNESS_HOME when set, else ~/.sf-harness', () => {
    expect(stateHome({ SF_HARNESS_HOME: home })).toBe(home);
    expect(stateHome({})).toBe(join(homedir(), '.sf-harness'));
    expect(stateHome({ SF_HARNESS_HOME: '  ' })).toBe(join(homedir(), '.sf-harness'));
  });
});

describe('repoStateDir', () => {
  it('names the checkout by its real git common dir and directory name, and lays out sessions, tokens and the items root', async () => {
    const d = await repoStateDir(repo, { SF_HARNESS_HOME: home });
    const common = realpathSync(join(repo, '.git'));
    expect(d.id).toBe(`${createHash('sha256').update(common).digest('hex').slice(0, 12)}-my-app`);
    expect(d.root).toBe(join(home, 'repos', d.id));
    expect(d.sessionsDir).toBe(join(d.root, 'sessions'));
    expect(d.tokensDir).toBe(join(d.root, 'tokens'));
    expect(d.itemsRoot).toBe(d.root);
    for (const p of [d.sessionsDir, d.tokensDir, d.locksDir]) expect(existsSync(p)).toBe(true);
    // Nothing is written into the repository itself.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('is the same id from a sub-directory spelling of the top, and a worktree of the same repo shares the hash', async () => {
    const a = await repoStateDir(repo, { SF_HARNESS_HOME: home });
    const wt = join(base, 'my-app-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    const b = await repoStateDir(wt, { SF_HARNESS_HOME: home });
    expect(b.id.slice(0, 12)).toBe(a.id.slice(0, 12));
    expect(b.id).toBe(`${a.id.slice(0, 12)}-my-app-wt`);
  });

  it('refuses a directory that is not a git checkout', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    await expect(repoStateDir(plain, { SF_HARNESS_HOME: home })).rejects.toThrow(/not a git checkout/);
    expect(existsSync(join(home, 'repos'))).toBe(false);
  });

  it('keeps odd directory names path-safe', () => {
    expect(safeDirName('my app (copy)')).toBe('my-app-copy-');
    expect(safeDirName('..')).toBe('repo');
    expect(repoStateId('/x/.git', '/code/web app')).toMatch(/^[0-9a-f]{12}-web-app$/);
  });
});

describe('one session per checkout', () => {
  it('a second session is refused while the first holds the lock; after release it gets it', async () => {
    const d = await repoStateDir(repo, { SF_HARNESS_HOME: home });
    const first = acquireCheckoutLock(d.locksDir, repo, { releaseOnExit: false });
    expect(first.ok).toBe(true);
    const lock = JSON.parse(readFileSync(first.path, 'utf8')) as { pid: number; startedAt: string; checkout: string };
    expect(lock.pid).toBe(process.pid);
    expect(lock.checkout).toBe(realpathSync(repo));
    expect(Number.isNaN(Date.parse(lock.startedAt))).toBe(false);

    const second = acquireCheckoutLock(d.locksDir, repo, { releaseOnExit: false });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(new RegExp(`a session is already running in .*my-app \\(pid ${process.pid}`));

    if (first.ok) first.release();
    expect(existsSync(first.path)).toBe(false);
    const third = acquireCheckoutLock(d.locksDir, repo, { releaseOnExit: false });
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it('a stale lock (its pid is dead) is taken over', async () => {
    const d = await repoStateDir(repo, { SF_HARNESS_HOME: home });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid ?? 999_999;
    expect(pidAlive(dead)).toBe(false);
    const stale = acquireCheckoutLock(d.locksDir, repo, { pid: dead, releaseOnExit: false });
    expect(stale.ok).toBe(true);
    const now = acquireCheckoutLock(d.locksDir, repo, { releaseOnExit: false });
    expect(now.ok).toBe(true);
    if (now.ok) {
      expect(now.tookOver?.pid).toBe(dead);
      expect((JSON.parse(readFileSync(now.path, 'utf8')) as { pid: number }).pid).toBe(process.pid);
      // The stale owner's release never removes the lock that replaced it.
      if (stale.ok) stale.release();
      expect(existsSync(now.path)).toBe(true);
      now.release();
    }
  });

  it('an unreadable lock is treated as held (fail closed), naming the file to remove', async () => {
    const d = await repoStateDir(repo, { SF_HARNESS_HOME: home });
    writeFileSync(lockPath(d.locksDir, repo), 'garbage');
    const r = acquireCheckoutLock(d.locksDir, repo, { releaseOnExit: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot be read; if no session is running .* remove it/);
  });

  it('two checkouts have two locks', async () => {
    const d = await repoStateDir(repo, { SF_HARNESS_HOME: home });
    const other = join(base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    const a = acquireCheckoutLock(d.locksDir, repo, { releaseOnExit: false });
    const b = acquireCheckoutLock(d.locksDir, other, { releaseOnExit: false });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) a.release();
    if (b.ok) b.release();
  });
});
