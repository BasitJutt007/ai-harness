import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({
  dir: z.string().optional().describe("Default '.'"),
  pattern: z.string().optional().describe("Glob, default '**/*'"),
});

export default defineTool({
  name: 'list_files',
  description: 'List files under a directory recursively.',
  input: Input,
  effect: 'read',
  async run(input, ctx) {
    let dir = '';
    if (input.dir !== undefined && input.dir.trim() !== '' && input.dir.trim() !== '.') {
      const r = toApiRel(ctx.workspace, input.dir);
      if (!r.ok) return { ok: false, summary: `list_files: ${r.reason}` };
      dir = r.rel;
    }
    const pattern = input.pattern ?? '**/*';
    const files = (await ctx.workspace.list([dir === '' ? pattern : `${dir}/${pattern}`])).sort();
    const max = ctx.config.limits.maxListEntries;
    const shown = files.slice(0, max);
    const head = `${files.length} files under ${dir === '' ? '.' : dir}${input.pattern ? ` matching ${pattern}` : ''}`;
    const lines = [head, ...shown];
    if (files.length > max) lines.push(`… ${files.length - max} more (narrow dir or pattern)`);
    const summary = lines.join('\n');
    // Baseline (naive) return: the full recursive listing, uncapped, never shorter than the compact one.
    const full = [head, ...files].join('\n');
    return { ok: true, summary, raw: full.length >= summary.length ? full : summary, data: { files } };
  },
});
