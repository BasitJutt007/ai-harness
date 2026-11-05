/**
 * Write policy shared by the path-guard hook, the write tools and the scope gate:
 * path normalisation (no escapes), built-in denies, and task scope.
 *
 * Every model-supplied path is reduced to ONE canonical API-relative form before
 * any rule looks at it: `./`, `//`, `..` and backslashes are normalised, and the
 * existing part of the path is resolved through the filesystem (symlinks, and the
 * on-disk letter case on case-insensitive volumes). The write tools write to that
 * same canonical path, so a policy decision and the actual write can never refer
 * to different files (`SRC/x.ts`, `test/link.ts -> ../src/x.ts`, ...).
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { gitHiddenReason, templateManifest } from '../../src/core/plugin-api.ts';
import type { RunContext, Stack, Task, Workspace } from '../../src/core/plugin-api.ts';

/** Files nobody but the harness may write, in any task kind (API-relative globs, matched case-insensitively). */
export const BUILTIN_DENY = [
  '.git/**',
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/package.json',
  '**/package-lock.json',
  '**/tsconfig*.json',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/vitest.setup.*',
  '**/vite.config.*',
  '*.config.*',
  '**/.env*',
  '**/*.d.ts',
  '**/contract.lock.json',
  // Dot-files and dot-directories (.husky, .github, .vscode, ...): tooling config, often git-ignored.
  '**/.*',
  '**/.*/**',
];

/**
 * Greenfield: what the template's manifest (templates/<name>/harness.template.json, `readOnly`)
 * declares read-only, e.g. its runtime library and entry point. A template without a manifest
 * declares nothing beyond BUILTIN_DENY.
 */
export function greenfieldReadOnly(template: string): string[] {
  return templateManifest(template)?.readOnly ?? [];
}

/** Greenfield: the agent writes source and tests only. */
export const GREENFIELD_ALLOW = ['src/**/*.ts', 'test/**/*.ts'];

export type RelResult = { ok: true; rel: string } | { ok: false; reason: string };

/** realpath (native: resolves symlinks AND on-disk letter case) of p or of its nearest existing ancestor + the missing tail. */
function canonicalAbs(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Normalise a model-supplied path to the canonical API-relative POSIX path, rejecting escapes. */
export function toApiRel(ws: Workspace, input: string): RelResult {
  const raw = input.trim().replace(/\\/g, '/');
  if (raw === '') return { ok: false, reason: 'empty path' };
  if (raw.includes('\0')) return { ok: false, reason: `${JSON.stringify(input)} contains a NUL byte` };
  let rel: string;
  if (path.isAbsolute(raw)) {
    try {
      rel = ws.rel(raw);
    } catch {
      return { ok: false, reason: `${input} is outside the API root` };
    }
  } else {
    rel = path.posix.normalize(raw);
  }
  rel = rel.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (rel === '' || rel === '.') return { ok: false, reason: `${input} is the API root, not a file` };
  if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) {
    return { ok: false, reason: `${input} escapes the API root` };
  }
  let abs: string;
  try {
    abs = ws.resolve(rel); // also rejects symlink escapes
  } catch {
    return { ok: false, reason: `${input} escapes the API root (symlink or invalid path)` };
  }
  // Canonical form: what the filesystem will actually touch (symlinks and letter case resolved).
  const realRoot = canonicalAbs(ws.root);
  const canon = path.relative(realRoot, canonicalAbs(abs));
  if (canon === '' || canon.startsWith('..') || path.isAbsolute(canon)) {
    return { ok: false, reason: `${input} escapes the API root (symlink or invalid path)` };
  }
  return { ok: true, rel: toPosix(canon) };
}

function matcher(globs: string[], nocase = false): (p: string) => boolean {
  if (globs.length === 0) return () => false;
  return picomatch(globs, { dot: true, nocase });
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/** File kinds a write may target: TypeScript; on a React target (stack react-vite) also .tsx components. */
export function writableKind(rel: string, stack?: Stack): boolean {
  return rel.endsWith('.ts') || (stack === 'react-vite' && rel.endsWith('.tsx'));
}

// ───────────────────────────── in-place runs (a session in the owner's checkout) ─────────────────────────────

/**
 * What an in-place run may write: the web source and text kinds a frontend or backend change touches.
 * Logic (scripts and single-file components), styles, markup and text; never binaries, never anything a
 * build or package manager executes (those are denied below by name, whatever their extension).
 */
export const INPLACE_WRITABLE_EXTS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.sass', '.less', '.html', '.md', '.mdx', '.json', '.svg', '.yml', '.yaml',
] as const;

/**
 * The supply-chain deny list of an in-place run: absolute (no task scope can re-open it), matched
 * case-insensitively at any depth. It keeps everything the build, the package manager, CI or git runs
 * out of the agent's reach, because in the owner's checkout those run with the owner's credentials:
 * dependency manifests and every lockfile, tool and build configs (`*.config.*`, tsconfig/jsconfig,
 * workspace and deploy configs), dot-files and dot-directories (.env*, .github, .husky, .npmrc, ...),
 * CI and git-hook definitions, the database schema and its migrations, dependencies and build output.
 */
export const INPLACE_DENY = [
  ...BUILTIN_DENY,
  // dependency manifests and lockfiles (package.json is in BUILTIN_DENY)
  '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lock', '**/bun.lockb', '**/deno.lock', '**/*.lock', '**/*-lock.json', '**/*-lock.yaml',
  // tool, build, workspace and deploy configuration
  '**/*.config.*', '**/tsconfig*', '**/jsconfig*', '**/pnpm-workspace.y?(a)ml', '**/lerna.json', '**/nx.json', '**/turbo.json',
  '**/angular.json', '**/project.json', '**/workspace.json', '**/vercel.json', '**/now.json', '**/renovate.json',
  // CI and git hooks (.github, .gitlab-ci.yml, .circleci, .husky, .travis.yml, ... are dot-entries)
  '**/azure-pipelines*', '**/bitbucket-pipelines*', '**/appveyor*', '**/cloudbuild*', '**/codemagic*', '**/buildspec*', '**/Jenkinsfile*',
  '**/docker-compose*', '**/compose.y?(a)ml', '**/lefthook*', '**/githooks/**', '**/git-hooks/**',
  // database schema and migrations
  '**/prisma/**', '**/*.prisma', '**/migrations/**',
  // dependencies and build output
  '**/build/**', '**/out/**', '**/coverage/**', '**/storybook-static/**', '**/*.min.js', '**/*.min.css',
];

/** The extension a write targets, lower-cased (`.d.ts` reads as `.ts`; the deny list owns declarations). */
function extOf(rel: string): string {
  return path.posix.extname(rel).toLowerCase();
}

/** In place: whether `rel` is a web source or text kind (INPLACE_WRITABLE_EXTS). */
export function inPlaceWritableKind(rel: string): boolean {
  return (INPLACE_WRITABLE_EXTS as readonly string[]).includes(extOf(rel));
}

/**
 * The in-place write scope: the git-visible tree minus INPLACE_DENY, web source and text kinds only. A
 * task's own deny list still narrows it (a deny never widens anything); its allow list is not used, since
 * the scope of a session is the checkout itself. Git visibility is not decided here (it needs git):
 * path-guard asks gitHidden() before every write, and the scope gate refuses ignored writes at finish.
 */
export function inPlaceWritePolicy(task: Task, rel: string): PolicyDecision {
  if (matcher(INPLACE_DENY, true)(rel)) {
    return {
      allowed: false,
      reason: `${rel} is harness-owned in place (supply chain: dependency manifests, lockfiles, tool/build/CI configs, git hooks, dot-files, .env*, prisma/ and migrations, node_modules, build output)`,
    };
  }
  if (!inPlaceWritableKind(rel)) {
    return { allowed: false, reason: `${rel} is not a web source or text file; in place only ${INPLACE_WRITABLE_EXTS.join(' ')} files may be written` };
  }
  if (task.kind === 'brownfield' && matcher(task.scope.deny, true)(rel)) {
    return { allowed: false, reason: `${rel} matches the task scope deny list (${task.scope.deny.join(', ')})` };
  }
  return { allowed: true, reason: 'in the in-place scope (the git-visible tree minus the supply-chain deny list)' };
}

/**
 * The write policy of the run `ctx` describes: in place (ctx.inPlace, a session) inPlaceWritePolicy,
 * otherwise (file mode, a worktree run) the 01 policy, unchanged.
 */
export function writePolicyFor(ctx: Pick<RunContext, 'task' | 'stack' | 'inPlace'>, rel: string): PolicyDecision {
  return ctx.inPlace !== undefined ? inPlaceWritePolicy(ctx.task, rel) : writePolicy(ctx.task, rel, ctx.stack);
}

/**
 * Why a write to `rel` would not be git-visible (ignored, `.git`, `.env*`), or null. The workspace's own
 * check when it has one (visibility 'git'), else git's answer for the API root. What git cannot classify
 * is refused (gitHiddenReason fails closed).
 */
export async function gitHidden(ws: Workspace, rel: string): Promise<string | null> {
  return ws.hidden !== undefined ? ws.hidden(rel) : gitHiddenReason(ws.root, rel);
}

/**
 * Decide whether an API-relative path may be written under the task's policy (file mode).
 * Deny lists match case-insensitively (a deny must not be dodged by `SRC/LIB/x.ts`);
 * allow lists match exactly (an allow must not be widened by letter case).
 */
export function writePolicy(task: Task, rel: string, stack?: Stack): PolicyDecision {
  if (matcher(BUILTIN_DENY, true)(rel)) {
    return {
      allowed: false,
      reason: `${rel} is harness-owned (built-in deny: config, dependencies, build output, git, env, dot-files, .d.ts, contract lock)`,
    };
  }
  if (!writableKind(rel, stack)) {
    return { allowed: false, reason: `${rel} is not a ${stack === 'react-vite' ? '.ts or .tsx' : '.ts'} file; only TypeScript source and tests may be written` };
  }
  if (task.kind === 'greenfield') {
    const readOnly = greenfieldReadOnly(task.template);
    if (matcher(readOnly, true)(rel)) {
      return { allowed: false, reason: `${rel} is part of the read-only scaffold (${readOnly.join(', ')}); import from it instead` };
    }
    if (!matcher(GREENFIELD_ALLOW)(rel)) {
      return { allowed: false, reason: `${rel} is outside the greenfield write scope (${GREENFIELD_ALLOW.join(', ')})` };
    }
    return { allowed: true, reason: 'in scope' };
  }
  if (matcher(task.scope.deny, true)(rel)) {
    return { allowed: false, reason: `${rel} matches the task scope deny list (${task.scope.deny.join(', ')})` };
  }
  if (!matcher(task.scope.allow)(rel)) {
    return { allowed: false, reason: `${rel} is outside the task scope allow list (${task.scope.allow.join(', ')})` };
  }
  return { allowed: true, reason: 'in scope' };
}

/** Read a string field from an unvalidated tool input. */
export function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value: unknown = Reflect.get(input, key);
  return typeof value === 'string' ? value : undefined;
}
