/**
 * diff-budget (brownfield; finish and ship): a change stays small enough to review. Changed lines
 * under the API root against the base commit (added plus deleted; a new file counts whole) stay
 * within the task's `limits.maxDiffLines`, 400 by default.
 *
 * The habit it encodes (docs/workflow.md, Where I lose time 2): review round-trips on large PRs. PRs
 * that draw blocking reviews are several times larger than the ones that do not. A run over the
 * budget is refused: split the item, or raise limits.maxDiffLines in the task file on purpose (the
 * agent cannot write task files).
 *
 * Greenfield is exempt: a new API is all new lines. UNPROVEN: git cannot say what changed.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { GateResult } from '../../src/core/plugin-api.ts';
import { isDependencyPath } from './scope.ts';

export const DEFAULT_MAX_DIFF_LINES = 400;

export default defineGate({
  name: 'diff-budget',
  description: 'A brownfield change stays within the changed-lines budget (limits.maxDiffLines, default 400), so it stays reviewable.',
  phases: ['finish', 'ship'],
  appliesTo: ['brownfield'],
  async run(ctx): Promise<GateResult> {
    if (ctx.task.kind !== 'brownfield') return { status: 'n/a', summary: 'not applicable to greenfield tasks (a new API is all new lines)' };
    const ws = ctx.workspace;
    const root = ws.rootRel === '' || ws.rootRel === '.' ? '' : ws.rootRel.replace(/\/+$/, '');
    const pathspec = root === '' ? '.' : root;
    const budget = ctx.task.limits.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;

    const numstat = await ctx.exec('git', ['-C', ws.repoRoot, 'diff', '--numstat', '-z', ctx.run.baseSha, '--', pathspec], { cwd: ws.repoRoot });
    if (numstat.code !== 0) return { status: 'unproven', summary: `git diff against the base commit failed: ${numstat.stderr.trim().split('\n')[0] ?? ''}` };
    const untracked = await ctx.exec('git', ['-C', ws.repoRoot, 'ls-files', '--others', '--exclude-standard', '-z', '--', pathspec], { cwd: ws.repoRoot });
    if (untracked.code !== 0) return { status: 'unproven', summary: `git ls-files failed: ${untracked.stderr.trim().split('\n')[0] ?? ''}` };

    const files: Array<{ path: string; lines: number }> = [];
    // -z numstat: "added\tdeleted\tpath\0" (a rename is "added\tdeleted\t\0old\0new\0").
    const tokens = numstat.stdout.split('\u0000');
    for (let i = 0; i < tokens.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? '');
      if (m === null) continue;
      let path = m[3] ?? '';
      if (path === '') {
        path = tokens[i + 2] ?? tokens[i + 1] ?? '';
        i += 2;
      }
      if (isDependencyPath(path)) continue;
      if (m[1] === '-' || m[2] === '-') return { status: 'unproven', summary: `${path} changed as a binary file: its size in lines cannot be counted` };
      files.push({ path, lines: Number(m[1]) + Number(m[2]) });
    }
    for (const p of untracked.stdout.split('\u0000').filter((x) => x !== '')) {
      if (isDependencyPath(p)) continue;
      const rel = root === '' ? p : p.slice(root.length + 1);
      const text = await ws.read(rel);
      if (text === null) continue;
      files.push({ path: p, lines: text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0) });
    }

    const total = files.reduce((n, f) => n + f.lines, 0);
    const largest = [...files].sort((a, b) => b.lines - a.lines).slice(0, 8).map((f) => `${f.path}: ${f.lines} changed lines`);
    if (total > budget) {
      return {
        status: 'fail',
        summary: `${total} changed lines in ${files.length} file(s), over the budget of ${budget}: split the item, or raise limits.maxDiffLines in the task file on purpose`,
        details: largest,
      };
    }
    return { status: 'pass', summary: `${total} changed lines in ${files.length} file(s), within the budget of ${budget}`, details: largest };
  },
});
