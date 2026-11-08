/**
 * read-loop-guard: from the third read of the same file since the last write, the read result carries
 * a note to edit instead of re-reading; a write clears the count; other files and other runs keep their
 * own counts; it never blocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import guard, { NOTE_FROM_READ } from '../../plugins/hooks/read-loop-guard.ts';
import readFile from '../../plugins/tools/read_file.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import type { HookVerdict, RunContext, ToolPlugin } from '../../src/core/plugin-api.ts';
import { callInfo, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(runId: string) {
  const h = await makeHarness({ label: 'read-loop', files: { 'src/big.ts': 'export const a = 1;\n'.repeat(400), 'src/other.ts': 'export const b = 2;\n' } });
  dirs.push(h.dir);
  const ctx = { ...h.ctx, run: { ...h.ctx.run, id: runId } } as RunContext;
  return { ...h, ctx };
}

async function call<I>(tool: ToolPlugin<I>, input: unknown, ctx: RunContext): Promise<HookVerdict> {
  const info = callInfo(tool, input, ctx.workspace);
  const result = await tool.run(tool.input.parse(input), ctx);
  return guard.run({ event: 'post_tool', call: info, result }, ctx);
}

describe('read-loop-guard', () => {
  it('passes the first reads of a file and notes the third and later ones', async () => {
    const { ctx } = await harness('run-a');
    const verdicts: HookVerdict[] = [];
    for (let i = 0; i < NOTE_FROM_READ + 1; i += 1) verdicts.push(await call(readFile, { path: 'src/big.ts', startLine: 1 + i * 100 }, ctx));
    expect(verdicts.slice(0, NOTE_FROM_READ - 1).map((v) => v.decision)).toEqual(['pass', 'pass']);
    const third = verdicts[NOTE_FROM_READ - 1];
    expect(third).toEqual({ decision: 'record', note: expect.stringMatching(/^read-loop: src\/big\.ts has been read 3 times since your last write\..*edit_file/) });
    expect(verdicts.at(-1)).toEqual({ decision: 'record', note: expect.stringContaining('read 4 times') });
  });

  it('a write clears the count: the next reads start again from one', async () => {
    const { ctx } = await harness('run-b');
    for (let i = 0; i < NOTE_FROM_READ; i += 1) await call(readFile, { path: 'src/big.ts' }, ctx);
    expect((await call(writeFile, { path: 'src/new.ts', content: 'export const c = 3;\n' }, ctx)).decision).toBe('pass');
    expect((await call(readFile, { path: 'src/big.ts' }, ctx)).decision).toBe('pass');
    expect((await call(readFile, { path: 'src/big.ts' }, ctx)).decision).toBe('pass');
    expect((await call(readFile, { path: 'src/big.ts' }, ctx)).decision).toBe('record');
  });

  it('counts each file and each run on its own, and never blocks', async () => {
    const a = await harness('run-c');
    const b = await harness('run-d');
    await call(readFile, { path: 'src/big.ts' }, a.ctx);
    await call(readFile, { path: 'src/big.ts' }, a.ctx);
    expect((await call(readFile, { path: 'src/other.ts' }, a.ctx)).decision).toBe('pass');
    expect((await call(readFile, { path: 'src/big.ts' }, b.ctx)).decision).toBe('pass');
    const third = await call(readFile, { path: 'src/big.ts' }, a.ctx);
    expect(third.decision).toBe('record');
    expect(third.decision).not.toBe('block');
  });

  it('a failed read is not counted', async () => {
    const { ctx } = await harness('run-e');
    for (let i = 0; i < NOTE_FROM_READ + 2; i += 1) expect((await call(readFile, { path: 'src/missing.ts' }, ctx)).decision).toBe('pass');
  });
});
