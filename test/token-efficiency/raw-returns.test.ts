/**
 * Baseline honesty for the context tools: each tool's raw return (what the shadow baseline
 * replays) is the naive, uncapped output, and never shorter than the compact summary the
 * model sees, so the raw-return attribution can never go negative.
 */
import { afterAll, describe, expect, it } from 'vitest';
import checkStandards from '../../plugins/tools/check_standards.ts';
import fetchStandard from '../../plugins/tools/fetch_standard.ts';
import listFiles from '../../plugins/tools/list_files.ts';
import outline from '../../plugins/tools/outline.ts';
import readFile from '../../plugins/tools/read_file.ts';
import runTests from '../../plugins/tools/run_tests.ts';
import searchCode from '../../plugins/tools/search_code.ts';
import type { CheckPlugin, TestRunReport, ToolResult } from '../../src/core/types.ts';
import { callTool, emptyRegistry, makeHarness, removeTmp } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeTmp(d);
});

const twelve = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const route = "import { z } from 'zod';\nexport const S = z.object({ a: z.string() });\nexport function f(): number {\n  return 1;\n}\n";

async function harness() {
  const check: CheckPlugin = {
    kind: 'check', id: 'zod-boundary', category: 'standards', description: 'd', unit: 'handlers', doc: 'FULL DOC', run: async () => [],
  };
  const h = await makeHarness({
    label: 'raw-returns',
    files: { 'src/a.ts': twelve, 'src/r.ts': route, 'src/b.ts': 'foo\n', 'src/c.ts': 'x\n', 'src/d.ts': 'y\n', 'src/e.ts': '' },
    registry: { ...emptyRegistry(), checks: [{ plugin: check, file: 'plugins/checks/z.ts', sha256: '0' }] },
    services: {
      runChecks: async () => ({ root: '/x', findings: [], rules: [], verdict: { status: 'fail', percent: 50 }, text: 'FULL REPORT\nline\nline\nverdict 50%', compact: 'verdict 50%' }),
    },
  });
  dirs.push(h.dir);
  return h;
}

function honest(r: ToolResult): void {
  expect(r.ok).toBe(true);
  expect((r.raw ?? r.summary).length).toBeGreaterThanOrEqual(r.summary.length);
}

describe('raw returns are the naive output and never shorter than the summary', () => {
  it('read_file: raw is the whole file with line numbers, for capped, ranged and complete reads', async () => {
    const { ctx } = await harness();
    const capped = await callTool(readFile, { path: 'src/a.ts' }, ctx);
    honest(capped);
    expect(capped.raw?.split('\n')).toHaveLength(13);
    expect(capped.raw).toContain('12| line 12');
    honest(await callTool(readFile, { path: 'src/a.ts', startLine: 11, endLine: 12 }, ctx));
    const whole = await callTool(readFile, { path: 'src/b.ts' }, ctx);
    expect(whole.raw).toBe(whole.summary);
    honest(await callTool(readFile, { path: 'src/e.ts' }, ctx));
  });

  it('list_files: raw is the full recursive listing (or the summary when that is longer)', async () => {
    const { ctx, ws } = await harness();
    const short = await callTool(listFiles, {}, ctx);
    honest(short);
    // 3 hidden short names are shorter than the "… 3 more (narrow dir or pattern)" line
    expect(short.raw).toBe(short.summary);
    await ws.write('src/modules/accounts/handlers/create-account.ts', 'x\n');
    await ws.write('src/modules/accounts/handlers/delete-account.ts', 'x\n');
    const long = await callTool(listFiles, {}, ctx);
    honest(long);
    expect(long.summary).toContain('5 more (narrow dir or pattern)');
    expect(long.raw?.split('\n')).toHaveLength(1 + 8);
  });

  it('search_code: raw is every hit with the full line, and no hits is not shorter', async () => {
    const { ctx } = await harness();
    const hits = await callTool(searchCode, { pattern: 'line' }, ctx);
    honest(hits);
    expect(hits.raw?.split('\n')).toHaveLength(12);
    honest(await callTool(searchCode, { pattern: 'no such text anywhere' }, ctx));
  });

  it('outline: raw is the whole file', async () => {
    const { ctx } = await harness();
    const r = await callTool(outline, { path: 'src/r.ts' }, ctx);
    honest(r);
    expect(r.raw).toContain('return 1;');
  });

  it('check_standards and fetch_standard: raw is the full report / doc', async () => {
    const { ctx } = await harness();
    const c = await callTool(checkStandards, {}, ctx);
    expect(c.raw).toBe('FULL REPORT\nline\nline\nverdict 50%');
    expect(c.summary).toBe('verdict 50%');
    honest(await callTool(fetchStandard, { rule: 'zod-boundary' }, ctx));
  });

  it('run_tests: raw is the runner console output plus the harness notes; summary when there is none', async () => {
    const consoleText = [' RUN  v4', ' × test/a.test.ts > case 1 12ms', '', ' FAIL  test/a.test.ts > case 1', 'AssertionError: expected 404 to be 201', '      Tests  1 failed (1)'].join('\n');
    const report = (console: string | undefined): TestRunReport => ({
      ok: false,
      totals: { files: 1, tests: 1, passed: 0, failed: 1 },
      observations: [{ file: 'test/a.test.ts', hash: 'h', status: 'fail', collected: 1, failed: 1, validRed: true, reason: 'r', turn: 1, at: 'x' }],
      summary: 'tests: 1 failed, 0 passed (1) in 1 files\nFAIL test/a.test.ts > case 1: expected 404 to be 201',
      logPath: 'runs/x/logs/001-vitest.txt',
      ...(console === undefined ? {} : { console }),
    });
    for (const c of [consoleText, undefined]) {
      const h = await makeHarness({ label: 'raw-run-tests', files: { 'test/a.test.ts': 'x' }, services: { runTests: async () => report(c) } });
      dirs.push(h.dir);
      const r = await callTool(runTests, { files: ['test/a.test.ts'] }, h.ctx);
      expect(r.ok).toBe(false);
      expect((r.raw ?? r.summary).length).toBeGreaterThanOrEqual(r.summary.length);
      expect(r.summary).toContain('observed red: test/a.test.ts');
      if (c === undefined) expect(r.raw).toBe(r.summary);
      else {
        expect(r.raw?.startsWith(consoleText)).toBe(true);
        expect(r.raw).toContain('observed red: test/a.test.ts');
        expect(r.summary).not.toContain(' RUN  v4');
      }
    }
  });
});
