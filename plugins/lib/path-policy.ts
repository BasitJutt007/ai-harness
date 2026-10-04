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
import { templateManifest } from '../../src/core/plugin-api.ts';
import type { Task, Workspace } from '../../src/core/plugin-api.ts';

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

/**
 * Decide whether an API-relative path may be written under the task's policy.
 * Deny lists match case-insensitively (a deny must not be dodged by `SRC/LIB/x.ts`);
 * allow lists match exactly (an allow must not be widened by letter case).
 */
export function writePolicy(task: Task, rel: string): PolicyDecision {
  if (matcher(BUILTIN_DENY, true)(rel)) {
    return {
      allowed: false,
      reason: `${rel} is harness-owned (built-in deny: config, dependencies, build output, git, env, dot-files, .d.ts, contract lock)`,
    };
  }
  if (!rel.endsWith('.ts')) {
    return { allowed: false, reason: `${rel} is not a .ts file; only TypeScript source and tests may be written` };
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
