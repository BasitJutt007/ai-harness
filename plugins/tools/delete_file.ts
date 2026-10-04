import { lstat, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { splitLines, unifiedDiff } from '../lib/diff.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({ path: z.string() });

/** Why `rel` may not be deleted: only a file this run created (written, absent at run start) may go. */
export function notDeletable(ctx: Pick<RunContext, 'state'>, rel: string): string | null {
  if (ctx.state.initialHashes.has(rel)) return `${rel} existed when the run started; only files this run created can be deleted`;
  if (!ctx.state.written.has(rel)) return `${rel} was not created by this run; only files this run created can be deleted`;
  return null;
}

/**
 * Delete a file the run itself created (a scratch helper, an abandoned module), so the model can
 * clean up after itself. Anything that existed at run start is refused: those files change only
 * through the content-checked write tools. Like every write, it passes the pre_tool hooks
 * (path-guard: API root, scope, harness-owned files) first.
 */
export default defineTool({
  name: 'delete_file',
  description: 'Delete a file that this run created.',
  input: Input,
  effect: 'write',
  paths: (input) => [input.path],
  preview: () => null,
  async run(input, ctx) {
    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `delete_file: ${r.reason}` };
    const refused = notDeletable(ctx, r.rel);
    if (refused !== null) return { ok: false, summary: `delete_file: ${refused}` };
    const abs = ctx.workspace.resolve(r.rel);
    const st = await lstat(abs).catch(() => null);
    if (st === null) return { ok: false, summary: `delete_file: ${r.rel} does not exist` };
    if (!st.isFile()) return { ok: false, summary: `delete_file: ${r.rel} is not a regular file` };
    const before = (await ctx.workspace.read(r.rel)) ?? '';
    await unlink(abs);
    return {
      ok: true,
      summary: `deleted ${r.rel} (−${splitLines(before).length} lines)`,
      raw: unifiedDiff(r.rel, before, '').replace(`+++ b/${r.rel}`, '+++ /dev/null'),
      data: { path: r.rel, deleted: true },
    };
  },
});
