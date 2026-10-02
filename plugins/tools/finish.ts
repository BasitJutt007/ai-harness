import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

const Input = z.object({
  summary: z.string().describe('What was done and how it is proven'),
});

export default defineTool({
  name: 'finish',
  description: 'Request completion; refused unless every gate passes.',
  input: Input,
  effect: 'control',
  async run(input) {
    return { ok: true, summary: 'finish requested', finish: { summary: input.summary } };
  },
});
