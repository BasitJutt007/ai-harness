/**
 * Where an interactive session keeps its records: OUTSIDE the repository it works on, so `git status`
 * in that repository shows only the agent's governed edits, and outside the harness repository, so no
 * company material ever lands in it.
 *
 *   <home>                         SF_HARNESS_HOME, else ~/.sf-harness
 *   <home>/repos/<id>/             one directory per checkout (repoStateDir):
 *     sessions/<sid>/              run.json, events.jsonl, transcript.jsonl, state.json, logs/, initial/
 *     tokens/                      token reports
 *     docs/contracts/, items/, metrics/   the items root (contracts, ledgers, Measure scripts)
 *     locks/<checkout>.lock        one live session per checkout (acquireCheckoutLock)
 *
 * <id> = the first 12 hex digits of sha256(realpath of `git rev-parse --git-common-dir`), '-', and the
 * checkout's directory name: stable for a checkout, shared by nothing else, readable at a glance.
 *
 * The lock is a file created exclusively (written to a temp file, then hard-linked into place, so it
 * never exists half-written) holding the owner's pid and start time. A lock whose pid is dead is stale
 * and is taken over; a lock held by a live process refuses the second session and names the file. A
 * lock that cannot be read is treated as held (fail closed): the refusal says which file to remove.
 */
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { exec as coreExec } from './exec.ts';
import type { Exec } from './types.ts';

/** The state home: SF_HARNESS_HOME (absolute, or relative to the cwd) when set, else ~/.sf-harness. */
export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  const o = env['SF_HARNESS_HOME'];
  return o !== undefined && o.trim().length > 0 ? resolve(o) : join(homedir(), '.sf-harness');
}

export interface RepoStateDir {
  /** The checkout's id: `<12 hex of sha256(real git common dir)>-<checkout dir name>`. */
  id: string;
  /** <home>/repos/<id>. */
  root: string;
  /** <root>/sessions: one directory per session. */
  sessionsDir: string;
  /** <root>/tokens: token reports. */
  tokensDir: string;
  /** The items root (docs/contracts/, items/, metrics/): the state directory itself. */
  itemsRoot: string;
  /** <root>/locks: one lock file per checkout. */
  locksDir: string;
}

/** A directory name a checkout contributes to its id: anything outside [A-Za-z0-9._-] becomes '-'. */
export function safeDirName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return s.length > 0 ? s.slice(0, 80) : 'repo';
}

/** The id of a checkout from the real path of its git common dir and its top-level directory. */
export function repoStateId(gitCommonDirReal: string, repoTop: string): string {
  return `${createHash('sha256').update(gitCommonDirReal).digest('hex').slice(0, 12)}-${safeDirName(basename(repoTop))}`;
}

/** The real path of `git rev-parse --git-common-dir` for the checkout at `repoTop` (relative output resolves against it). */
export async function gitCommonDir(repoTop: string, run: Exec = coreExec): Promise<string> {
  const r = await run('git', ['-C', repoTop, 'rev-parse', '--git-common-dir'], { cwd: repoTop, timeoutMs: 30_000 });
  const out = r.stdout.trim();
  if (r.code !== 0 || out.length === 0) throw new Error(`${repoTop} is not a git checkout: ${(r.stderr || r.stdout).trim() || `git exited ${String(r.code)}`}`);
  return realpathSync(isAbsolute(out) ? out : resolve(repoTop, out));
}

/** The state directory of the checkout at `repoTop` (created, with its sub-directories). */
export async function repoStateDir(repoTop: string, env: NodeJS.ProcessEnv = process.env, run: Exec = coreExec): Promise<RepoStateDir> {
  const top = realpathSync(repoTop);
  const id = repoStateId(await gitCommonDir(top, run), top);
  const root = join(stateHome(env), 'repos', id);
  const dirs: RepoStateDir = { id, root, sessionsDir: join(root, 'sessions'), tokensDir: join(root, 'tokens'), itemsRoot: root, locksDir: join(root, 'locks') };
  for (const d of [dirs.sessionsDir, dirs.tokensDir, dirs.locksDir]) mkdirSync(d, { recursive: true });
  return dirs;
}

// ───────────────────────────── one session per checkout ─────────────────────────────

/** What a lock file holds. */
export interface LockRecord {
  pid: number;
  /** When the owning process started (ISO). */
  startedAt: string;
  /** The checkout the lock is for (real path). */
  checkout: string;
  /** Random per acquisition: release removes only the lock it created. */
  token: string;
}

export type LockResult = { ok: true; path: string; release: () => void; tookOver?: LockRecord } | { ok: false; path: string; reason: string; holder?: LockRecord };

/** The lock file of a checkout: <locksDir>/<16 hex of sha256(real path of the checkout)>.lock. */
export function lockPath(locksDir: string, repoTop: string): string {
  return join(locksDir, `${createHash('sha256').update(realpathSync(repoTop)).digest('hex').slice(0, 16)}.lock`);
}

function parseLock(text: string): LockRecord | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r['pid'] !== 'number' || !Number.isInteger(r['pid']) || r['pid'] <= 0) return null;
    if (typeof r['startedAt'] !== 'string' || typeof r['checkout'] !== 'string' || typeof r['token'] !== 'string') return null;
    return { pid: r['pid'], startedAt: r['startedAt'], checkout: r['checkout'], token: r['token'] };
  } catch {
    return null;
  }
}

/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'EPERM';
  }
}

function readLock(path: string): { text: string } | null {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch {
    return null;
  }
}

export interface AcquireOptions {
  /** Default: this process. */
  pid?: number;
  /** Liveness probe (a test seam); default pidAlive. */
  alive?: (pid: number) => boolean;
  /** Release automatically when the process exits (default true). */
  releaseOnExit?: boolean;
}

/**
 * Take the checkout's lock, or say who holds it. A lock whose pid is dead is taken over (moved aside
 * under a unique name first, so two sessions racing for the same stale lock cannot both win).
 */
export function acquireCheckoutLock(locksDir: string, repoTop: string, opts: AcquireOptions = {}): LockResult {
  mkdirSync(locksDir, { recursive: true });
  const path = lockPath(locksDir, repoTop);
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  const record: LockRecord = { pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), checkout: realpathSync(repoTop), token: randomBytes(12).toString('hex') };
  const tmp = `${path}.${pid}.${record.token}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  let tookOver: LockRecord | undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(tmp, path); // atomic: fails with EEXIST when any lock is there
        const onExit = (): void => release();
        const release = (): void => {
          process.removeListener('exit', onExit);
          const now = readLock(path);
          // Only the lock this call created: a lock someone else took over since is theirs.
          if (now !== null && parseLock(now.text)?.token === record.token) unlinkSync(path);
        };
        if (opts.releaseOnExit !== false) process.once('exit', onExit);
        return { ok: true, path, release, ...(tookOver !== undefined ? { tookOver } : {}) };
      } catch (e) {
        if (!(typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'EEXIST')) throw e;
      }
      const held = readLock(path);
      if (held === null) continue; // released in between: try again
      const holder = parseLock(held.text);
      if (holder === null) return { ok: false, path, reason: `the session lock ${path} cannot be read; if no session is running in ${record.checkout}, remove it` };
      if (alive(holder.pid)) return { ok: false, path, holder, reason: `a session is already running in ${record.checkout} (pid ${holder.pid}, started ${holder.startedAt}); one session per checkout (lock: ${path})` };
      // Stale: move it aside, and check that what moved is the lock judged stale (not a fresh one taken meanwhile).
      const aside = `${path}.stale-${pid}-${randomBytes(4).toString('hex')}`;
      try {
        renameSync(path, aside);
      } catch {
        continue;
      }
      const moved = parseLock(readLock(aside)?.text ?? '');
      if (moved?.token !== holder.token) {
        try {
          linkSync(aside, path); // put the live lock back
        } catch {
          // someone else holds the path now; their lock stands
        }
        unlinkSync(aside);
        return { ok: false, path, reason: `the session lock ${path} changed while it was being taken over; try again` };
      }
      unlinkSync(aside);
      tookOver = holder;
    }
    return { ok: false, path, reason: `could not take the session lock ${path}` };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}
