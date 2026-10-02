import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

const Input = z.object({
  steps: z.array(z.string().min(1)).min(1),
});

export default defineTool({
  name: 'plan',
  description: 'Record your plan as short ordered steps (replaces the previous one).',
  input: Input,
  effect: 'control',
  async run(input, ctx) {
    ctx.state.plan = [...input.steps];
    return { ok: true, summary: `plan recorded (${input.steps.length} steps)` };
  },
});
