import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

const Input = z.object({
  pattern: z.string().min(1).describe('Literal, or JS regex if regex'),
  glob: z.string().optional().describe("Default '**/*.ts'"),
  regex: z.boolean().optional(),
});

const MAX_FILE_BYTES = 1_000_000;

export default defineTool({
  name: 'search_code',
  description: 'Search file contents; returns file:line: text.',
  input: Input,
  effect: 'read',
  async run(input, ctx) {
    let test: (line: string) => boolean;
    if (input.regex === true) {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern);
      } catch (e) {
        return { ok: false, summary: `search_code: invalid regex: ${e instanceof Error ? e.message : String(e)}` };
      }
      test = (line) => re.test(line);
    } else {
      test = (line) => line.includes(input.pattern);
    }

    const files = (await ctx.workspace.list([input.glob ?? '**/*.ts'])).sort();
    const hits: string[] = [];
    const fullHits: string[] = [];
    for (const file of files) {
      const content = await ctx.workspace.read(file);
      if (content === null || content.length > MAX_FILE_BYTES || content.includes('\u0000')) continue;
      content.split('\n').forEach((line, i) => {
        if (test(line)) {
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
          fullHits.push(`${file}:${i + 1}: ${line}`);
        }
      });
    }
    const max = ctx.config.limits.maxSearchHits;
    const out = hits.length === 0 ? [`no matches for ${JSON.stringify(input.pattern)} in ${files.length} files`] : hits.slice(0, max);
    if (hits.length > max) out.push(`… ${hits.length - max} more hits (narrow the pattern or glob)`);
    const summary = out.join('\n');
    // Baseline (naive) return: every hit, full line, uncapped; never shorter than the compact one.
    const full = fullHits.join('\n');
    return { ok: true, summary, raw: full.length >= summary.length ? full : summary, data: { hits: hits.length } };
  },
});
