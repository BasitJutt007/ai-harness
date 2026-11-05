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
/**
 * How many directories the package.json search reads at most. Symbolic links are never followed, so the walk
 * is finite without a depth limit; this only stops a pathological tree, and a search it stops makes the
 * script files unknown, so nothing is writable in place (fail closed), never a partial list taken as whole.
 */
export const MANIFEST_MAX_DIRS = 100_000;

/** Extensions Node and its TypeScript runners try for a module path written without one (`node scripts/setup`). */
const MODULE_EXTS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.json'];
/** Commands whose first positional argument is a module file they run (`node setup` runs ./setup.js). */
const RUNNERS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'ts-node-esm', 'ts-node-script', 'ts-node-dev', 'tsnd', 'babel-node', 'nodemon', 'node-dev',
  'bun', 'deno', 'vite-node', 'esno', 'esr', 'jiti', 'sucrase-node', 'swc-node', 'zx']);
/** Shells: their first positional argument is a file they run as written. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.']);
/** Words a runner takes before its file (`tsx watch x`, `bun run x`, `deno run x`). */
const RUNNER_SUBCOMMANDS = new Set(['run', 'watch']);
/** Flags whose next word is a module the runner loads before the entry (`node -r ./hook`). */
const MODULE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
/** Runner flags whose next word is their value, never the entry file (node, tsx, ts-node, ...). */
const VALUE_FLAGS = new Set([...MODULE_FLAGS, '-C', '--conditions', '--env-file', '--env-file-if-exists', '--input-type', '--title', '--inspect-port',
  '--watch-path', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout',
  '--test-shard', '--tsconfig', '-P', '--project', '-O', '--compilerOptions', '--compiler', '--cwd', '--dir']);
/** nodemon's own value flags (its -e is --ext; node's --watch takes none). */
const NODEMON_VALUE_FLAGS = new Set(['--watch', '-w', '--ignore', '-i', '--ext', '-e', '--delay', '-d', '--signal', '-s', '--exec', '-x', '--config']);
/** Runner flags after which no entry file follows: the code is inline (node -e), or the arguments are test files and directories (node --test). */
const NO_ENTRY_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--test']);

/** One shell word, or an operator that separates commands. */
type ShellToken = { word: string } | { op: string };

/**
 * A package.json script split as a POSIX shell would (enough of one): words with their quotes removed (a
 * quoted value with spaces stays one word: `NODE_OPTIONS='--require ./hook.cjs'`), and the operators that
 * separate commands (`&&`, `||`, `;`, `|`, `&`, `(`, `)`); redirections end a word.
 */
function shellTokens(script: string): ShellToken[] {
  const out: ShellToken[] = [];
  let word = '';
  let quoted = false;
  const flush = (): void => {
    if (word !== '' || quoted) out.push({ word });
    word = '';
    quoted = false;
  };
  for (let i = 0; i < script.length; i += 1) {
    const c = script[i] ?? '';
    if (c === "'" || c === '"' || c === '`') {
      const end = script.indexOf(c, i + 1);
      word += end < 0 ? script.slice(i + 1) : script.slice(i + 1, end);
      quoted = true;
      i = end < 0 ? script.length : end;
    } else if (c === '\\' && i + 1 < script.length) {
      word += script[i + 1] ?? '';
      i += 1;
    } else if (/\s/.test(c)) {
      flush();
    } else if ('&|;()<>'.includes(c)) {
      flush();
      const two = script.slice(i, i + 2);
      const op = two === '&&' || two === '||' ? two : c;
      i += op.length - 1;
      if (c !== '<' && c !== '>') out.push({ op });
    } else {
      word += c;
    }
  }
  flush();
  return out;
}

/** A word that can be a literal file path: no variable, glob or URL. */
function literal(w: string): boolean {
  return w !== '' && !w.includes('://') && !/[*?{}[\]$~]/.test(w);
}

/** Whether a word ends in a file extension (`build.mjs`, `webpack.prod.js`; not `1.2.3`). */
function hasExtension(w: string): boolean {
  return /\.[A-Za-z][A-Za-z0-9]*$/.test(path.posix.basename(w));
}

/** The files a module path written without an extension can be: itself, with each MODULE_EXTS, and as a directory's index. */
function moduleCandidates(p: string): string[] {
  const base = p.replace(/\/+$/, '');
  if (base === '' || base === '.' || base === './') return MODULE_EXTS.map((e) => `index${e}`);
  return [base, ...MODULE_EXTS.map((e) => base + e), ...MODULE_EXTS.map((e) => `${base}/index${e}`)];
}

/**
 * The files a package.json script runs or names, relative to the package's directory: every word that ends
 * in a file extension (`node scripts/build.mjs`, `--config=webpack.prod.js`, `NODE_OPTIONS='--require
 * ./hook.cjs'`); the module a runner (node, tsx, ts-node, nodemon, ...) runs or preloads even without an
 * extension (`node scripts/setup` names scripts/setup.js and its siblings by extension, scripts/setup/index.js
 * and so on; `node .` the package's `main`); the file a shell or a path-like command runs (`./bin/www`). A
 * `cd dir &&` before a command resolves what follows against dir. Never a glob, a URL, a variable, a
 * directory or a bare word (`vite build`, `vitest run src` name no file).
 */
export function scriptFileTokens(script: string, main?: string): string[] {
  const out: string[] = [];
  /** Where the current command runs, relative to the package ('' = the package; null = unknown after `cd $X`). */
  let cwd: string | null = '';
  const saved: Array<string | null> = [];
  const at = (p: string): string => (cwd === null || cwd === '' ? p : path.posix.join(cwd, p));
  const exact = (p: string): void => {
    if (literal(p)) out.push(at(p));
  };
  const module = (p: string): void => {
    if (!literal(p)) return;
    if (hasExtension(p)) {
      out.push(at(p));
      return;
    }
    // `node .` runs the package's main (and index.js without one).
    if (/^\.\/?$/.test(p) && main !== undefined && main !== '.' && main !== './') module(main);
    for (const c of moduleCandidates(p)) out.push(at(c));
  };
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  /** A quoted word with spaces is a command of its own (`nodemon --exec "tsx src/server.ts"`, `sh -c "node x.js"`, `concurrently "node a.js" ...`). */
  const nested = (w: string): boolean => {
    if (!/\s/.test(w.trim())) return false;
    for (const t of scriptFileTokens(w, main)) out.push(at(t));
    return true;
  };

  /**
   * The arguments of one command. `runner`: the runner or shell it is (its first plain argument is the file it
   * runs), 'options' for the words of an environment value (flags only), null for any other command.
   */
  const args = (words: readonly string[], runner: string | null): void => {
    let entry = runner !== null && runner !== 'options';
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i] ?? '';
      if (w.startsWith('-')) {
        const eq = w.indexOf('=');
        const flag = eq < 0 ? w : w.slice(0, eq);
        const nodemon = runner === 'nodemon';
        if (runner !== null && !nodemon && NO_ENTRY_FLAGS.has(flag)) entry = false;
        let value: string | undefined = eq < 0 ? undefined : w.slice(eq + 1);
        const takesValue = VALUE_FLAGS.has(flag) || (nodemon && NODEMON_VALUE_FLAGS.has(flag));
        if (value === undefined && runner !== null && takesValue && i + 1 < words.length) {
          i += 1;
          value = words[i];
        }
        if (value === undefined || nested(value)) continue;
        // A preloaded module is a local file only when written as a relative path (`-r dotenv/config` is a package).
        if (MODULE_FLAGS.has(flag) && /^\.\.?\//.test(value)) module(value);
        else if (hasExtension(value)) exact(value);
        continue;
      }
      if (nested(w)) continue;
      if (entry && runner !== null && RUNNER_SUBCOMMANDS.has(w)) continue;
      if (entry) {
        entry = false;
        if (runner !== null && SHELLS.has(runner)) exact(w);
        else module(w);
        continue;
      }
      if (hasExtension(w)) exact(w);
    }
  };
  /** An environment assignment's value: one file name, or node options (NODE_OPTIONS='--require ./hook.cjs'). */
  const env = (w: string): void => {
    const parts = w.slice(w.indexOf('=') + 1).split(/\s+/).filter((p) => p !== '');
    if (parts.some((p) => p.startsWith('-'))) args(parts, 'options');
    else if (parts.length === 1 && hasExtension(parts[0] ?? '')) exact(parts[0] ?? '');
  };

  const command = (words: readonly string[]): void => {
    let i = 0;
    for (; i < words.length && assignment.test(words[i] ?? ''); i += 1) env(words[i] ?? '');
    const head = words[i];
    if (head === undefined) return;
    if (head === 'cd') {
      const to = words[i + 1];
      cwd = to === undefined || cwd === null || !literal(to) || path.posix.isAbsolute(to) ? null : path.posix.normalize(path.posix.join(cwd, to)).replace(/^\.$/, '');
      return;
    }
    // A command written as a path runs that file (./bin/www, scripts/deploy.sh).
    if (head.includes('/')) exact(head);
    // A wrapper runs the command after it (npx tsx x, cross-env A=b node x, pnpm exec ts-node x): look through it.
    const r = words.findIndex((w, k) => k >= i && (RUNNERS.has(path.posix.basename(w)) || SHELLS.has(w)));
    if (r < 0) {
      args(words.slice(i + 1), null);
      return;
    }
    for (const w of words.slice(i + 1, r)) {
      if (assignment.test(w)) env(w);
      else if (!w.startsWith('-') && !nested(w) && hasExtension(w)) exact(w);
    }
    const runner = words[r] ?? '';
    args(words.slice(r + 1), SHELLS.has(runner) ? runner : path.posix.basename(runner));
  };

  let words: string[] = [];
  for (const t of shellTokens(script)) {
    if ('word' in t) {
      words.push(t.word);
      continue;
    }
    command(words);
    words = [];
    // A subshell's cd ends with it: `(cd web && vite build) && node x.js` runs x.js where the script started.
    if (t.op === '(') saved.push(cwd);
    else if (t.op === ')') cwd = saved.pop() ?? '';
  }
  command(words);
  return [...new Set(out)];
}

/** package.json files under `root` (API-relative POSIX dirs) and whether the search stopped early (why), skipping dependencies, build output and dot-dirs. */
function manifestDirs(root: string, maxDirs: number): { dirs: string[]; incomplete: string | null } {
  const out: string[] = [];
  let seen = 0;
  let stopped = false;
  const queue: string[] = [''];
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    if (seen >= maxDirs) {
      stopped = true;
      break;
    }
    seen += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) out.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || MANIFEST_SKIP.has(e.name)) continue;
      queue.push(rel === '' ? e.name : `${rel}/${e.name}`);
    }
  }
  return { dirs: out, incomplete: stopped ? `the search for package.json files stopped after ${maxDirs} directories` : null };
}

/**
 * The files package.json scripts name (lower-cased API-relative path -> where it is named), with the
 * directories that hold a package.json ('' for the API root) and why the list is incomplete (null: it is
 * whole). An incomplete list refuses every in-place write: what an unread package.json runs is unknown.
 */
export interface ScriptFileMap extends ReadonlyMap<string, string> {
  readonly packageDirs: ReadonlySet<string>;
  readonly incomplete: string | null;
}

interface ScriptFiles {
  named: ScriptFileMap;
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
 * resolved against its own directory, after any `cd` in the script; scriptFileTokens), lower-cased
 * API-relative path -> where it is named; with the package directories and, when the search for package.json
 * files stopped at `maxDirs` directories, why the list is incomplete. Cached per root while the package.json
 * files it read keep their stamp (no run can write a package.json).
 */
export function packageScriptFiles(root: string, opts: { maxDirs?: number } = {}): ScriptFileMap {
  const maxDirs = opts.maxDirs ?? MANIFEST_MAX_DIRS;
  const key = `${maxDirs}\u0000${root}`;
  const cached = scriptFilesCache.get(key);
  if (cached !== undefined && cached.stamps.every((s) => stampOf(s.file) === s.stamp)) return cached.named;
  const named = new Map<string, string>();
  const stamps: ScriptFiles['stamps'] = [];
  const search = manifestDirs(root, maxDirs);
  for (const dir of search.dirs) {
    const file = path.join(root, dir, 'package.json');
    stamps.push({ file, stamp: stampOf(file) });
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const field = (k: string): unknown => (typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, k) : undefined);
    const scripts = field('scripts');
    const main = field('main');
    if (typeof scripts !== 'object' || scripts === null) continue;
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script !== 'string') continue;
      for (const token of scriptFileTokens(script, typeof main === 'string' ? main : undefined)) {
        if (path.posix.isAbsolute(token) || /^[A-Za-z]:[\\/]/.test(token)) continue;
        const rel = path.posix.normalize(path.posix.join(dir === '' ? '.' : dir, token.replace(/\\/g, '/'))).replace(/^(\.\/)+/, '');
        if (rel === '..' || rel.startsWith('../') || rel === '.') continue;
        const lower = rel.toLowerCase();
        if (!named.has(lower)) named.set(lower, `${dir === '' ? '' : `${dir}/`}package.json scripts.${name}`);
      }
    }
  }
  const map: ScriptFileMap = Object.assign(named, { packageDirs: new Set(search.dirs), incomplete: search.incomplete });
  scriptFilesCache.set(key, { named: map, stamps });
  return map;
}

/** What inPlaceWritePolicy needs beyond the path: the source roots and the files package.json scripts name. */
export interface InPlaceFacts {
  /** The API's source roots (TargetLayout.sourceRoots); default: the active layout's. */
  sourceRoots?: readonly string[];
  /**
   * packageScriptFiles of the API root (a plain map: those files, the API root its only package); default:
   * none known. Its `incomplete` refuses every write; its `packageDirs` anchor the tool and deploy names
   * PACKAGE_LEVEL_DENY lists.
   */
  scriptFiles?: ReadonlyMap<string, string> & Partial<Pick<ScriptFileMap, 'packageDirs' | 'incomplete'>>;
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
  const incomplete = facts.scriptFiles?.incomplete;
  if (incomplete !== undefined && incomplete !== null) {
    return owned(`${incomplete}, so which files package.json scripts run is unknown and nothing is writable in place`);
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
 * the 01 policy, unchanged. The workspace is required: without its root the script files are unknown, and an
 * in-place policy that silently lost them would let the agent write what `npm install` runs.
 */
export function writePolicyFor(ctx: Pick<RunContext, 'task' | 'stack' | 'inPlace'> & { workspace: Pick<Workspace, 'root'> }, rel: string): PolicyDecision {
  if (ctx.inPlace === undefined) return writePolicy(ctx.task, rel, ctx.stack);
  return inPlaceWritePolicy(ctx.task, rel, { sourceRoots: activeLayout().sourceRoots, scriptFiles: packageScriptFiles(ctx.workspace.root) });
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
