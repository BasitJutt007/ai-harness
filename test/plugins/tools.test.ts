import { afterEach, describe, expect, it } from 'vitest';
import type { CheckPlugin, CheckReport, RegistryView } from '../../src/core/plugin-api.ts';
import checkStandards from '../../plugins/tools/check_standards.ts';
import editFile from '../../plugins/tools/edit_file.ts';
import fetchStandard from '../../plugins/tools/fetch_standard.ts';
import finish from '../../plugins/tools/finish.ts';
import listFiles from '../../plugins/tools/list_files.ts';
import outline from '../../plugins/tools/outline.ts';
import plan from '../../plugins/tools/plan.ts';
import readFile from '../../plugins/tools/read_file.ts';
import runTests from '../../plugins/tools/run_tests.ts';
import searchCode from '../../plugins/tools/search_code.ts';
import testMap from '../../plugins/tools/test_map.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import { callTool, emptyRegistry, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(files: Record<string, string> = {}, extra: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = await makeHarness({ label: 'tools', files, ...extra });
  dirs.push(h.dir);
  return h;
}

const twelve = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('read_file', () => {
  it('caps at maxReadLines and tells the model how to continue', async () => {
    const { ctx } = await harness({ 'src/a.ts': twelve });
    const r = await callTool(readFile, { path: 'src/a.ts' }, ctx);
    expect(r.ok).toBe(true);
    const lines = r.summary.split('\n');
    expect(lines[0]).toBe('src/a.ts (lines 1-5 of 12)');
    expect(lines[1]).toBe('1| line 1');
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('… 7 more lines: read_file { "path": "src/a.ts", "startLine": 6 }');
    // Baseline return: the whole file, numbered (never shorter than the compact one).
    expect(r.raw?.split('\n')).toHaveLength(13);
    expect(r.raw?.split('\n')[12]).toBe('12| line 12');
  });

  it('serves explicit ranges and rejects bad ones', async () => {
    const { ctx } = await harness({ 'src/a.ts': twelve });
    const mid = await callTool(readFile, { path: 'src/a.ts', startLine: 10, endLine: 11 }, ctx);
    expect(mid.summary.split('\n')).toEqual(['src/a.ts (lines 10-11 of 12)', '10| line 10', '11| line 11', '… 1 more lines: read_file { "path": "src/a.ts", "startLine": 12 }']);
    const last = await callTool(readFile, { path: 'src/a.ts', startLine: 11, endLine: 99 }, ctx);
    expect(last.summary).toBe('src/a.ts (lines 11-12 of 12)\n11| line 11\n12| line 12');
    expect((await callTool(readFile, { path: 'src/a.ts', startLine: 13 }, ctx)).ok).toBe(false);
    expect((await callTool(readFile, { path: 'src/missing.ts' }, ctx)).summary).toContain('does not exist');
    expect((await callTool(readFile, { path: '../outside.ts' }, ctx)).summary).toContain('escapes the API root');
  });
});

describe('write_file', () => {
  it('creates files with parent dirs and reports stats + unified diff', async () => {
    const { ctx, ws } = await harness();
    const r = await callTool(writeFile, { path: 'src/deep/new.ts', content: 'a\nb\n' }, ctx);
    expect(r).toMatchObject({ ok: true, summary: 'wrote src/deep/new.ts (new, 2 lines)' });
    expect(r.raw).toContain('--- /dev/null');
    expect(await ws.read('src/deep/new.ts')).toBe('a\nb\n');
    expect(ctx.state.written.has('src/deep/new.ts')).toBe(true);

    const r2 = await callTool(writeFile, { path: './src/deep/new.ts', content: 'a\nc\nd\n' }, ctx);
    expect(r2.summary).toBe('wrote src/deep/new.ts (+2 −1 lines)');
    expect(r2.raw).toContain('-b\n+c\n+d');
    expect(writeFile.paths?.({ path: 'src/x.ts', content: '' })).toEqual(['src/x.ts']);
  });
});

describe('edit_file', () => {
  it('handles 0, 1 and 2 matches', async () => {
    const { ctx, ws } = await harness({ 'src/a.ts': 'const a = 1;\nconst b = 1;\n' });
    const none = await callTool(editFile, { path: 'src/a.ts', find: 'const c', replace: 'x' }, ctx);
    expect(none.ok).toBe(false);
    expect(none.summary).toContain('not found');

    const two = await callTool(editFile, { path: 'src/a.ts', find: '= 1;', replace: '= 2;' }, ctx);
    expect(two.ok).toBe(false);
    expect(two.summary).toContain('matches 2 times');
    expect(two.summary).toContain('lines 1, 2');
    expect(await ws.read('src/a.ts')).toBe('const a = 1;\nconst b = 1;\n');

    const one = await callTool(editFile, { path: 'src/a.ts', find: 'const b = 1;', replace: 'const b = 2;\nconst c = 3;' }, ctx);
    expect(one).toMatchObject({ ok: true, summary: 'edited src/a.ts (+2 −1)' });
    expect(await ws.read('src/a.ts')).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
    expect(ctx.state.written.has('src/a.ts')).toBe(true);

    expect((await callTool(editFile, { path: 'src/nope.ts', find: 'a', replace: 'b' }, ctx)).ok).toBe(false);
  });
});

describe('list_files / search_code / outline', () => {
  it('lists with a cap and searches with a cap', async () => {
    const files = { 'src/a.ts': 'foo\nbar foo\n', 'src/b.ts': 'foo\n', 'src/c.ts': '', 'test/a.test.ts': 'x', 'node_modules/z/i.ts': 'foo' };
    const { ctx } = await harness(files);
    const all = await callTool(listFiles, {}, ctx);
    expect(all.summary.split('\n')).toEqual(['4 files under .', 'src/a.ts', 'src/b.ts', 'src/c.ts', '… 1 more (narrow dir or pattern)']);
    const src = await callTool(listFiles, { dir: 'src', pattern: 'a*' }, ctx);
    expect(src.summary).toBe('1 files under src matching a*\nsrc/a.ts');

    const hits = await callTool(searchCode, { pattern: 'foo' }, ctx);
    expect(hits.summary.split('\n')).toEqual(['src/a.ts:1: foo', 'src/a.ts:2: bar foo', '… 1 more hits (narrow the pattern or glob)']);
    const re = await callTool(searchCode, { pattern: '^bar', regex: true, glob: 'src/**/*.ts' }, ctx);
    expect(re.summary).toBe('src/a.ts:2: bar foo');
    expect((await callTool(searchCode, { pattern: '(', regex: true }, ctx)).ok).toBe(false);
  });

  it('outlines a file', async () => {
    const { ctx } = await harness({ 'src/r.ts': "import { z } from 'zod';\nexport const S = z.string();\n" });
    const r = await callTool(outline, { path: 'src/r.ts' }, ctx);
    expect(r.summary).toBe('src/r.ts (3 lines)\nimports: zod\nexports: const S L2\nschemas: S L2');
  });
});

describe('run_tests / check_standards / fetch_standard / plan / finish', () => {
  it('run_tests returns the summary and names observed reds', async () => {
    const h = await harness({ 'test/a.test.ts': 'x' });
    h.outcomes.set('test/a.test.ts', 'fail');
    const r = await callTool(runTests, { files: ['test/a.test.ts'] }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('tests: 1 failed');
    expect(r.summary).toContain('observed red: test/a.test.ts');
    expect(h.ctx.state.tests).toHaveLength(1);
  });

  it('check_standards returns compact output and ok = verdict pass', async () => {
    let asked: unknown;
    const report: CheckReport = { root: '/x', findings: [], rules: [], verdict: { status: 'fail', percent: 50 }, text: 'FULL REPORT\nCOMPACT', compact: 'COMPACT' };
    const h = await harness({}, { services: { runChecks: async (o) => { asked = o; return report; } } });
    const r = await callTool(checkStandards, { rules: ['zod-boundary'] }, h.ctx);
    expect(r).toMatchObject({ ok: false, summary: 'COMPACT', raw: 'FULL REPORT\nCOMPACT' });
    expect(asked).toEqual({ rules: ['zod-boundary'] });
  });

  it('fetch_standard returns docs or lists ids', async () => {
    const check: CheckPlugin = { kind: 'check', id: 'rule-a', category: 'standards', description: 'd', unit: 'routes', doc: 'RULE A TEXT', run: async () => [] };
    const registry: RegistryView = { ...emptyRegistry(), checks: [{ plugin: check, file: 'plugins/checks/a.ts', sha256: 'x' }] };
    const h = await harness({}, { registry });
    expect((await callTool(fetchStandard, { rule: 'rule-a' }, h.ctx)).summary).toContain('RULE A TEXT');
    const bad = await callTool(fetchStandard, { rule: 'nope' }, h.ctx);
    expect(bad).toMatchObject({ ok: false });
    expect(bad.summary).toContain('available: rule-a');
  });

  it('fetch_standard falls back to the description, then a note, when doc/unit are missing', async () => {
    const described: CheckPlugin = { kind: 'check', id: 'rule-b', category: 'lint', description: 'ONE LINE', run: async () => [] };
    const bare: CheckPlugin = { kind: 'check', id: 'rule-c', category: 'orm', run: async () => [] };
    const registry: RegistryView = {
      ...emptyRegistry(),
      checks: [described, bare].map((plugin) => ({ plugin, file: `plugins/checks/${plugin.id}.ts`, sha256: 'x' })),
    };
    const h = await harness({}, { registry });
    expect((await callTool(fetchStandard, { rule: 'rule-b' }, h.ctx)).summary).toBe('rule-b (lint, unit: units)\nONE LINE');
    const c = await callTool(fetchStandard, { rule: 'rule-c' }, h.ctx);
    expect(c.ok).toBe(true);
    expect(c.summary).toBe('rule-c (orm, unit: units)\n(this rule has no documentation)');
  });

  it('plan records steps; finish requests the gates', async () => {
    const h = await harness();
    expect((await callTool(plan, { steps: ['a', 'b'] }, h.ctx)).summary).toBe('plan recorded (2 steps)');
    expect(h.ctx.state.plan).toEqual(['a', 'b']);
    expect(await callTool(finish, { summary: 'done' }, h.ctx)).toEqual({ ok: true, summary: 'finish requested', finish: { summary: 'done' } });
  });
});

describe('test_map', () => {
  it('reports covering tests, red status and lock state', async () => {
    const h = await harness({ 'test/items.test.ts': "import { x } from '../src/items.ts';\n", 'src/items.ts': 'export const x = 1;\n' });
    const locked = await callTool(testMap, { path: 'src/items.ts' }, h.ctx);
    expect(locked.summary).toBe('src/items.ts: LOCKED\ncovering tests:\n  test/items.test.ts: never run');
    h.outcomes.set('test/items.test.ts', 'fail');
    await h.services.runTests(['test/items.test.ts']);
    const open = await callTool(testMap, { path: 'src/items.ts' }, h.ctx);
    expect(open.summary).toContain('UNLOCKED (by test/items.test.ts)');
    expect((await callTool(testMap, {}, h.ctx)).summary).toBe('1 test files\ntest/items.test.ts -> src/items.ts');
    expect((await callTool(testMap, { path: 'test/items.test.ts' }, h.ctx)).summary).toContain('covers: src/items.ts');
  });
});
