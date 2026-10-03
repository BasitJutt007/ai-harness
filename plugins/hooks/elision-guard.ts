/**
 * elision-guard (pre, write): refuses a write whose new text contains the harness's own
 * input-elision placeholder (`<omitted N chars>`). History compaction shows large earlier
 * write payloads as that placeholder; a real model in a real run copied it back into
 * write_file and replaced three source files with it, deleting every route. The placeholder
 * is never legitimate file content, so the write is refused with the way out.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { stringField } from '../lib/path-policy.ts';

const PLACEHOLDER = /<omitted \d+ chars>/;

export default defineHook({
  name: 'elision-guard',
  description: 'Blocks writes that contain the harness placeholder for omitted earlier content (<omitted N chars>).',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const text = ['content', 'append', 'replace'].map((k) => stringField(event.call.input, k)).find((v) => v !== undefined && PLACEHOLDER.test(v));
    if (text === undefined) return { decision: 'pass' };
    const where = event.call.paths[0] ?? event.call.tool;
    return {
      decision: 'block',
      reason:
        `elision-guard: ${where}: the content contains "${PLACEHOLDER.exec(text)?.[0] ?? '<omitted N chars>'}", the placeholder the harness shows ` +
        'for earlier content it left out of your context. It is not file content. read_file the current file and write real code ' +
        '(prefer edit_file / append_file for small changes).',
    };
  },
});
