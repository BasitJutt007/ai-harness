import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

const Input = z.object({
  rules: z.array(z.string()).optional().describe('Default all'),
});

export default defineTool({
  name: 'check_standards',
  description: 'Run the standards checks; returns failures and a summary.',
  input: Input,
  effect: 'exec',
  async run(input, ctx) {
    const report = await ctx.services.runChecks(input.rules ? { rules: input.rules } : {});
    // Baseline (naive) return: the full report (every rule x file line + summary block).
    return {
      ok: report.verdict.status === 'pass',
      summary: report.compact,
      raw: report.text.length >= report.compact.length ? report.text : report.compact,
      data: { verdict: report.verdict, rules: report.rules },
    };
  },
});
