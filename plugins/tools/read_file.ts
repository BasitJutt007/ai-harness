import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { splitLines } from '../lib/diff.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({
  path: z.string(),
  startLine: z.number().int().min(1).max(1_000_000).optional().describe('Default 1'),
  endLine: z.number().int().min(1).max(1_000_000).optional().describe('Inclusive'),
});

export default defineTool({
  name: 'read_file',
  description: 'Read a file with line numbers; long files come in ranges.',
  input: Input,
  effect: 'read',
  async run(input, ctx) {
    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `read_file: ${r.reason}` };
    const content = await ctx.workspace.read(r.rel);
    if (content === null) return { ok: false, summary: `read_file: ${r.rel} does not exist (use list_files to find paths)` };
    const lines = splitLines(content);
    const total = lines.length;
    if (total === 0) return { ok: true, summary: `${r.rel} (empty file)` };

    const max = ctx.config.limits.maxReadLines;
    const start = input.startLine ?? 1;
    if (start > total) return { ok: false, summary: `read_file: ${r.rel} has only ${total} lines (startLine ${start})` };
    const end = Math.min(total, start + max - 1, input.endLine ?? total);
    if (end < start) return { ok: false, summary: `read_file: endLine ${end} is before startLine ${start}` };

    const numbered = (from: number, to: number): string[] => {
      const width = String(to).length;
      return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}| ${l}`);
    };
    const out = [`${r.rel} (lines ${start}-${end} of ${total})`, ...numbered(start, end)];
    if (end < total) {
      out.push(`… ${total - end} more lines: read_file { "path": "${r.rel}", "startLine": ${end + 1} }`);
    }
    const summary = out.join('\n');
    // Baseline (naive) return: the whole file with line numbers, never shorter than the compact one.
    const whole = [`${r.rel} (lines 1-${total} of ${total})`, ...numbered(1, total)].join('\n');
    const raw = whole.length >= summary.length ? whole : summary;
    return { ok: true, summary, raw, data: { path: r.rel, start, end, total } };
  },
});
