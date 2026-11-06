/**
 * A suite that fails to load on a named import its module does not export (Node's ESM linker: "The requested
 * module 'M' does not provide an export named 'X'") is recorded as such (TestObservation.missingExport), its
 * reason keeps that whole line (never clipped mid-name by stack frames), and run_tests shows the model the
 * error and the way out. The twin: CommonJS's "x is not a function" has many causes and is never read as a
 * missing export (no guess); any other load error keeps its message as before.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import runTestsTool from '../../plugins/tools/run_tests.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import type { TestRunnerInfo } from '../../src/core/target.ts';
import { runTargetTests } from '../../src/core/testing.ts';
import type { Exec, LogStore } from '../../src/core/types.ts';
import { brownfieldTask, callTool, makeHarness, removeTmp } from '../plugins/helpers.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'missing-export-')));
const dirs: string[] = [];
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await Promise.all(dirs.map(removeTmp));
});
mkdirSync(join(root, 'test'), { recursive: true });
writeFileSync(join(root, 'test/merge.test.ts'), "import { test } from 'node:test';\nimport { appendPage } from '../src/store/x/api';\ntest('t', () => { appendPage; });\n");

const RUNNER: TestRunnerInfo = { kind: 'node-test', name: 'node:test', supported: true, evidence: 'test', nodeArgs: [], patterns: [] };
const logs: LogStore = { write: async (name) => `logs/${name}.txt` };

/** The runner as node-test-reporter.mjs reports a file that failed to load with `message`. */
function loadFailure(message: string): Exec {
  const report = { testResults: [{ name: join(root, 'test/merge.test.ts'), status: 'failed', message, assertionResults: [] }], success: false };
  return async () => ({ code: 1, stdout: '', stderr: '', channel: JSON.stringify(report), durationMs: 1, timedOut: false });
}

const ESM = "SyntaxError: The requested module '../src/store/x/api' does not provide an export named 'appendPage'\n    at #asyncInstantiate (node:internal/modules/esm/module_job:327:21)\n    at async ModuleJob.run (node:internal/modules/esm/module_job:431:5)";
const CJS = 'TypeError: (0 , import_api.appendPage) is not a function\n    at Object.<anonymous> (test/merge.test.ts:3:1)';

describe('a load failure on a missing named export', () => {
  it('is recorded with the specifier and the name, and the reason is the whole linker line', async () => {
    const report = await runTargetTests({ root, files: ['test/merge.test.ts'], exec: loadFailure(ESM), harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: RUNNER });
    expect(report.observations[0]).toMatchObject({
      status: 'error',
      validRed: false,
      missingExport: { module: '../src/store/x/api', name: 'appendPage' },
      reason: "suite error: SyntaxError: The requested module '../src/store/x/api' does not provide an export named 'appendPage'",
    });
    expect(report.summary).toContain("ERROR test/merge.test.ts: suite error: SyntaxError: The requested module '../src/store/x/api' does not provide an export named 'appendPage'");
  });

  it("twin: CommonJS's 'is not a function' is not read as a missing export; its message stays the reason", async () => {
    const report = await runTargetTests({ root, files: ['test/merge.test.ts'], exec: loadFailure(CJS), harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: RUNNER });
    expect(report.observations[0]?.missingExport).toBeUndefined();
    expect(report.observations[0]?.reason).toMatch(/^suite error: TypeError: \(0 , import_api\.appendPage\) is not a function/);
  });

  it('run_tests shows the model the load error and the way out; the twin (another load error) gets no such line', async () => {
    for (const [message, hint] of [[ESM, true], [CJS, false]] as const) {
      const h = await makeHarness({ label: 'missing-export', task: brownfieldTask() });
      dirs.push(h.dir);
      h.ctx.services = { ...h.ctx.services, runTests: () => runTargetTests({ root, files: ['test/merge.test.ts'], exec: loadFailure(message), harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: RUNNER }) };
      const res = await callTool(runTestsTool, {}, h.ctx);
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('ERROR test/merge.test.ts: suite error:');
      const line = "test/merge.test.ts failed to load: the module '../src/store/x/api' it imports does not export appendPage. If that module declares appendPage, add `export` to that declaration (an export-only edit is allowed even while the file is locked), then run this test again to observe a real assertion.";
      if (hint) expect(res.summary).toContain(line);
      else expect(res.summary).not.toContain('failed to load: the module');
    }
  });
});
