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
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { activeLayout, gitHiddenReason, templateManifest } from '../../src/core/plugin-api.ts';
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
 * The supply-chain deny list of an in-place run, matched case-insensitively at any depth. No task scope
 * re-opens it (a task's deny list only narrows the in-place scope further). It keeps what the build, the
 * package manager, CI, a deploy or git runs out of the agent's reach, because in the owner's checkout those
 * run with the owner's credentials: dependency manifests and every lockfile, tool and build configs
 * (`*.config.*`, tsconfig/jsconfig, task runners and build scripts), workspace manifests, deploy configs,
 * dot-files and dot-directories (.env*, .github, .husky, .npmrc, ...), CI and git-hook definitions, the
 * database schema and its migrations, dependencies and build output. inPlaceWritePolicy adds what a name
 * alone cannot say: every file a package.json script names, root-level scripts and data or configuration
 * outside the source roots.
 *
 * It is a list of names and rules, not a trace of what tools load: a module a config file imports (a plugin
 * file vite.config.ts imports from ./build/) is executed by that tool, yet writable unless a rule here or in
 * inPlaceWritePolicy matches it.
 */
export const INPLACE_DENY = [
  ...BUILTIN_DENY,
  // dependency and workspace manifests and lockfiles (package.json is in BUILTIN_DENY)
  '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lock', '**/bun.lockb', '**/deno.lock', '**/*.lock', '**/*-lock.json', '**/*-lock.yaml',
  '**/package.yaml', '**/package.json5', '**/rush.json', '**/pnpm-workspace.y?(a)ml', '**/lerna.json', '**/nx.json', '**/turbo.json',
  '**/deno.json', '**/deno.jsonc', '**/bunfig.toml', '**/angular.json', '**/project.json', '**/workspace.json', '**/renovate.json',
  // tool and build configuration, task runners and build scripts
  '**/*.config.*', '**/tsconfig*', '**/jsconfig*', '**/Taskfile*', '**/Makefile', '**/GNUmakefile', '**/*.mk', '**/justfile',
  '**/gulpfile.*', '**/Gruntfile.*', '**/karma.conf.*', '**/webpack.*.?(c|m)[jt]s', '**/rollup.*', '**/esbuild.*', '**/nodemon.json',
  // deploy configuration
  '**/firebase.json', '**/amplify.y?(a)ml', '**/render.y?(a)ml', '**/heroku.y?(a)ml', '**/app.json', '**/wrangler.*', '**/railway.*',
  '**/serverless.*', '**/vercel.json', '**/now.json', '**/netlify.toml', '**/fly.toml', '**/Procfile', '**/Procfile.*', '**/Dockerfile*',
  '**/*.Dockerfile', '**/docker-compose*', '**/compose.y?(a)ml', '**/k8s/**', '**/helm/**', '**/.github/**',
  // CI (.gitlab-ci.yml, .circleci, .travis.yml, ... are dot-entries too)
  '**/azure-pipelines*', '**/bitbucket-pipelines*', '**/appveyor*', '**/cloudbuild*', '**/codemagic*', '**/buildspec*', '**/Jenkinsfile*',
  // git hooks and their managers
  '**/.husky/**', '**/simple-git-hooks.*', '**/.simple-git-hooks.*', '**/lefthook*', '**/.lefthook*', '**/.lintstagedrc*',
  '**/lint-staged.config.*', '**/githooks/**', '**/git-hooks/**',
  // database schema and migrations
  '**/prisma/**', '**/*.prisma', '**/migrations/**',
  // dependencies and build output
  '**/build/**', '**/out/**', '**/coverage/**', '**/storybook-static/**', '**/*.min.js', '**/*.min.css',
];

// ───────────────────────────── files package.json scripts name ─────────────────────────────

/** Directories never searched for package.json files (dependencies, build output, git). */
const MANIFEST_SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'storybook-static', 'bower_components']);
const MANIFEST_MAX_DEPTH = 6;
const MANIFEST_MAX_DIRS = 5000;

/**
 * The file paths a package.json script string names, as written: every token that ends in a file extension
 * (`node scripts/build.mjs`, `--config=webpack.prod.js`, `NODE_OPTIONS='--require ./hook.cjs'`), never a
 * glob, a URL, a variable or a bare word (`vite build`, `src`). Directories and globs are not files a script
 * names: `vitest run src` names no file.
 */
export function scriptFileTokens(script: string): string[] {
  const out: string[] = [];
  for (const raw of script.split(/\s+|&&|\|\||[;|&<>()]/)) {
    let t = raw.trim().replace(/^['"`]+|['"`]+$/g, '');
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      t = t.slice(eq + 1);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      t = t.slice(t.indexOf('=') + 1);
    }
    t = t.replace(/^['"`]+|['"`]+$/g, '');
    if (t === '' || t.includes('://') || /[*?{}[\]$]/.test(t)) continue;
    if (!/\.[A-Za-z][A-Za-z0-9]*$/.test(path.posix.basename(t))) continue;
    out.push(t);
  }
  return out;
}

/** package.json files under `root` (API-relative POSIX dirs), a bounded walk that skips dependencies, build output and dot-dirs. */
function manifestDirs(root: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (rel: string, depth: number): void => {
    if (depth > MANIFEST_MAX_DEPTH || seen >= MANIFEST_MAX_DIRS) return;
    seen += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) out.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || MANIFEST_SKIP.has(e.name)) continue;
      walk(rel === '' ? e.name : `${rel}/${e.name}`, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

interface ScriptFiles {
  /** Lower-cased API-relative path -> where it is named ("package.json scripts.build"). */
  named: Map<string, string>;
  /** The package.json files read, with the stamp (mtime and size) they had. */
  stamps: Array<{ file: string; stamp: string }>;
}

const scriptFilesCache = new Map<string, ScriptFiles>();

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * Every file a package.json script names, under `root` (every package.json of the tree, each script's paths
 * resolved against its own directory), lower-cased API-relative path -> where it is named. Cached per root
 * while the package.json files it read keep their stamp (no run can write a package.json).
 */
export function packageScriptFiles(root: string): ReadonlyMap<string, string> {
  const cached = scriptFilesCache.get(root);
  if (cached !== undefined && cached.stamps.every((s) => stampOf(s.file) === s.stamp)) return cached.named;
  const named = new Map<string, string>();
  const stamps: ScriptFiles['stamps'] = [];
  for (const dir of manifestDirs(root)) {
    const file = path.join(root, dir, 'package.json');
    stamps.push({ file, stamp: stampOf(file) });
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const scripts: unknown = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'scripts') : undefined;
    if (typeof scripts !== 'object' || scripts === null) continue;
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script !== 'string') continue;
      for (const token of scriptFileTokens(script)) {
        if (path.posix.isAbsolute(token) || /^[A-Za-z]:[\\/]/.test(token)) continue;
        const rel = path.posix.normalize(path.posix.join(dir === '' ? '.' : dir, token.replace(/\\/g, '/'))).replace(/^(\.\/)+/, '');
        if (rel === '..' || rel.startsWith('../') || rel === '.') continue;
        const key = rel.toLowerCase();
        if (!named.has(key)) named.set(key, `${dir === '' ? '' : `${dir}/`}package.json scripts.${name}`);
      }
    }
  }
  scriptFilesCache.set(root, { named, stamps });
  return named;
}

/** What inPlaceWritePolicy needs beyond the path: the source roots and the files package.json scripts name. */
export interface InPlaceFacts {
  /** The API's source roots (TargetLayout.sourceRoots); default: the active layout's. */
  sourceRoots?: readonly string[];
  /** packageScriptFiles of the API root; default: none known (a caller without a workspace). */
  scriptFiles?: ReadonlyMap<string, string>;
}

/**
 * Whether `rel` lies under a source root. A root-level file is under one only when a source root names it
 * exactly (a tsconfig `files` entry): '.' (no tsconfig) makes every directory a source root, but never the
 * repository's root-level files, which are its configuration and tooling.
 */
function underSourceRoot(rel: string, roots: readonly string[]): boolean {
  if (!rel.includes('/')) return roots.includes(rel);
  return roots.some((r) => r === '.' || rel === r || rel.startsWith(`${r}/`));
}

function rootsLabel(roots: readonly string[]): string {
  return roots.length === 0 ? 'none' : roots.map((r) => (r === '.' ? 'every directory' : `${r}/`)).join(', ');
}

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
export function inPlaceWritePolicy(task: Task, rel: string, facts: InPlaceFacts = {}): PolicyDecision {
  const owned = (why: string): PolicyDecision => ({ allowed: false, reason: `${rel} is harness-owned in place (supply chain: ${why})` });
  if (matcher(INPLACE_DENY, true)(rel)) {
    return owned('dependency and workspace manifests, lockfiles, tool/build/deploy/CI configs, task runners, git hooks, dot-files, .env*, prisma/ and migrations, node_modules, build output');
  }
  const script = facts.scriptFiles?.get(rel.toLowerCase());
  if (script !== undefined) return owned(`named by ${script}, so the package manager runs it with the owner's credentials`);
  if (!inPlaceWritableKind(rel)) {
    return { allowed: false, reason: `${rel} is not a web source or text file; in place only ${INPLACE_WRITABLE_EXTS.join(' ')} files may be written` };
  }
  const roots = facts.sourceRoots ?? activeLayout().sourceRoots;
  if (!rel.includes('/') && /\.[cm]?js$/i.test(rel) && !underSourceRoot(rel, roots)) {
    return owned(`a root-level script outside the source roots (${rootsLabel(roots)}): tooling the repository's tools load, not source`);
  }
  if (/\.(json|ya?ml)$/i.test(rel) && !underSourceRoot(rel, roots)) {
    return owned(`data or configuration outside the source roots (${rootsLabel(roots)}): in place a .json, .yml or .yaml file is writable only under them`);
  }
  if (task.kind === 'brownfield' && matcher(task.scope.deny, true)(rel)) {
    return { allowed: false, reason: `${rel} matches the task scope deny list (${task.scope.deny.join(', ')})` };
  }
  return { allowed: true, reason: 'in the in-place scope (the git-visible tree minus the supply-chain deny list)' };
}

/**
 * The write policy of the run `ctx` describes: in place (ctx.inPlace, a session) inPlaceWritePolicy with the
 * run's source roots and the files the API's package.json scripts name, otherwise (file mode, a worktree run)
 * the 01 policy, unchanged.
 */
export function writePolicyFor(ctx: Pick<RunContext, 'task' | 'stack' | 'inPlace'> & { workspace?: Pick<Workspace, 'root'> }, rel: string): PolicyDecision {
  if (ctx.inPlace === undefined) return writePolicy(ctx.task, rel, ctx.stack);
  return inPlaceWritePolicy(ctx.task, rel, {
    sourceRoots: activeLayout().sourceRoots,
    ...(ctx.workspace !== undefined ? { scriptFiles: packageScriptFiles(ctx.workspace.root) } : {}),
  });
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
