import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { appendText, diffStats, formatStats, splitLines, unifiedDiff } from '../lib/diff.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({
  path: z.string(),
  append: z.string().describe('Text to add at the end'),
});

/**
 * Append to a file without rewriting it: the safe way to add cases to an existing test file
 * (pre-existing tests are append-only). Every write hook checks the resulting file.
 */
export default defineTool({
  name: 'append_file',
  description: 'Append text to a file; use it to add new test cases to an existing test file.',
  input: Input,
  effect: 'write',
  paths: (input) => [input.path],
  async run(input, ctx) {
    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `append_file: ${r.reason}` };
    const before = await ctx.workspace.read(r.rel);
    const after = appendText(before ?? '', input.append);
    await ctx.workspace.write(r.rel, after);
    ctx.state.written.add(r.rel);
    const stats = diffStats(before ?? '', after);
    return {
      ok: true,
      summary: `appended to ${r.rel} (${before === null ? `new, ${splitLines(after).length} lines` : `${formatStats(stats)} lines`})`,
      raw: unifiedDiff(r.rel, before, after),
      data: { path: r.rel, created: before === null, ...stats },
    };
  },
});
