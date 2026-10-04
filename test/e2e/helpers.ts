/**
 * End-to-end helpers: throwaway git repositories under <harness>/.harness/tmp/<unique>/,
 * evidence dirs inside them (never the committed runs/ and tokens/), and cleanup that
 * removes every worktree and branch the runs created. Nothing here touches the harness repo's git.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import type { Exec, RunEvent } from '../../src/core/types.ts';

export const ROOT = HARNESS_ROOT;

/** Plain git in a temp repo (identity and signing pinned so the user's global config never matters). */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface TempRepo {
  /** .harness/tmp/<unique> */
  dir: string;
  /** The target repository (its own git repo, branch main). */
  repo: string;
  runsDir: string;
  tokensDir: string;
  /** HEAD of main right after the initial commit. */
  baseSha: string;
  cleanup(): void;
}

/**
 * Create a committed temp repo; `files` maps repo-relative destination dirs to source dirs to copy,
 * `write` repo-relative file paths to content (written after the copies, before the commit).
 */
export function tempRepo(label: string, files: Record<string, string> = {}, write: Record<string, string> = {}): TempRepo {
  const dir = join(ROOT, '.harness', 'tmp', `e2e-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const [dest, src] of Object.entries(files)) {
    cpSync(src, join(repo, dest), { recursive: true, filter: (p) => !p.split(/[\\/]/).some((s) => s === 'node_modules' || s === '.vite') });
  }
  for (const [rel, content] of Object.entries(write)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# e2e target\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  const runsDir = join(dir, 'runs');
  const tokensDir = join(dir, 'tokens');
  return {
    dir,
    repo,
    runsDir,
    tokensDir,
    baseSha: git(repo, ['rev-parse', 'HEAD']),
    cleanup: () => {
      if (existsSync(join(repo, '.git'))) {
        const self = realpathSync(repo);
        const list = git(repo, ['worktree', 'list', '--porcelain']);
        for (const line of list.split('\n')) {
          const wt = line.startsWith('worktree ') ? line.slice('worktree '.length) : null;
          if (wt !== null && wt !== self) {
            try {
              git(repo, ['worktree', 'remove', '--force', wt]);
            } catch {
              rmSync(wt, { recursive: true, force: true });
            }
          }
        }
        git(repo, ['worktree', 'prune']);
        for (const b of git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/harness/']).split('\n')) {
          if (b.length > 0) git(repo, ['branch', '-D', b]);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Paths changed vs HEAD in a checkout (tracked changes + untracked files), repo-relative. */
export function changedFiles(dir: string): string[] {
  const tracked = git(dir, ['diff', '--name-only', 'HEAD']);
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']);
  return [...tracked.split('\n'), ...untracked.split('\n')].filter((l) => l.length > 0).sort();
}

/** The finish decisions the loop recorded (one per accepted/refused finish call). */
export function finishDecisions(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => e.kind === 'note' && e.source === 'finish');
}

/** The core exec, except that `gh` is never available (no PR is ever attempted from tests). */
export function execWithoutGh(seen: string[] = []): Exec {
  return async (cmd, args, opts) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'gh') return { code: 127, stdout: '', stderr: 'gh: disabled in e2e tests', durationMs: 0, timedOut: false };
    return exec(cmd, args, opts);
  };
}

const EventSchema = z.object({
  turn: z.number(),
  at: z.string(),
  kind: z.enum(['hook', 'gate', 'tool', 'note', 'error']),
  source: z.string(),
  decision: z.enum(['pass', 'block', 'record']).optional(),
  message: z.string(),
  data: z.unknown().optional(),
});

export function readEvents(runDir: string): RunEvent[] {
  return readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => EventSchema.parse(JSON.parse(l)));
}

export const RunJsonSchema = z.looseObject({
  runId: z.string(),
  status: z.string(),
  ok: z.boolean(),
  turns: z.number(),
  task: z.looseObject({ id: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  pluginFingerprint: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  toolsOffered: z.array(z.string()).min(1),
  checksRegistered: z.array(z.string()),
  gates: z.array(z.looseObject({ gate: z.string(), status: z.string(), summary: z.string() })),
  honesty: z.object({
    proven: z.array(z.string()),
    failed: z.array(z.string()),
    unproven: z.array(z.string()),
    notApplicable: z.array(z.string()),
    humanMustVerify: z.array(z.string()).min(1),
  }),
  tokens: z.looseObject({ actual_input_tokens: z.number(), baseline_input_tokens: z.number(), reduction_pct: z.number() }),
});

export function readRunJson(runDir: string): z.infer<typeof RunJsonSchema> {
  return RunJsonSchema.parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
}

export const TokenFileSchema = z.looseObject({
  runId: z.string(),
  method: z.literal('shadow-baseline'),
  turns: z.array(
    z.looseObject({
      turn: z.number().int().min(1),
      actual_input_tokens: z.number().int().positive(),
      baseline_input_tokens: z.number().int().positive(),
      reduction_pct: z.number(),
    }),
  ).min(1),
  totals: z.looseObject({ actual_input_tokens: z.number(), baseline_input_tokens: z.number(), reduction_pct: z.number() }),
});

/** Collects printed lines. */
export function collector(): { lines: string[]; out: (l: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), text: () => lines.join('\n') };
}

export const SCRIPTS = join(ROOT, 'fixtures', 'scripted');
export const USERS_TASK = join(ROOT, 'tasks', 'users-api.task.yaml');
export const PROJECTS_TASK = join(ROOT, 'tasks', 'projects-change.task.yaml');
export const SAMPLE = join(ROOT, 'samples', 'existing-api');
