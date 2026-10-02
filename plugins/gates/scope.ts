/**
 * scope: every path changed in the worktree (git status) is under the API root
 * and inside the task's write scope. Scaffold files still equal to their
 * initial snapshot are fine (greenfield copies the template untracked), and
 * dependency trees (`node_modules`, incl. the harness's own symlink and a test
 * runner's `node_modules/.vite` cache) are never the agent's doing: the write
 * tools cannot touch them and ship never stages them.
 * Also: nothing the agent wrote may be git-ignored, or the shipped commit would
 * differ from what the gates tested.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { toApiRel, writePolicy } from '../lib/path-policy.ts';
import { sha256 } from '../lib/red.ts';

/** Parse `git status --porcelain=v1 -z` into repo-relative paths (both sides of renames). */
export function parsePorcelainZ(out: string): string[] {
  const tokens = out.split('\u0000');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry === undefined || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      const orig = tokens[i + 1];
      if (orig !== undefined && orig !== '') paths.push(orig);
      i++;
    }
  }
  return paths;
}

/** A dependency tree entry (any `node_modules` path segment). */
export function isDependencyPath(p: string): boolean {
  return p.replace(/\/+$/, '').split('/').includes('node_modules');
}

/** Agent-written API-relative paths that git ignores (they would silently be left out of the shipped commit). */
async function ignoredWrites(ctx: RunContext, prefix: string): Promise<string[] | string> {
  const written = new Set<string>();
  for (const p of ctx.state.written) {
    const r = toApiRel(ctx.workspace, p);
    if (r.ok && (await ctx.workspace.exists(r.rel))) written.add(r.rel);
  }
  if (written.size === 0) return [];
  const repoPaths = [...written].sort().map((rel) => `${prefix}${rel}`);
  const res = await ctx.exec('git', ['-C', ctx.workspace.repoRoot, 'check-ignore', '-z', '--stdin'], {
    cwd: ctx.workspace.repoRoot,
    input: repoPaths.join('\u0000') + '\u0000',
  });
  // exit 0: some ignored; 1: none ignored; anything else: error.
  if (res.code === 1) return [];
  if (res.code !== 0) return `git check-ignore failed: ${res.stderr.trim().split('\n')[0] ?? ''}`;
  return res.stdout.split('\u0000').filter((p) => p !== '');
}

export default defineGate({
  name: 'scope',
  description: 'Every change in the worktree is under the API root and inside the task scope, and nothing written is git-ignored.',
  phases: ['finish', 'ship'],
  async run(ctx) {
    const ws = ctx.workspace;
    const res = await ctx.exec('git', ['-C', ws.repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ws.repoRoot });
    if (res.code !== 0) return { status: 'unproven', summary: `git status failed: ${res.stderr.trim().split('\n')[0] ?? ''}` };

    const prefix = ws.rootRel === '' || ws.rootRel === '.' ? '' : `${ws.rootRel.replace(/\/+$/, '')}/`;
    const changed = [...new Set(parsePorcelainZ(res.stdout))].sort();
    const violations: string[] = [];
    let inScope = 0;
    for (const p of changed) {
      if (isDependencyPath(p)) continue; // harness-created symlink / runner cache; never written or shipped by the agent
      if (prefix !== '' && !p.startsWith(prefix)) {
        violations.push(`${p}: outside the API root ${ws.rootRel}`);
        continue;
      }
      const rel = p.slice(prefix.length);
      const initial = ctx.state.initialHashes.get(rel);
      if (initial !== undefined) {
        const current = await ws.read(rel);
        if (current !== null && sha256(current) === initial) continue; // untouched scaffold file
      }
      const policy = writePolicy(ctx.task, rel);
      if (policy.allowed) inScope++;
      else violations.push(`${rel}: ${policy.reason}`);
    }
    const ignored = await ignoredWrites(ctx, prefix);
    if (typeof ignored === 'string') return { status: 'unproven', summary: ignored };
    for (const p of ignored) violations.push(`${p}: written by the agent but git-ignored, so it would not be shipped; use another path`);
    if (violations.length > 0) {
      return { status: 'fail', summary: `${violations.length} out-of-scope changes`, details: violations.slice(0, 25) };
    }
    return { status: 'pass', summary: `${inScope} changed files, all in scope` };
  },
});
