/**
 * The run-start test baseline against real vitest runs: skipped, todo and describe.skip cases are recorded
 * by file and full name (never as observations), and tests-green then lets those through while a skip the
 * run adds keeps it unproven.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import testsGreen from '../../plugins/gates/tests-green.ts';
import { exec } from '../../src/core/exec.ts';
import { measureTestBaseline } from '../../src/core/test-baseline.ts';
import { runVitest } from '../../src/core/testing.ts';
import type { LogStore, TestBaseline } from '../../src/core/types.ts';
import { brownfieldTask, HARNESS_ROOT, makeHarness, removeTmp, type FakeHarness } from '../plugins/helpers.ts';

const logs: LogStore = { write: (name) => Promise.resolve(`(memory)/${name}`) };

const LEGACY = [
  "import { describe, expect, it } from 'vitest';",
  "describe('legacy', () => {",
  "  it('runs', () => { expect(1 + 1).toBe(2); });",
  "  it.skip('waits for a fix', () => { expect(1).toBe(2); });",
  "  it.todo('covers the archive flow');",
  '});',
  "describe.skip('old suite', () => {",
  "  it('inner', () => { expect(true).toBe(false); });",
  '});',
  '',
].join('\n');

let h: FakeHarness;
let baseline: TestBaseline;

beforeAll(async () => {
  h = await makeHarness({
    label: 'test-baseline',
    task: brownfieldTask(),
    files: {
      'package.json': JSON.stringify({ name: 'legacy-api', type: 'module', private: true }),
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
      'test/legacy.test.ts': LEGACY,
    },
  });
  // The real runner, as services.runTests uses it.
  h.ctx.services.runTests = async (files) => runVitest({ root: h.ws.root, ...(files !== undefined ? { files } : {}), exec, harnessRoot: HARNESS_ROOT, logs, turn: h.ctx.state.turn });
  baseline = await measureTestBaseline({ root: h.ws.root, exec, harnessRoot: HARNESS_ROOT, logs });
}, 120_000);
afterAll(async () => removeTmp(h.dir));

describe('the run-start baseline (real vitest)', () => {
  it('records skipped, todo and describe.skip cases by file and full name; nothing is an observation', () => {
    expect(baseline.error).toBeUndefined();
    expect(baseline.totals).toEqual({ files: 1, tests: 4, passed: 1, failed: 0 });
    expect(baseline.skipped).toEqual([
      { file: 'test/legacy.test.ts', name: 'legacy > waits for a fix', status: 'skip' },
      { file: 'test/legacy.test.ts', name: 'legacy > covers the archive flow', status: 'todo' },
      { file: 'test/legacy.test.ts', name: 'old suite > inner', status: 'skip' },
    ]);
    expect(baseline.failed).toEqual([]);
    expect(h.ctx.state.tests).toEqual([]);
  });

  it('tests-green passes with only those pre-existing skips, and lists them for a human', async () => {
    h.ctx.state.testBaseline = baseline;
    const r = await testsGreen.run(h.ctx, 'finish');
    expect(r.status).toBe('pass');
    expect(r.summary).toBe('1/4 tests passed in 1 files; 3 pre-existing skipped (not blocking: skipped or todo at run start)');
    expect(r.humanMustVerify).toEqual([
      'pre-existing skipped (not blocking): test/legacy.test.ts > legacy > waits for a fix',
      'pre-existing skipped (not blocking): test/legacy.test.ts > legacy > covers the archive flow (todo)',
      'pre-existing skipped (not blocking): test/legacy.test.ts > old suite > inner',
    ]);
  }, 120_000);

  it('a skip the agent adds keeps tests-green unproven; without the baseline every skip does', async () => {
    const file = join(h.ws.root, 'test', 'added.test.ts');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "import { expect, it } from 'vitest';\nit('new behaviour', () => { expect(2).toBe(2); });\nit.skip('new edge case', () => { expect(1).toBe(2); });\n");
    h.ctx.state.testBaseline = baseline;
    const r = await testsGreen.run(h.ctx, 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toBe('4 of 6 tests skipped or todo: 1 introduced by this run (remove .skip/.todo/.only; a skipped test proves nothing); 3 pre-existing (not blocking)');
    expect(r.details).toContain('skipped by this run: test/added.test.ts > new edge case');
    h.ctx.state.testBaseline = undefined;
    expect((await testsGreen.run(h.ctx, 'finish')).summary).toBe('4 of 6 tests skipped or todo (remove .skip/.todo/.only; a skipped test proves nothing)');
  }, 120_000);
});
