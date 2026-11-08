import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { diffStats, formatStats, lineOf, matchEdit, occurrences, proposedContent, unifiedDiff } from '../lib/diff.ts';
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
    const m = matchEdit(before, input.find, input.replace);
    if (m.kind === 'none') {
      if (m.exact > 1) {
        const lines = occurrences(before, input.find).slice(0, 10).map((o) => lineOf(before, o));
        return {
          ok: false,
          summary: `edit_file: find text matches ${m.exact} times in ${r.rel} (lines ${lines.join(', ')}); include more surrounding context to make it unique`,
        };
      }
      if (m.indent > 1) {
        return { ok: false, summary: `edit_file: find text not found exactly in ${r.rel}, and it matches ${m.indent} places ignoring indentation; include more surrounding lines to make it unique` };
      }
      return { ok: false, summary: `edit_file: find text not found in ${r.rel}; read_file it and copy the exact text (whitespace matters)` };
    }
    const after = m.result;
    await ctx.workspace.write(r.rel, after);
    ctx.state.written.add(r.rel);
    const stats = diffStats(before, after);
    const line = m.kind === 'exact' ? lineOf(before, m.at) : m.line;
    const note = m.kind === 'indent'
      ? `; find matched at line ${line} with the file's lines indented ${Math.abs(m.delta)} space(s) ${m.delta > 0 ? 'more' : 'less'} than given, and replace was re-indented to match`
      : '';
    return {
      ok: true,
      summary: `edited ${r.rel} (${formatStats(stats)})${note}`,
      raw: unifiedDiff(r.rel, before, after),
      data: { path: r.rel, line, ...stats, ...(m.kind === 'indent' ? { indentShift: m.delta } : {}) },
    };
  },
});
