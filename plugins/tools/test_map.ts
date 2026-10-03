import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { describeTest, isGovernedSource, isTestFile, isTestSupport, lockState, suggestedTest, testRedStatus } from '../lib/red.ts';

const Input = z.object({
  path: z.string().optional().describe('Omit for the whole map'),
});

export default defineTool({
  name: 'test_map',
  description: "Tests covering a file, their observed-red status and the file's write lock.",
  input: Input,
  effect: 'read',
  async run(input, ctx) {
    const map = await ctx.services.testMap();
    if (input.path === undefined) {
      const entries = Object.entries(map.coverage).sort(([a], [b]) => a.localeCompare(b));
      const max = ctx.config.limits.maxListEntries;
      const lines = entries.slice(0, max).map(([t, srcs]) => `${t} -> ${srcs.length ? srcs.join(', ') : '(no src imports)'}`);
      if (entries.length > max) lines.push(`… ${entries.length - max} more tests`);
      const summary = [`${entries.length} test files`, ...lines].join('\n');
      return { ok: true, summary, raw: summary };
    }

    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `test_map: ${r.reason}` };
    if (isTestFile(r.rel)) {
      const status = await testRedStatus(ctx, r.rel);
      const covers = map.coverage[r.rel] ?? [];
      const summary = `${r.rel}: ${describeTest(status)}\ncovers: ${covers.length ? covers.join(', ') : '(nothing under src/)'}`;
      return { ok: true, summary, raw: summary };
    }
    if (isTestSupport(r.rel)) {
      const summary = `${r.rel}: test support code (writable without red; not a runnable test, never covered). Runnable tests are test/<name>.test.ts`;
      return { ok: true, summary, raw: summary };
    }
    const lock = await lockState(ctx, r.rel);
    const state = !isGovernedSource(r.rel) ? 'not governed by observed-red' : lock.unlocked ? `UNLOCKED (by ${lock.unlockedBy.join(', ')})` : 'LOCKED';
    const lines = [`${r.rel}: ${state}`];
    if (lock.tests.length === 0) lines.push(`covering tests: none (write ${suggestedTest(r.rel)} that imports it)`);
    else lines.push('covering tests:', ...lock.tests.map((t) => `  ${t.test}: ${describeTest(t)}`));
    const summary = lines.join('\n');
    return { ok: true, summary, raw: summary, data: lock };
  },
});
