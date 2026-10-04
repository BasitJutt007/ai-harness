import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { diffStats, formatStats, splitLines, unifiedDiff } from '../lib/diff.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({
  path: z.string(),
  content: z.string().describe('Full file content'),
});

export default defineTool({
  name: 'write_file',
  description: 'Create or overwrite a file (parent directories are created).',
  input: Input,
  effect: 'write',
  paths: (input) => [input.path],
  preview: (input) => input.content,
  async run(input, ctx) {
    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `write_file: ${r.reason}` };
    const before = await ctx.workspace.read(r.rel);
    await ctx.workspace.write(r.rel, input.content);
    ctx.state.written.add(r.rel);
    const stats = diffStats(before ?? '', input.content);
    const summary =
      before === null
        ? `wrote ${r.rel} (new, ${splitLines(input.content).length} lines)`
        : `wrote ${r.rel} (${formatStats(stats)} lines)`;
    return { ok: true, summary, raw: unifiedDiff(r.rel, before, input.content), data: { path: r.rel, created: before === null, ...stats } };
  },
});
