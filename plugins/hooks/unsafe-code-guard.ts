/**
 * unsafe-code-guard (pre, write of .ts): parses the proposed file content and
 * blocks new `any`, non-null assertions and ts-ignore family comments, with locations.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { proposedContent } from '../lib/diff.ts';
import { stringField, toApiRel } from '../lib/path-policy.ts';
import { formatViolations, newUnsafeCode } from '../lib/ts-safety.ts';

export default defineHook({
  name: 'unsafe-code-guard',
  description: 'Blocks writes that introduce `any`, non-null assertions or @ts-ignore/@ts-expect-error/@ts-nocheck.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    const target = call.paths[0];
    if (target === undefined) return { decision: 'pass' };
    const r = toApiRel(ctx.workspace, target);
    if (!r.ok || !r.rel.endsWith('.ts')) return { decision: 'pass' };

    const before = await ctx.workspace.read(r.rel);
    const after = proposedContent(call.input, before);
    if (after === undefined) return { decision: 'pass' }; // not computable: the tool reports 0/2+ edit matches itself

    const violations = newUnsafeCode(r.rel, before, after);
    if (violations.length === 0) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: [
        `unsafe-code-guard: ${r.rel} would introduce unsafe TypeScript:`,
        ...formatViolations(r.rel, violations).map((l) => `  ${l}`),
        'Rewrite without these constructs (use unknown + narrowing, explicit null checks, and fix type errors).',
      ].join('\n'),
    };
  },
});
