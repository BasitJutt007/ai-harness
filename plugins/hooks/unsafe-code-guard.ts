/**
 * unsafe-code-guard (pre, write of .ts): parses the post-image of the write (the loop's
 * preview, whatever tool makes it) and blocks new `any`, non-null assertions and ts-ignore
 * family comments, with locations. A write tool without preview() is refused (fail closed).
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { postImage } from '../lib/post-image.ts';
import { formatViolations, newUnsafeCode } from '../lib/ts-safety.ts';

export default defineHook({
  name: 'unsafe-code-guard',
  description: 'Blocks writes that introduce `any`, non-null assertions or @ts-ignore/@ts-expect-error/@ts-nocheck.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    for (const target of call.paths) {
      const r = toApiRel(ctx.workspace, target);
      if (!r.ok || !r.rel.endsWith('.ts')) continue;
      const img = postImage(call, target);
      if (!img.ok) return { decision: 'block', reason: `unsafe-code-guard: ${img.reason}` };
      if (img.after === null) continue; // no file afterwards
      const before = await ctx.workspace.read(r.rel);
      const violations = newUnsafeCode(r.rel, before, img.after);
      if (violations.length === 0) continue;
      return {
        decision: 'block',
        reason: [
          `unsafe-code-guard: ${r.rel} would introduce unsafe TypeScript:`,
          ...formatViolations(r.rel, violations).map((l) => `  ${l}`),
          'Rewrite without these constructs (use unknown + narrowing, explicit null checks, and fix type errors).',
        ].join('\n'),
      };
    }
    return { decision: 'pass' };
  },
});
