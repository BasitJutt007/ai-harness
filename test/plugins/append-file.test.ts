/**
 * append_file: the safe way for a model to add cases to an existing test file (real run: gpt-5.4-mini
 * rewrote the whole file with write_file 9 times and was refused each time). Every content-checking
 * hook must judge the RESULT of the append exactly as for write_file/edit_file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HookVerdict, RunContext, ToolCallInfo, Workspace } from '../../src/core/plugin-api.ts';
import appendFile from '../../plugins/tools/append_file.ts';
import testPreservation from '../../plugins/hooks/test-preservation.ts';
import unsafeCodeGuard from '../../plugins/hooks/unsafe-code-guard.ts';
import secretGuard from '../../plugins/hooks/secret-guard.ts';
import { appendText, proposedContent } from '../../plugins/lib/diff.ts';
import { brownfieldTask, callInfo, callTool, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const FILE = 'test/users.test.ts';
const EXISTING = [
  "import { describe, expect, it, vi } from 'vitest';",
  "import { createUser } from '../src/users.ts';",
  '',
  "describe('users', () => {",
  "  it('creates a user', () => {",
  "    expect(createUser('ann').name).toBe('ann');",
  '  });',
  '});',
  '',
].join('\n');

async function harness() {
  const h = await makeHarness({ label: 'append', task: brownfieldTask(), files: { [FILE]: EXISTING } });
  dirs.push(h.dir);
  h.ctx.state.initialHashes.set(FILE, sha(EXISTING));
  return h;
}
const append = (text: string, ws: Workspace): ToolCallInfo => callInfo(appendFile, { path: FILE, append: text }, ws);
const pre = (hook: typeof testPreservation, call: ToolCallInfo, ctx: RunContext): Promise<HookVerdict> => hook.run({ event: 'pre_tool', call }, ctx);

describe('append_file', () => {
  it('appends on a new line and reports a compact summary', async () => {
    const h = await harness();
    const r = await callTool(appendFile, { path: FILE, append: "describe('more', () => {});\n" }, h.ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/^appended to test\/users\.test\.ts \(\+1/);
    expect(await h.ctx.workspace.read(FILE)).toBe(`${EXISTING}describe('more', () => {});\n`);
    expect(appendText('a', 'b')).toBe('a\nb');
    expect(appendText('', 'b')).toBe('b');
  });

  it('proposedContent covers write, edit and append', () => {
    expect(proposedContent({ content: 'x' }, 'old')).toBe('x');
    expect(proposedContent({ append: 'y' }, 'old\n')).toBe('old\ny');
    expect(proposedContent({ find: 'old', replace: 'new' }, 'old')).toBe('new');
    expect(proposedContent({ find: 'nope', replace: 'new' }, 'old')).toBeUndefined();
    expect(proposedContent({ path: 'x' }, 'old')).toBeUndefined();
  });

  it('test-preservation allows appending a new describe block to an existing test file', async () => {
    const h = await harness();
    const v = await pre(testPreservation, append("describe('delete', () => {\n  it('removes', () => {\n    expect(createUser('b').name).toBe('b');\n  });\n});\n", h.ctx.workspace), h.ctx);
    expect(v.decision).toBe('pass');
  });

  it('test-preservation blocks an appended top-level vi.mock of the code under test (vitest hoists it)', async () => {
    const h = await harness();
    const v = await pre(testPreservation, append("vi.mock('../src/users.ts', () => ({ createUser: () => ({ name: 'ann' }) }));\n", h.ctx.workspace), h.ctx);
    expect(v.decision).toBe('block');
  });

  it('unsafe-code-guard blocks an appended `any`', async () => {
    const h = await harness();
    const v = await pre(unsafeCodeGuard, append("describe('x', () => { it('y', () => { const v: any = 1; expect(v).toBe(1); }); });\n", h.ctx.workspace), h.ctx);
    expect(v.decision).toBe('block');
  });

  it('secret-guard blocks appended key-like content', async () => {
    const h = await harness();
    const key = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
    const v = await pre(secretGuard, append(`const k = '${key}';\n`, h.ctx.workspace), h.ctx);
    expect(v.decision).toBe('block');
  });
});
