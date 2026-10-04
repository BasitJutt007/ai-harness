/**
 * elision-guard (pre, write): judges the POST-IMAGE of every write (ToolCallInfo.preview, computed
 * once by the loop from the tool's own preview()), so the input field the text travels in does
 * not matter, and a write tool without preview() is refused (fail closed).
 *  1. Placeholders: the post-image may not gain any placeholder the context views render for
 *     content the model no longer sees (ELISION_PLACEHOLDER, derived from the renderers:
 *     `<omitted N chars>`, digest `<N chars>`, skeleton tails, repeat pointers). Text inside string
 *     literals is data and does not count. A real model copied `<omitted N chars>` back into
 *     write_file and replaced three source files with it, deleting every route.
 *  2. Destructive writes to an existing governed source file: if the file parses now, the
 *     post-image must parse too, and it must keep at least half of the file's exported names and
 *     route registrations. Both catch a partial or placeholder copy whatever its wording.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import type { HookVerdict } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { moduleSurface, newPlaceholders, postImage, syntaxError } from '../lib/post-image.ts';
import { isGovernedSource } from '../lib/red.ts';

const block = (reason: string): HookVerdict => ({ decision: 'block', reason });

/**
 * Why writing `after` over the existing governed source `before` destroys it, or null: the file
 * parses now but would not, or it would lose more than half of its exported names and route
 * registrations (by name; a file with fewer than two has too little surface to judge).
 */
export function destructiveWrite(rel: string, before: string, after: string): string | null {
  const broken = syntaxError(rel, after);
  if (broken !== null && syntaxError(rel, before) === null) return `the new content does not parse (${rel}:${broken}) while the current file does`;
  const was = moduleSurface(rel, before);
  if (was.length < 2) return null;
  const left = new Map<string, number>();
  for (const x of moduleSurface(rel, after)) left.set(x, (left.get(x) ?? 0) + 1);
  const lost = was.filter((x) => {
    const n = left.get(x) ?? 0;
    left.set(x, n - 1);
    return n <= 0;
  });
  if (lost.length * 2 <= was.length) return null;
  return `it would lose ${lost.length} of the ${was.length} exported names and route registrations the current file has (${lost.slice(0, 6).join(', ')}${lost.length > 6 ? ', …' : ''})`;
}

export default defineHook({
  name: 'elision-guard',
  description: 'Blocks writes whose result contains a context placeholder, or that would break or gut an existing source file.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    for (const p of call.paths) {
      const r = toApiRel(ctx.workspace, p);
      if (!r.ok) continue; // path-guard blocks it with the precise reason
      const img = postImage(call, p);
      if (!img.ok) return block(`elision-guard: ${img.reason}`);
      if (img.after === null) continue; // no file afterwards: nothing is written
      const before = await ctx.workspace.read(r.rel);
      const found = newPlaceholders(r.rel, before, img.after);
      if (found.length > 0) {
        return block(
          `elision-guard: ${r.rel}: the result would contain "${found[0] ?? ''}", a placeholder the harness shows for content it left ` +
            'out of your context. It is not file content. read_file the current file and write real code ' +
            '(prefer edit_file / append_file for small changes).',
        );
      }
      const destroyed = before !== null && isGovernedSource(r.rel) ? destructiveWrite(r.rel, before, img.after) : null;
      if (destroyed !== null) {
        return block(
          `elision-guard: ${r.rel}: ${destroyed}. That is what a partial or placeholder copy of the file looks like. ` +
            `read_file ${r.rel} and change it with edit_file / append_file (keeping it valid after every edit), or write the complete file. ` +
            `If you are moving code out on purpose, re-export it from ${r.rel} or move it in smaller steps.`,
        );
      }
    }
    return { decision: 'pass' };
  },
});
