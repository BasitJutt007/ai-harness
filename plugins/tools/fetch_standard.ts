import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

const Input = z.object({
  rule: z.string().describe('Rule id'),
});

export default defineTool({
  name: 'fetch_standard',
  description: 'Full text of one standards rule.',
  input: Input,
  effect: 'read',
  async run(input, ctx) {
    const found = ctx.registry.checks.find((c) => c.plugin.id === input.rule);
    if (!found) {
      const ids = ctx.registry.checks.map((c) => c.plugin.id).sort();
      return { ok: false, summary: `fetch_standard: unknown rule "${input.rule}"; available: ${ids.length ? ids.join(', ') : '(none)'}` };
    }
    const c = found.plugin;
    const text = c.doc ?? c.description ?? '(this rule has no documentation)';
    const summary = `${c.id} (${c.category}, unit: ${c.unit ?? 'units'})\n${text}`;
    return { ok: true, summary, raw: summary };
  },
});
