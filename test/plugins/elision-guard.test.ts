/**
 * elision-guard judges the POST-IMAGE of a write (the loop's preview), never input field names:
 *  - every placeholder the context views render (derived from the renderers themselves) is refused
 *    in written content, whatever tool or field carries it;
 *  - an existing source file may not be replaced by something that does not parse or that drops
 *    most of what other code relies on (exports, route registrations).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import elisionGuard, { destructiveWrite } from '../../plugins/hooks/elision-guard.ts';
import appendFile from '../../plugins/tools/append_file.ts';
import deleteFile from '../../plugins/tools/delete_file.ts';
import editFile from '../../plugins/tools/edit_file.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import { defineTool } from '../../src/core/plugin-api.ts';
import type { HookVerdict, RunContext, ToolCallInfo } from '../../src/core/plugin-api.ts';
import {
  compactToolInput, DIGEST_VALUE_CHARS, digestInput, digestTurn, ELIDE_INPUT_CHARS, ELISION_PLACEHOLDER, omitted, repeatPointer, skeleton,
} from '../../src/core/context.ts';
import { callInfo, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(files: Record<string, string> = {}) {
  const h = await makeHarness({ label: 'elision', files });
  dirs.push(h.dir);
  return h;
}

const run = (c: ToolCallInfo, ctx: RunContext): Promise<HookVerdict> => elisionGuard.run({ event: 'pre_tool', call: c }, ctx);
const reasonOf = (v: HookVerdict): string => (v.decision === 'block' ? v.reason : '');

const STORE = [
  "import { Router } from 'express';",
  'export interface Item { id: string }',
  'const items = new Map<string, Item>();',
  'export function listItems(): Item[] { return [...items.values()]; }',
  'export function getItem(id: string): Item | undefined { return items.get(id); }',
  'export const router = Router();',
  "router.get('/items', (_req, res) => { res.json(listItems()); });",
  "router.get('/items/:id', (req, res) => { res.json(getItem(req.params.id) ?? null); });",
  '',
].join('\n');

/** Every placeholder form, rendered by the context views themselves (not typed by hand). */
function renderedPlaceholders(): Array<[string, string]> {
  const long = 'x'.repeat(Math.max(ELIDE_INPUT_CHARS, DIGEST_VALUE_CHARS) + 7);
  const elided = compactToolInput({ path: 'src/store.ts', content: long });
  const listing = ['src/store.ts (lines 1-60 of 60)', ...Array.from({ length: 60 }, (_, i) => `${String(i + 1).padStart(2)}| export const v${i} = ${i};`)].join('\n');
  const skel = skeleton(listing, 3).split('\n').at(-1) ?? '';
  const digest = digestTurn({
    turn: 4,
    assistant: { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'write_file', input: { path: 'src/store.ts', content: long } }] },
    results: { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: 'wrote src/store.ts (new, 1 lines)', isError: false }] },
    raw: {},
  })[0] ?? '';
  return [
    ['input elision', typeof elided === 'object' && elided !== null && 'content' in elided ? String(elided.content) : ''],
    ['digest value', digestInput({ path: 'src/store.ts', content: long })],
    ['digest line', digest],
    ['skeleton tail', skel],
    ['repeat pointer', repeatPointer('read_file', 3)],
  ];
}

describe('ELISION_PLACEHOLDER is derived from the renderers', () => {
  it('matches every form the context views render, and none of ordinary code', () => {
    const forms = renderedPlaceholders();
    for (const [name, text] of forms) {
      expect(text, name).not.toBe('');
      expect(ELISION_PLACEHOLDER.test(text), `${name}: ${text}`).toBe(true);
    }
    for (const code of ["const note = 'omitted fields are optional';", 'type A = Array<string>;', 'if (a < 10 && b > 3) return;', '// 3 more lines below']) {
      expect(ELISION_PLACEHOLDER.test(code), code).toBe(false);
    }
  });
});

describe('elision-guard (real run: a model wrote "<omitted N chars>" into three source files)', () => {
  it('blocks write_file / edit_file / append_file content containing the compaction placeholder', async () => {
    const h = await harness({ 'src/store.ts': STORE });
    for (const c of [
      callInfo(writeFile, { path: 'src/store.ts', content: omitted(1234) }),
      callInfo(editFile, { path: 'src/store.ts', find: 'const items', replace: `const items ${omitted(10)}` }, h.ctx.workspace),
      callInfo(appendFile, { path: 'src/store.ts', append: omitted(99) }, h.ctx.workspace),
    ]) {
      const v = await run(c, h.ctx);
      expect(v.decision, c.tool).toBe('block');
      expect(reasonOf(v)).toContain('read_file the current file');
    }
  });

  it('blocks every rendered placeholder form, in any file, outside string literals', async () => {
    const h = await harness();
    for (const [name, text] of renderedPlaceholders()) {
      for (const p of ['src/new.ts', 'test/new.test.ts', 'docs/notes.md']) {
        const v = await run(callInfo(writeFile, { path: p, content: `export const a = 1;\n// ${text}\n` }), h.ctx);
        expect(v.decision, `${name} in ${p}`).toBe('block');
      }
    }
  });

  it('lets ordinary code through, including the word omitted and placeholder text inside string literals', async () => {
    const h = await harness({ 'src/store.ts': STORE });
    const ok = [
      "export const note = 'omitted fields are optional';\n",
      `export const sample = '${omitted(12)}';\nexport const re = /<\\d+ chars>/;\nexport const t = \`${repeatPointer('read_file', 2)}\`;\n`,
    ];
    for (const content of ok) expect((await run(callInfo(writeFile, { path: 'src/new.ts', content }), h.ctx)).decision, content).toBe('pass');
  });

  it('a placeholder already in the file does not block unrelated edits', async () => {
    const legacy = `// ${omitted(5)}\nexport const a = 1;\n`;
    const h = await harness({ 'docs/legacy.md': legacy });
    expect((await run(callInfo(editFile, { path: 'docs/legacy.md', find: 'a = 1', replace: 'a = 2' }, h.ctx.workspace), h.ctx)).decision).toBe('pass');
  });
});

describe('elision-guard judges the post-image, whatever the write tool calls its fields', () => {
  const textInput = z.object({ path: z.string(), text: z.string() });
  /** A drop-in write tool someone adds later, with its own field name. */
  const noPreview = defineTool({ name: 'put_text', description: 'Write text.', input: textInput, effect: 'write', paths: (i) => [i.path], run: async () => ({ ok: true, summary: '' }) });
  const withPreview = defineTool({ ...noPreview, preview: (i) => i.text });

  it('refuses a write tool without preview() (fail closed)', async () => {
    const h = await harness();
    const v = await run(callInfo(noPreview, { path: 'src/new.ts', text: 'export const a = 1;\n' }), h.ctx);
    expect(reasonOf(v)).toContain('declares no preview()');
  });

  it('judges a drop-in tool through its preview: a placeholder in a `text` field is caught', async () => {
    const h = await harness();
    expect(reasonOf(await run(callInfo(withPreview, { path: 'src/new.ts', text: omitted(800) }), h.ctx))).toContain('placeholder');
    expect((await run(callInfo(withPreview, { path: 'src/new.ts', text: 'export const a = 1;\n' }), h.ctx)).decision).toBe('pass');
  });

  it('refuses a path whose post-image could not be computed', async () => {
    const h = await harness();
    const c: ToolCallInfo = { ...callInfo(withPreview, { path: 'src/new.ts', text: 'x' }), preview: new Map() };
    expect(reasonOf(await run(c, h.ctx))).toContain('could not be computed');
  });

  it('a deletion (post-image null) has no content to judge', async () => {
    const h = await harness({ 'src/store.ts': STORE });
    expect((await run(callInfo(deleteFile, { path: 'src/store.ts' }), h.ctx)).decision).toBe('pass');
  });
});

describe('elision-guard: destructive writes to existing source files', () => {
  it('blocks a post-image that does not parse while the current file does', async () => {
    const h = await harness({ 'src/store.ts': STORE });
    const v = await run(callInfo(editFile, { path: 'src/store.ts', find: 'return [...items.values()]; }', replace: 'return [...items.values()];' }, h.ctx.workspace), h.ctx);
    expect(reasonOf(v)).toContain('does not parse');
    expect(reasonOf(v)).toContain('edit_file / append_file');
  });

  it('blocks losing more than half of the exports and route registrations, whatever the replacement says', async () => {
    const h = await harness({ 'src/store.ts': STORE });
    const gutted = [
      "import { Router } from 'express';",
      'export const router = Router();',
      '// ... rest of the file unchanged ...',
      '',
    ].join('\n');
    const v = await run(callInfo(writeFile, { path: 'src/store.ts', content: gutted }), h.ctx);
    expect(reasonOf(v)).toContain('would lose 5 of the 6');
    expect(reasonOf(v)).toContain('export listItems');
    expect(reasonOf(v)).toContain('route get /items/:id');
  });

  it('allows a real rewrite that keeps most of the surface, new files and test files', async () => {
    const h = await harness({ 'src/store.ts': STORE, 'test/store.test.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' });
    const kept = STORE.replace("router.get('/items/:id'", "router.get('/items/:itemId'").replace('getItem(req.params.id)', 'getItem(req.params.itemId)');
    expect((await run(callInfo(writeFile, { path: 'src/store.ts', content: kept }), h.ctx)).decision).toBe('pass');
    expect((await run(callInfo(writeFile, { path: 'src/other.ts', content: 'export {};\n' }), h.ctx)).decision).toBe('pass');
    // Test files are not governed source: test-preservation owns them.
    expect((await run(callInfo(writeFile, { path: 'test/store.test.ts', content: 'export {};\n' }), h.ctx)).decision).toBe('pass');
  });

  it('destructiveWrite: parse breakage only counts when the file parsed before; tiny files have no surface to judge', () => {
    expect(destructiveWrite('src/a.ts', 'export const a = 1;\nexport const b = 2;\n', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n')).toBeNull();
    expect(destructiveWrite('src/a.ts', 'export const a = (;\n', 'export const a = (;\n// still broken\n')).toBeNull();
    expect(destructiveWrite('src/a.ts', 'export const a = 1;\n', 'export const renamed = 1;\n')).toBeNull();
    expect(destructiveWrite('src/a.ts', 'export const a = 1;\nexport const b = 2;\n', 'export const a = 1;\n')).toBeNull();
    expect(destructiveWrite('src/a.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n', 'export const a = 1;\n')).toContain('lose 2 of the 3');
    expect(destructiveWrite('src/a.ts', 'module.exports.a = 1;\nexports.b = 2;\nexports.c = 3;\n', '')).toContain('lose 3 of the 3');
  });
});
