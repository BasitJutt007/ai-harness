/**
 * Proof tiers of an in-place run (a session in any web repository). What can prove an edit decides what
 * the harness asks of it:
 *
 *   red        logic (.ts .tsx .js .jsx .mjs .cjs, and .vue/.svelte where the runner can load them) under the
 *              source roots of a repository with a supported test runner: the edit needs an observed red
 *              first, exactly as in file mode (the observed-red hook and gate);
 *   unproven   everything else the run changed: logic outside the source roots (a red only counts for a case
 *              that uses code under them), logic without a supported runner (or a component kind the
 *              runner cannot load), styles, markup, text and data. The edit is allowed, and the
 *              observed-red gate reports UNPROVEN naming each file ("no test proves <files>; verify by
 *              hand"), so a run with such an edit can never end "Work completed".
 *
 * File mode has one tier (red): every governed file needs its red, as in 01.
 */
import { posix } from 'node:path';
import { activeLayout, isSourcePath, sourceRootsLabel } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { isGovernedSource, isTestFile, isTestSupport, sha256 } from './red.ts';

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

/**
 * In place: every file the run changed since it started (run-start hashes; deleted files too) that no test
 * can prove: not a test or test support, and not red-tier logic. Sorted. File mode: none.
 */
export async function unprovenEdits(ctx: RunContext): Promise<UnprovenEdit[]> {
  if (ctx.inPlace === undefined) return [];
  const listed = await ctx.workspace.list(['**/*']);
  const changed = new Set<string>();
  for (const f of listed) {
    const content = await ctx.workspace.read(f);
    if (content !== null && sha256(content) !== ctx.state.initialHashes.get(f)) changed.add(f);
  }
  const present = new Set(listed);
  for (const f of ctx.state.initialHashes.keys()) {
    if (!present.has(f) && (await ctx.workspace.read(f)) === null) changed.add(f);
  }
  const out: UnprovenEdit[] = [];
  for (const f of [...changed].sort()) {
    if (isTestFile(f) || isTestSupport(f)) continue;
    const t = proofTier(ctx, f);
    if (t.tier === 'unproven') out.push({ file: f, why: t.why });
  }
  return out;
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
