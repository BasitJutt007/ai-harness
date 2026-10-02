/**
 * path-guard (pre, write): every path a write tool touches must stay inside the
 * API root, be a .ts file, avoid harness-owned files and fall inside the task scope.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { toApiRel, writePolicy } from '../lib/path-policy.ts';

export default defineHook({
  name: 'path-guard',
  description: 'Blocks writes outside the API root, to harness-owned files, to non-.ts files, or outside the task scope.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    if (call.paths.length === 0) {
      return { decision: 'block', reason: `path-guard: write tool ${call.tool} declared no paths, so the write cannot be checked.` };
    }
    for (const p of call.paths) {
      const r = toApiRel(ctx.workspace, p);
      if (!r.ok) {
        return { decision: 'block', reason: `path-guard: ${r.reason}. Use a path relative to the API root, e.g. src/routes/items.ts.` };
      }
      const policy = writePolicy(ctx.task, r.rel);
      if (!policy.allowed) return { decision: 'block', reason: `path-guard: ${policy.reason}.` };
    }
    return { decision: 'pass' };
  },
});
