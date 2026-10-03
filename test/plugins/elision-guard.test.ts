import { describe, expect, it } from 'vitest';
import elisionGuard from '../../plugins/hooks/elision-guard.ts';
import type { RunContext, ToolCallInfo } from '../../src/core/plugin-api.ts';
import { omitted } from '../../src/core/context.ts';

const call = (tool: string, input: Record<string, unknown>): ToolCallInfo => ({ id: 'c1', tool, effect: 'write', input, paths: ['src/store.ts'] });
const run = (c: ToolCallInfo) => elisionGuard.run({ event: 'pre_tool', call: c }, {} as unknown as RunContext);

describe('elision-guard (real run: a model wrote "<omitted N chars>" into three source files)', () => {
  it('blocks write_file / edit_file / append_file content containing the compaction placeholder', async () => {
    for (const c of [
      call('write_file', { path: 'src/store.ts', content: omitted(1234) }),
      call('edit_file', { path: 'src/store.ts', find: 'a', replace: `x ${omitted(10)} y` }),
      call('append_file', { path: 'src/store.ts', append: omitted(99) }),
    ]) {
      const v = await run(c);
      expect(v.decision).toBe('block');
      expect(v.decision === 'block' ? v.reason : '').toContain('read_file the current file');
    }
  });

  it('lets ordinary code through, including the word omitted', async () => {
    expect((await run(call('write_file', { path: 'src/store.ts', content: "export const note = 'omitted fields are optional';\n" }))).decision).toBe('pass');
  });
});
