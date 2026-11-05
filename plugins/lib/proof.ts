/**
 * Proof tiers of an in-place run (a session in any web repository). What can prove an edit decides what
 * the harness asks of it:
 *
 *   red        logic (.ts .tsx .js .jsx .mjs .cjs, and .vue/.svelte where the runner can load them) under the
 *              source roots of a repository with a supported test runner: the edit needs an observed red
 *              first, exactly as in file mode (the observed-red hook and gate);
 *   unproven   everything else the run changed: logic outside the source roots (a red only counts for a case
 *              that uses code under them), logic without a supported runner (or a component kind the
 *              runner cannot load), styles, markup, text and data, and test support that production code
 *              imports (a helper is the proof only while tests alone use it). The edit is allowed, and the
 *              observed-red gate reports UNPROVEN naming each file ("no test proves <files>; verify by
 *              hand"), so a run with such an edit can never end "Work completed".
 *
 * File mode has one tier (red): every governed file needs its red, as in 01.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { activeLayout, codeGlobs, graphFiles, importSpecifiers, isCodePath, isSourcePath, isToolingConfig, resolveImport, sourceRootsLabel } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { scriptSource } from './dependencies.ts';
import { isGovernedSource, isTestFile, isTestSupport } from './red.ts';

export type ProofTier = { tier: 'red' } | { tier: 'unproven'; why: string };

/** What kind of non-logic file `rel` is, for the UNPROVEN line. */
function kindLabel(rel: string): string {
  const ext = posix.extname(rel).toLowerCase();
  if (['.css', '.scss', '.sass', '.less'].includes(ext)) return 'a stylesheet';
  if (['.html', '.svg', '.astro'].includes(ext)) return 'markup';
  if (['.md', '.mdx'].includes(ext)) return 'documentation';
  if (['.json', '.yml', '.yaml'].includes(ext)) return 'data or configuration';
  if (/\.d\.[cm]?tsx?$/.test(rel)) return 'a type declaration';
  return `a ${ext === '' ? 'file without an extension' : `${ext} file`}`;
}

/**
 * The proof tier of a file the run writes or changed (not a test or test support: those are the proof).
 * Fail closed: an unknown runner is no runner, so its logic is UNPROVEN, never silently green.
 */
export function proofTier(ctx: Pick<RunContext, 'inPlace' | 'runner'>, rel: string): ProofTier {
  if (ctx.inPlace === undefined) return { tier: 'red' };
  if (!isGovernedSource(rel)) return { tier: 'unproven', why: `${kindLabel(rel)}: no test can observe it` };
  // A red counts only for a case that uses code from the source roots: logic elsewhere (production JavaScript
  // next to tests in a dir outside the build, a root-level script) could never get one, so it is named instead.
  if (!isSourcePath(rel, activeLayout())) return { tier: 'unproven', why: `logic outside the source roots (${sourceRootsLabel()}): a red only counts for code under them` };
  const runner = ctx.runner;
  if (runner === undefined) return { tier: 'unproven', why: 'logic, but no test runner was detected for this repository' };
  if (!runner.supported) return { tier: 'unproven', why: `logic, but ${runner.reason ?? `the test runner ${runner.name} is not supported`}` };
  const component = /\.(vue|svelte)$/.exec(rel)?.[0];
  if (component !== undefined && !(runner.components ?? []).includes(component)) {
    return { tier: 'unproven', why: `a ${component} component, and ${runner.name} cannot load ${component} files (no Vite plugin for them is declared)` };
  }
  return { tier: 'red' };
}

export interface UnprovenEdit {
  file: string;
  why: string;
}

/** A changed file larger than this is not read as text (its change is still named, never green). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Bytes looked at for a NUL byte (git's own binary heuristic). */
const BINARY_PROBE = 8000;

interface FileFacts {
  /** sha256 of the file read as UTF-8 text, exactly as the run-start snapshot hashed it (streamed, never one string). */
  hash: string;
  binary: boolean;
  size: number;
}

/**
 * The facts of `abs`: null when there is no file there, a string when it exists but cannot be read (why).
 * Streams: a huge file never becomes one string.
 */
async function fileFacts(abs: string): Promise<FileFacts | string | null> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  try {
    const hash = createHash('sha256');
    const decoder = new StringDecoder('utf8');
    let head = Buffer.alloc(0);
    for await (const chunk of createReadStream(abs)) {
      const buf = chunk as Buffer;
      if (head.length < BINARY_PROBE) head = Buffer.concat([head, buf.subarray(0, BINARY_PROBE - head.length)]);
      hash.update(decoder.write(buf));
    }
    hash.update(decoder.end());
    return { hash: hash.digest('hex'), binary: head.includes(0), size: st.size };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The files an in-place run may have changed, from git instead of reading the whole checkout: tracked files
 * that differ from the base commit and untracked files git does not ignore, under the API root; plus every
 * file a write tool wrote and every run-start file. null when git cannot answer for this workspace (the
 * in-place record's top is not a repository top holding the API root, or there is no base commit): the
 * caller then looks at every git-visible file, as before.
 */
async function changedByGit(ctx: RunContext): Promise<Set<string> | null> {
  const top = ctx.inPlace?.repoTop;
  const base = ctx.run.baseSha;
  if (top === undefined || base === '') return null;
  const git = (args: string[]) => ctx.exec('git', ['-C', top, ...args], { cwd: top, timeoutMs: 120_000 }).catch(() => null);
  const shown = await git(['rev-parse', '--show-toplevel']);
  if (shown === null || shown.code !== 0) return null;
  let realTop: string;
  let realRoot: string;
  try {
    realTop = await realpath(shown.stdout.trim());
    if (realTop !== (await realpath(top))) return null;
    realRoot = await realpath(ctx.workspace.root);
  } catch {
    return null;
  }
  const prefix = relative(realTop, realRoot).split(sep).join('/');
  if (prefix.startsWith('..') || isAbsolute(prefix)) return null;
  const spec = prefix === '' ? '.' : prefix;
  const diff = await git(['diff', '--name-only', '--no-renames', '-z', base, '--', spec]);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', spec]);
  if (diff === null || untracked === null || diff.code !== 0 || untracked.code !== 0) return null;
  const out = new Set<string>();
  for (const p of `${diff.stdout}\0${untracked.stdout}`.split('\0')) {
    if (p === '') continue;
    const rel = prefix === '' ? p : p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : null;
    if (rel !== null && rel !== '') out.add(rel);
  }
  for (const f of ctx.state.written) out.add(f);
  for (const f of ctx.state.initialHashes.keys()) if (!(await ctx.workspace.exists(f))) out.add(f);
  return out;
}

/**
 * Which of `support` (test-support files) production code imports: support file -> the first importer, a code
 * file that is not a test, not test support and not a tool's config. A file a test dir holds is test support
 * by where it is; production code importing it makes it production code, whatever its folder is called.
 */
async function productionImporters(ctx: RunContext, support: ReadonlySet<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const layout = activeLayout();
  const files = graphFiles(await ctx.workspace.list(codeGlobs(layout)));
  const existing = new Set([...files, ...support]);
  for (const f of files) {
    if (!isCodePath(f, layout) || isTestFile(f) || isTestSupport(f) || isToolingConfig(f)) continue;
    const text = scriptSource(f, (await ctx.workspace.read(f)) ?? '');
    const name = /\.(vue|svelte)$/.test(f) ? `${f}.ts` : f;
    for (const spec of importSpecifiers(name, text)) {
      const target = resolveImport(f, spec, existing, layout);
      if (target !== null && support.has(target) && !out.has(target)) out.set(target, f);
    }
  }
  return out;
}

/**
 * In place: every file the run changed since it started (run-start hashes; deleted files too) that no test
 * can prove: not a test or test support, and not red-tier logic. Sorted. File mode: none. A changed test-support
 * file that production code imports is named too: it is production code that no red can be asked of.
 *
 * Only the changed files are read (git's answer, changedByGit; every git-visible file only when git cannot
 * answer), each streamed and hashed as the run-start snapshot hashed it. A changed file that is binary or
 * larger than MAX_TEXT_BYTES is not read as text: it is named with that note, so the rest of the gate still
 * runs and the change is never green.
 */
export async function unprovenEdits(ctx: RunContext): Promise<UnprovenEdit[]> {
  if (ctx.inPlace === undefined) return [];
  const ws = ctx.workspace;
  const fromGit = await changedByGit(ctx);
  const candidates = fromGit ?? new Set([...(await ws.list(['**/*'])), ...ctx.state.initialHashes.keys()]);
  const out: UnprovenEdit[] = [];
  // Changed test support, checked below for production importers (only when there is some: it reads the code).
  const support = new Set<string>();
  for (const f of [...candidates].sort()) {
    if (isTestFile(f)) continue;
    // Never a hidden path (git-ignored, .git, .env*): the listing leaves them out, so git's answer must too.
    if (fromGit !== null && ws.hidden !== undefined && (await ws.hidden(f)) !== null) continue;
    let abs: string;
    try {
      abs = ws.resolve(f);
    } catch {
      continue;
    }
    const initial = ctx.state.initialHashes.get(f);
    const facts = await fileFacts(abs);
    if (isTestSupport(f)) {
      // The proof, not an edit to prove, unless production code imports it (decided below).
      const changed = facts === null ? initial !== undefined : typeof facts === 'string' || facts.hash !== initial;
      if (changed) support.add(f);
      continue;
    }
    if (facts === null) {
      // Gone: a change only when it existed at run start (deleted).
      if (initial !== undefined) {
        const t = proofTier(ctx, f);
        if (t.tier === 'unproven') out.push({ file: f, why: t.why });
      }
      continue;
    }
    if (typeof facts === 'string') {
      // There, but unreadable: whether it changed cannot be told, so it is named (never silently unchanged).
      out.push({ file: f, why: `could not be read (${facts}): no test can observe it` });
      continue;
    }
    if (facts.hash === initial) continue;
    if (facts.binary || facts.size > MAX_TEXT_BYTES) {
      const what = facts.binary ? 'a binary file' : `a file of ${(facts.size / (1024 * 1024)).toFixed(1)} MB (over ${MAX_TEXT_BYTES / (1024 * 1024)} MB)`;
      out.push({ file: f, why: `${what}, not read: no test can observe it` });
      continue;
    }
    const t = proofTier(ctx, f);
    if (t.tier === 'unproven') out.push({ file: f, why: t.why });
  }
  if (support.size > 0) {
    for (const [file, importer] of await productionImporters(ctx, support)) {
      out.push({ file, why: `test support that production code imports (${importer}): no red can be asked of it, so no test proves it` });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** "a.css, b.md and 3 more": the files of an UNPROVEN summary line. */
export function fileList(files: readonly string[], max = 4): string {
  if (files.length <= max) return files.join(', ');
  return `${files.slice(0, max).join(', ')} and ${files.length - max} more`;
}

/** The UNPROVEN line for edits no test proves. */
export function unprovenLine(edits: readonly UnprovenEdit[]): string {
  return `no test proves ${fileList(edits.map((e) => e.file))}; verify by hand`;
}
