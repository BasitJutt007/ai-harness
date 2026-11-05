/**
 * What a run changed, for checks that judge only that (repo-lint lints it; web-typecheck counts only when its
 * program covers it): tracked files that differ from the run's base commit and untracked files git does not
 * ignore, under the API root, as API-relative POSIX paths. Deleted files are included (a check decides what a
 * deletion means for it).
 */
import type { CheckContext } from '../../src/core/plugin-api.ts';

/** API-relative files this run changed, added or deleted since the base commit; null = cannot tell (no base, git failed). */
export async function changedSinceBase(ctx: Pick<CheckContext, 'base' | 'exec'>): Promise<string[] | null> {
  const base = ctx.base;
  if (base === undefined) return null;
  const prefix = base.rootRel === '' || base.rootRel === '.' ? '' : `${base.rootRel.replace(/\/+$/, '')}/`;
  const diff = await ctx.exec('git', ['-C', base.repoRoot, 'diff', '--name-only', base.sha, '--', prefix || '.'], { cwd: base.repoRoot });
  const untracked = await ctx.exec('git', ['-C', base.repoRoot, 'ls-files', '--others', '--exclude-standard', '--', prefix || '.'], { cwd: base.repoRoot });
  if (diff.code !== 0 || untracked.code !== 0) return null;
  return [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].map((l) => l.trim()).filter((l) => l.length > 0))]
    .map((p) => (prefix !== '' && p.startsWith(prefix) ? p.slice(prefix.length) : p));
}
