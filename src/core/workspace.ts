/**
 * Git worktrees and the sandboxed filesystem view of the governed API.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { exec } from './exec.ts';
import { linkDependencies } from './target.ts';
import type { HarnessConfig, Workspace } from './types.ts';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd, timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${String(r.code)}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}

export async function gitToplevel(dir: string): Promise<string> {
  return realpathSync(await git(dir, ['rev-parse', '--show-toplevel']));
}

/** Branch name without a leading `refs/heads/` (or `heads/`), as git would resolve it. */
export function normalizeBranch(branch: string): string {
  return branch.trim().replace(/^(?:refs\/)?(?:heads\/)?/i, '');
}

/**
 * Protected iff the normalised name matches a pattern, or lies below one
 * (`release/*` also protects `release/1/hotfix`), ignoring letter case: refs are
 * files on case-insensitive filesystems, so `Main` and `main` can collide.
 */
export function isProtectedBranch(branch: string, patterns: string[]): boolean {
  const b = normalizeBranch(branch);
  return patterns.some((p) => picomatch([p, `${p}/**`], { dot: true, nocase: true })(b));
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const r = await exec('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoDir,
  });
  return r.code === 0;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function createWorktree(opts: {
  harnessRoot: string;
  config: HarnessConfig;
  repoDir: string;
  runId: string;
  branch: string;
  /** API root relative to the repository top (default: repoDir's position in its repository). */
  apiRel?: string;
}): Promise<{ worktreeRoot: string; baseBranch: string; baseSha: string }> {
  const { harnessRoot, config, repoDir, runId, branch } = opts;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) throw new Error(`invalid branch name "${branch}"`);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`invalid run id "${runId}"`);
  if (isProtectedBranch(branch, config.protectedBranches)) {
    throw new Error(`refusing to work on protected branch "${branch}"`);
  }
  const ok = await exec('git', ['check-ref-format', '--branch', branch], { cwd: repoDir });
  if (ok.code !== 0) throw new Error(`invalid branch name "${branch}"`);
  if (await branchExists(repoDir, branch)) throw new Error(`branch "${branch}" already exists`);

  const top = await gitToplevel(repoDir);
  const baseBranch = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseSha = await git(top, ['rev-parse', 'HEAD']);
  const worktreeRoot = resolve(harnessRoot, config.worktreeDir, runId);
  if (existsSync(worktreeRoot)) throw new Error(`worktree path already exists: ${worktreeRoot}`);
  await mkdir(dirname(worktreeRoot), { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, worktreeRoot, 'HEAD']);

  // Dependencies resolve as in the target checkout: the API's own node_modules and every ancestor's up to
  // the repository top are linked in. The harness's node_modules is the fallback for packages the target
  // lacks: reached by walking up when the worktree lives inside the harness root, linked at the top otherwise.
  const apiRel = opts.apiRel ?? (toPosix(relative(top, realpathSync(repoDir))) || '.');
  const inHarness = isInside(realpathSync(harnessRoot), realpathSync(worktreeRoot));
  linkDependencies(top, apiRel, worktreeRoot, inHarness ? undefined : join(harnessRoot, 'node_modules'));
  return { worktreeRoot: realpathSync(worktreeRoot), baseBranch, baseSha };
}

export async function removeWorktree(repoDir: string, worktreeRoot: string): Promise<void> {
  await git(repoDir, ['worktree', 'remove', '--force', worktreeRoot]);
}

// ───────────────────────────── workspace view ─────────────────────────────

/** realpath of p, or of its nearest existing ancestor joined with the missing tail. */
function realpathLoose(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

const LIST_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**'];

export function createWorkspace(repoRoot: string, rootRel: string): Workspace {
  const repoAbs = resolve(repoRoot);
  const root = resolve(repoAbs, rootRel);
  if (!isInside(repoAbs, root)) throw new Error(`API root "${rootRel}" escapes the repository`);
  const normRootRel = toPosix(relative(repoAbs, root)) || '.';

  const realRoot = (): string => realpathLoose(root);

  function checkRel(input: string): string {
    if (typeof input !== 'string' || input.length === 0) throw new Error('path must be a non-empty string');
    if (input.includes('\0')) throw new Error('path contains a NUL byte');
    const p = input.replace(/\\/g, '/');
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`absolute path not allowed: ${input}`);
    const abs = resolve(root, p);
    if (!isInside(root, abs)) throw new Error(`path escapes the API root: ${input}`);
    if (!isInside(realRoot(), realpathLoose(abs))) throw new Error(`path escapes the API root via a symlink: ${input}`);
    return abs;
  }

  const ws: Workspace = {
    repoRoot: repoAbs,
    root,
    rootRel: normRootRel,
    resolve(rel: string): string {
      return checkRel(rel);
    },
    rel(p: string): string {
      if (typeof p !== 'string' || p.length === 0) throw new Error('path must be a non-empty string');
      if (p.includes('\0')) throw new Error('path contains a NUL byte');
      let candidate = p;
      if (isAbsolute(p)) {
        const abs = resolve(p);
        let r = relative(root, abs);
        if (!isInside(root, abs)) {
          // Accept absolute paths that point inside the root through its real path.
          const realAbs = realpathLoose(abs);
          if (!isInside(realRoot(), realAbs)) throw new Error(`path escapes the API root: ${p}`);
          r = relative(realRoot(), realAbs);
        }
        candidate = r === '' ? '.' : r;
      }
      const abs = checkRel(candidate);
      return toPosix(relative(root, abs)) || '.';
    },
    async read(rel: string): Promise<string | null> {
      const abs = checkRel(rel);
      try {
        return await readFile(abs, 'utf8');
      } catch (e) {
        if (isErrno(e, 'ENOENT') || isErrno(e, 'EISDIR')) return null;
        throw e;
      }
    },
    async write(rel: string, content: string): Promise<void> {
      const abs = checkRel(rel);
      await mkdir(dirname(abs), { recursive: true });
      // Re-check after creating parents (a parent could be a symlink created concurrently).
      checkRel(rel);
      // Atomic replace (temp file + rename): never writes THROUGH an existing symlink or
      // hard link at the target, so a link planted by test code cannot redirect the write.
      const existing = await lstat(abs).catch(() => null);
      if (existing?.isDirectory()) throw new Error(`cannot write ${rel}: it is a directory`);
      const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
        if (existing?.isFile()) await chmod(tmp, existing.mode & 0o777);
        await rename(tmp, abs);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async exists(rel: string): Promise<boolean> {
      const abs = checkRel(rel);
      try {
        await stat(abs);
        return true;
      } catch {
        return false;
      }
    },
    async list(patterns: string[]): Promise<string[]> {
      for (const pat of patterns) {
        if (pat.startsWith('/') || pat.split('/').includes('..')) throw new Error(`pattern escapes the API root: ${pat}`);
      }
      if (!existsSync(root)) return [];
      const found = await glob(patterns, {
        cwd: root,
        ignore: LIST_IGNORE,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        expandDirectories: false,
      });
      return found.map(toPosix).sort();
    },
  };
  return ws;
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === code;
}
