/**
 * Writing in place: whether a session may edit the owner's own checkout (no worktree of its own).
 *
 * A session writes only on a working branch the owner cut. At session start (inPlaceWritability) and
 * before every write (branchVerdict, through the branch-guard hook) the checkout is refused when:
 *   - a merge, rebase, cherry-pick, revert or bisect is in progress (checked first: a rebase leaves
 *     HEAD detached, and the owner needs to hear "rebase", not "detached");
 *   - HEAD is detached, or on a branch with no commit yet;
 *   - the branch is protected (config.protectedBranches: main, master, development, develop, staging,
 *     production, release/* and whatever harness.config.json adds);
 *   - at session start only: the working tree is not clean (the session's diff must be the agent's
 *     work alone, so the gates compare against HEAD).
 * Each refusal says why and which command fixes it. The harness itself never runs those commands: it
 * never switches branches, stashes, commits or pushes on its own. A git query that fails is a refusal.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { exec as coreExec } from './exec.ts';
import { isProtectedBranch } from './workspace.ts';
import type { Exec, HarnessConfig } from './types.ts';

export interface InPlaceVerdict {
  writable: boolean;
  /** Why not (empty when writable). */
  reason: string;
  /** The command(s) that fix it, for the owner to run (empty when writable). */
  fix: string;
  /** The branch HEAD is on (null when detached or unknown). */
  branch: string | null;
}

/** Git state files of an operation in progress, what it is called, and how the owner ends it. */
const IN_PROGRESS: ReadonlyArray<{ file: string; what: string; fix: string }> = [
  { file: 'rebase-merge', what: 'a rebase', fix: 'finish it (git rebase --continue) or abort it (git rebase --abort)' },
  { file: 'rebase-apply', what: 'a rebase (or git am)', fix: 'finish it (git rebase --continue) or abort it (git rebase --abort, or git am --abort)' },
  { file: 'MERGE_HEAD', what: 'a merge', fix: 'finish it (git commit) or abort it (git merge --abort)' },
  { file: 'CHERRY_PICK_HEAD', what: 'a cherry-pick', fix: 'finish it (git cherry-pick --continue) or abort it (git cherry-pick --abort)' },
  { file: 'REVERT_HEAD', what: 'a revert', fix: 'finish it (git revert --continue) or abort it (git revert --abort)' },
  { file: 'BISECT_LOG', what: 'a bisect', fix: 'end it (git bisect reset)' },
];

const NEW_BRANCH = 'create a working branch: git switch -c <name>';

function refuse(reason: string, fix: string, branch: string | null): InPlaceVerdict {
  return { writable: false, reason, fix, branch };
}

async function git(run: Exec, repoTop: string, args: string[]): Promise<{ code: number | null; out: string; raw: string; err: string }> {
  const r = await run('git', ['-C', repoTop, ...args], { cwd: repoTop, timeoutMs: 30_000 });
  return { code: r.code, out: r.stdout.trim(), raw: r.stdout, err: (r.stderr || r.stdout).trim().split('\n')[0] ?? '' };
}

/** The operation in progress in the checkout at `repoTop`, if any (paths through `git rev-parse --git-path`, so a worktree's own state is read). */
async function operationInProgress(run: Exec, repoTop: string): Promise<{ what: string; fix: string } | { error: string } | null> {
  for (const op of IN_PROGRESS) {
    const p = await git(run, repoTop, ['rev-parse', '--git-path', op.file]);
    if (p.code !== 0 || p.out.length === 0) return { error: `git rev-parse --git-path ${op.file} failed: ${p.err}` };
    if (existsSync(isAbsolute(p.out) ? p.out : resolve(repoTop, p.out))) return op;
  }
  return null;
}

/**
 * The branch checks, run before every in-place write: no operation in progress, HEAD on a branch that
 * has a commit and is not protected.
 */
export async function branchVerdict(repoTop: string, config: Pick<HarnessConfig, 'protectedBranches'>, run: Exec = coreExec): Promise<InPlaceVerdict> {
  const op = await operationInProgress(run, repoTop);
  if (op !== null && 'error' in op) return refuse(`the repository state could not be read (${op.error})`, 'check that the directory is a git checkout', null);
  if (op !== null) return refuse(`${op.what} is in progress`, op.fix, null);
  const head = await git(run, repoTop, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (head.code === 1) return refuse('HEAD is detached (not on a branch)', NEW_BRANCH, null);
  if (head.code !== 0 || head.out.length === 0) return refuse(`the current branch could not be read (git symbolic-ref: ${head.err})`, 'check that the directory is a git checkout', null);
  const branch = head.out;
  const commit = await git(run, repoTop, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (commit.code !== 0) return refuse(`the branch ${branch} has no commit yet`, `make a first commit on ${branch}, then ${NEW_BRANCH}`, branch);
  if (isProtectedBranch(branch, config.protectedBranches)) return refuse(`the branch ${branch} is protected (harness.config.json protectedBranches)`, `${NEW_BRANCH} (from ${branch})`, branch);
  return { writable: true, reason: '', fix: '', branch };
}

/**
 * Whether a session starting now may write in place: the branch checks, and a clean working tree
 * (no staged, unstaged or untracked change; ignored files do not count).
 */
export async function inPlaceWritability(repoTop: string, config: Pick<HarnessConfig, 'protectedBranches'>, run: Exec = coreExec): Promise<InPlaceVerdict> {
  const v = await branchVerdict(repoTop, config, run);
  if (!v.writable) return v;
  const status = await git(run, repoTop, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) return refuse(`the working tree state could not be read (git status: ${status.err})`, 'check that the directory is a git checkout', v.branch);
  // Porcelain lines keep their two status columns (raw output: a leading space is part of the status).
  const dirty = status.raw.split('\n').filter((l) => l.trim().length > 0);
  if (dirty.length > 0) {
    return refuse(
      `the working tree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ', ...' : ''}), so the session's diff would not be the agent's work alone`,
      'commit them, or set them aside (git stash -u), before the session starts',
      v.branch,
    );
  }
  return v;
}
