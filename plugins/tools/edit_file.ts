import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { diffStats, formatStats, lineOf, occurrences, proposedContent, unifiedDiff } from '../lib/diff.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({
  path: z.string(),
  find: z.string().min(1).describe('Exact text, unique in the file'),
  replace: z.string(),
});

export default defineTool({
  name: 'edit_file',
  description: 'Replace the one exact occurrence of find with replace in a file.',
  input: Input,
  effect: 'write',
  paths: (input) => [input.path],
  // A missing file stays missing, and an edit matching 0 or 2+ times is refused: the file stays as it is.
  preview: (input, before) => (before === null ? null : (proposedContent(input, before) ?? before)),
  async run(input, ctx) {
    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `edit_file: ${r.reason}` };
    const before = await ctx.workspace.read(r.rel);
    if (before === null) return { ok: false, summary: `edit_file: ${r.rel} does not exist (use write_file to create it)` };
    const at = occurrences(before, input.find);
    const first = at[0];
    if (first === undefined) {
      return { ok: false, summary: `edit_file: find text not found in ${r.rel}; read_file it and copy the exact text (whitespace matters)` };
    }
    if (at.length > 1) {
      const lines = at.slice(0, 10).map((o) => lineOf(before, o));
      return {
        ok: false,
        summary: `edit_file: find text matches ${at.length} times in ${r.rel} (lines ${lines.join(', ')}); include more surrounding context to make it unique`,
      };
    }
    const after = before.slice(0, first) + input.replace + before.slice(first + input.find.length);
    await ctx.workspace.write(r.rel, after);
    ctx.state.written.add(r.rel);
    const stats = diffStats(before, after);
    return {
      ok: true,
      summary: `edited ${r.rel} (${formatStats(stats)})`,
      raw: unifiedDiff(r.rel, before, after),
      data: { path: r.rel, line: lineOf(before, first), ...stats },
    };
  },
});
