/**
 * Observed red, end to end with the harness's REAL runner (vitest, sandboxed): what counts as
 * a red, what unlocks a source file, and the observed-red gate's red -> green on unchanged cases.
 * Reproduces the external review's attack (side-effect import + expect(true).toBe(false)) and
 * its variants.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GateResult, HookVerdict } from '../../src/core/plugin-api.ts';
import { exec } from '../../src/core/exec.ts';
import { saveInitial } from '../../src/core/initial.ts';
import { createServices } from '../../src/core/services.ts';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import runTestsTool from '../../plugins/tools/run_tests.ts';
import testMapTool from '../../plugins/tools/test_map.ts';
import writeFileTool from '../../plugins/tools/write_file.ts';
import { brownfieldTask, callInfo, callTool, emptyRegistry, HARNESS_ROOT, makeHarness, removeTmp, sha } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const USERS = 'export function countUsers(): number {\n  return 0;\n}\n';
const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'red-green-api', type: 'module', private: true }),
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
  'src/users.ts': USERS,
};
const VITEST = "import { describe, expect, it } from 'vitest';\n";

/** A brownfield run over BASE (+ extra files that existed at start), with the real runner and test map. */
async function harness(extra: Record<string, string> = {}) {
  const files = { ...BASE, ...extra };
  const h = await makeHarness({ label: 'red-green', task: brownfieldTask(), files, exec });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(files)) h.ctx.state.initialHashes.set(rel, sha(content));
  await saveInitial(h.ctx.run.runDir, new Map(Object.entries(files)));
  h.ctx.services = createServices({ ws: h.ws, registry: emptyRegistry(), state: h.ctx.state, logs: h.ctx.logs, exec, harnessRoot: HARNESS_ROOT, runDir: h.ctx.run.runDir });
  /** A write through the observed-red hook, as the loop does it: blocked, or written. */
  const write = async (path: string, content: string): Promise<HookVerdict> => {
    const verdict = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path, content }) }, h.ctx);
    if (verdict.decision === 'pass') await h.ws.write(path, content);
    return verdict;
  };
  const runTests = async (files?: string[]) => callTool(runTestsTool, files === undefined ? {} : { files }, h.ctx);
  const gate = async (): Promise<GateResult> => observedRedGate.run(h.ctx, 'finish');
  const latest = (file: string) => h.ctx.state.tests.filter((o) => o.file === file).at(-1);
  return { ...h, write, runTests, gate, latest };
}

const reason = (v: HookVerdict): string => (v.decision === 'block' ? v.reason : '');
const FIXED = 'export function countUsers(): number {\n  return 1;\n}\n';

describe('what counts as red', () => {
  it("the review's attack: a side-effect import + expect(true).toBe(false) is not red; the source stays locked", async () => {
    const h = await harness();
    expect((await h.write('test/users.test.ts', `${VITEST}import '../src/users.ts';\nit('x', () => { expect(true).toBe(false); });\n`)).decision).toBe('pass');
    const res = await h.runTests(['test/users.test.ts']);
    expect(res.summary).toContain('test/users.test.ts: 1 of 1 tests failed; red rejected: the failing cases only assert constants');
    expect(res.summary).not.toContain('observed red:');
    expect(h.latest('test/users.test.ts')).toMatchObject({ status: 'fail', validRed: false });
    const v = await h.write('src/users.ts', FIXED);
    expect(v.decision).toBe('block');
    expect(reason(v)).toContain('red rejected: the failing cases only assert constants');
    expect((await h.gate()).summary).toBe('no observed red in this run');
  });

  it('a named import from src/ + expect(1).toBe(2) asserts constants only: rejected', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('x', () => { void countUsers; expect(1).toBe(2); });\n`);
    await h.runTests(['test/users.test.ts']);
    expect(h.latest('test/users.test.ts')).toMatchObject({ validRed: false, reason: '1 of 1 tests failed; red rejected: the failing cases only assert constants' });
    expect((await h.write('src/users.ts', FIXED)).decision).toBe('block');
  });

  it('a failing non-constant assertion that uses nothing imported from src/ is rejected (side-effect imports do not count)', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import '../src/users.ts';\nconst seen = [0];\nit('x', () => { expect(seen.length).toBe(2); });\n`);
    await h.runTests(['test/users.test.ts']);
    expect(h.latest('test/users.test.ts')?.reason).toBe("1 of 1 tests failed; red rejected: the failing cases do not assert on anything imported from src/ (an assertion, of any library, must use its value; side-effect imports, void x and typeof x don't count)");
    const v = await h.write('src/users.ts', FIXED);
    expect(reason(v)).toContain('do not assert on anything imported from src/');
  });

  it('a constant failure next to a real passing case is still not red (the FAILING case must qualify)', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('real', () => { expect(countUsers()).toBe(0); });\nit('cheap', () => { expect(true).toBe(false); });\n`);
    await h.runTests(['test/users.test.ts']);
    expect(h.latest('test/users.test.ts')).toMatchObject({ status: 'fail', validRed: false });
    expect((await h.write('src/users.ts', FIXED)).decision).toBe('block');
  });

  it('a real failing case unlocks the source, and red -> green on the unchanged case passes the gate', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\ndescribe('users', () => {\n  it('counts one user', () => { expect(countUsers()).toBe(1); });\n});\n`);
    const res = await h.runTests(['test/users.test.ts']);
    expect(res.summary).toContain('observed red: test/users.test.ts');
    expect(h.latest('test/users.test.ts')?.cases).toEqual([
      expect.objectContaining({ name: 'users > counts one user', status: 'fail', exercisesSource: true, constantOnly: false }),
    ]);
    expect((await h.write('src/users.ts', FIXED)).decision).toBe('pass');
    const g = await h.gate();
    expect(g.status, JSON.stringify(g)).toBe('pass');
    expect(g.summary).toContain('1 changed source files went red -> green on unchanged cases');
  });

  it('the gate fails while the red case still fails (it runs the tests itself)', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => { expect(countUsers()).toBe(1); });\n`);
    await h.runTests(['test/users.test.ts']);
    await h.write('src/users.ts', 'export function countUsers(): number {\n  return 2;\n}\n');
    expect(await h.gate()).toMatchObject({ status: 'fail', details: ['src/users.ts: test/users.test.ts: still failing ("counts")', expect.any(String)] });
  });

  it('a red case edited afterwards counts only through the revert check (differential proof)', async () => {
    // Real runs: models routinely fix their own red test before it goes green (gpt-5.4-mini was refused 7
    // times on body identity alone). An edited case is accepted iff its CURRENT body passes now and fails
    // with the run-start source: the source change, not the edit, makes it pass. Here countUsers() went
    // 0 -> 5 and the edited case asserts 5, so it is change-sensitive (a weak but real test: documented residual).
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => { expect(countUsers()).toBe(1); });\n`);
    await h.runTests(['test/users.test.ts']);
    expect((await h.write('src/users.ts', 'export function countUsers(): number {\n  return 5;\n}\n')).decision).toBe('pass');
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => { expect(countUsers()).toBe(5); });\n`);
    const res = await h.runTests(['test/users.test.ts']);
    expect(res.ok).toBe(true);
    expect((await h.gate()).status).toBe('pass');
  });

  it('a red case edited to pass regardless of the source is refused by the revert check', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => { expect(countUsers()).toBe(1); });\n`);
    await h.runTests(['test/users.test.ts']);
    expect((await h.write('src/users.ts', `${USERS}export const junk = 42;\n`)).decision).toBe('pass');
    // countUsers() still returns 0: the edit alone makes the case pass.
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => { expect(countUsers()).toBe(0); });\n`);
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.[0]).toContain('was edited after its red and its current body also passes with the run-start source (revert check)');
  });

  it('cosmetic edits to the red case (comments, whitespace) and new cases next to it keep the evidence', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => { expect(countUsers()).toBe(1); });\n`);
    await h.runTests(['test/users.test.ts']);
    await h.write('src/users.ts', FIXED);
    await h.write('test/users.test.ts', `${VITEST}import { countUsers } from '../src/users.ts';\nit('counts', () => {\n  // one user after the fix\n  expect(countUsers())\n    .toBe(1);\n});\nit('is a number', () => { expect(typeof countUsers()).toBe('number'); });\n`);
    expect((await h.gate()).status).toBe('pass');
  });

  it('brownfield: a new case appended to an existing test file goes red, unlocks, then green', async () => {
    const existing = `${VITEST}import { countUsers } from '../src/users.ts';\nit('starts empty', () => { expect(countUsers()).toBe(0); });\n`;
    const h = await harness({ 'test/users.test.ts': existing });
    const appended = existing.replace("from '../src/users.ts';", "from '../src/users.ts';\nimport { countAdmins } from '../src/users.ts';")
      + "it('counts admins', () => { expect(countAdmins()).toBe(0); });\n";
    expect((await h.write('test/users.test.ts', appended)).decision).toBe('pass');
    await h.runTests(['test/users.test.ts']);
    const obs = h.latest('test/users.test.ts');
    expect(obs).toMatchObject({ status: 'fail', validRed: true });
    expect(obs?.cases?.map((c) => [c.name, c.status])).toEqual([['starts empty', 'pass'], ['counts admins', 'fail']]);
    expect((await h.write('src/users.ts', `${USERS}export function countAdmins(): number {\n  return 0;\n}\n`)).decision).toBe('pass');
    expect((await h.gate()).status).toBe('pass');
  });

  it('cases that reach src/ through test support code (test/helpers.ts importing it) count as exercising source', async () => {
    const h = await harness();
    // test support code is writable without a red and is not governed source
    expect((await h.write('test/helpers.ts', "import { countUsers } from '../src/users.ts';\nexport const app = { count: () => countUsers() };\n")).decision).toBe('pass');
    await h.write('test/users.test.ts', `${VITEST}import { app } from './helpers.ts';\nit('counts via the app', () => { expect(app.count()).toBe(1); });\n`);
    await h.runTests(['test/users.test.ts']);
    expect(h.latest('test/users.test.ts')).toMatchObject({ validRed: true });
    expect((await h.write('src/users.ts', FIXED)).decision).toBe('pass');
    expect((await h.gate()).status).toBe('pass');
  });

  it('missing module: a red for a NEW file only when a case uses the missing module with a real assertion', async () => {
    const h = await harness();
    await h.write('test/projects.test.ts', `${VITEST}import { listProjects } from '../src/projects.ts';\nit('lists none', () => { expect(listProjects()).toEqual([]); });\n`);
    await h.runTests(['test/projects.test.ts']);
    expect(h.latest('test/projects.test.ts')).toMatchObject({ status: 'error', validRed: true, reason: 'imports src/projects.ts, which does not exist yet' });
    expect(h.latest('test/projects.test.ts')?.cases).toEqual([expect.objectContaining({ name: 'lists none', status: 'error' })]);
    expect((await h.write('src/projects.ts', 'export function listProjects(): string[] {\n  return [];\n}\n')).decision).toBe('pass');
    expect((await h.gate()).status).toBe('pass');

    const cheap = await harness();
    await cheap.write('test/projects.test.ts', `${VITEST}import '../src/projects.ts';\nit('x', () => { expect(true).toBe(false); });\n`);
    await cheap.runTests(['test/projects.test.ts']);
    expect(cheap.latest('test/projects.test.ts')).toMatchObject({ status: 'error', validRed: false });
    expect(cheap.latest('test/projects.test.ts')?.reason).toContain("red rejected: no test case uses anything imported from src/ (side-effect imports don't count)");
    expect((await cheap.write('src/projects.ts', 'export const x = 1;\n')).decision).toBe('block');
  });
});

describe('one definition of a test file in the tools', () => {
  it('run_tests runs runnable test files only; test support code is refused with the right advice', async () => {
    const h = await harness({ 'test/helpers.ts': 'export const h = 1;\n', 'test/users.ts': 'export const u = 1;\n' });
    for (const f of ['test/helpers.ts', 'test/users.ts', 'src/users.ts']) {
      const res = await h.runTests([f]);
      expect(res.ok, f).toBe(false);
      expect(res.summary, f).toContain('write test/<name>.test.ts');
    }
    const map = await callTool(testMapTool, { path: 'test/helpers.ts' }, h.ctx);
    expect(map.summary).toContain('test support code');
    const locked = await callTool(testMapTool, { path: 'src/users.ts' }, h.ctx);
    expect(locked.summary).toContain('write test/users.test.ts');
    const v = await h.write('src/users.ts', FIXED);
    expect(reason(v)).toContain('Write test/users.test.ts');
  });
});

/**
 * Second review round: ways to turn a red case green WITHOUT the source change causing it. Each
 * starts with a genuine red, then makes a junk source edit (countUsers still returns 0), then
 * flips the case green by other means. The gate must refuse every one (whole-call body hash +
 * the revert check: the case must fail again with the run-start source).
 */
describe('red -> green must be caused by the source change', () => {
  const IMPORT = `${VITEST.replace("import { describe, expect, it } from 'vitest';", "import { describe, expect, it, vi } from 'vitest';")}import { countUsers } from '../src/users.ts';\n`;
  const JUNK = `${USERS}export const junk = 42;\n`;

  async function redThenJunk(v1: string) {
    const h = await harness();
    expect((await h.write('test/users.test.ts', v1)).decision).toBe('pass');
    await h.runTests(['test/users.test.ts']);
    expect(h.latest('test/users.test.ts'), 'v1 must be a genuine red').toMatchObject({ status: 'fail', validRed: true });
    expect((await h.write('src/users.ts', JUNK)).decision).toBe('pass');
    return h;
  }

  it('a vi.mock added outside the unchanged case (B) is caught by the revert check', async () => {
    const v1 = `${IMPORT}it('counts one user', () => { expect(countUsers()).toBe(1); });\n`;
    const h = await redThenJunk(v1);
    await h.write('test/users.test.ts', `${IMPORT}vi.mock('../src/users.ts', () => ({ countUsers: () => 1 }));\nit('counts one user', () => { expect(countUsers()).toBe(1); });\n`);
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.[0]).toContain('also passes with the run-start source (revert check)');
  });

  it("the case's own timeout argument (C) is part of its identity", async () => {
    const tc = (ms: number): string => `${IMPORT}it('counts', async () => { await new Promise((r) => setTimeout(r, 200)); expect(countUsers()).toBe(0); }, ${ms});\n`;
    const h = await redThenJunk(tc(20));
    await h.write('test/users.test.ts', tc(5000));
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.[0]).toContain('edited after its red and its current body also passes with the run-start source (revert check)');
  });

  it('the .each table (D) is part of the case identity', async () => {
    const tc = (n: number): string => `${IMPORT}it.each([${n}])('counts %s', (n) => { expect(countUsers()).toBe(n); });\n`;
    const h = await redThenJunk(tc(1));
    await h.write('test/users.test.ts', tc(0));
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.[0]).toContain('edited after its red and its current body also passes with the run-start source (revert check)');
  });

  it('a file-level constant the case uses (E) is caught by the revert check', async () => {
    const tc = (want: number): string => `${IMPORT}const want = ${want};\nit('counts', () => { expect(countUsers()).toBe(want); });\n`;
    const h = await redThenJunk(tc(1));
    await h.write('test/users.test.ts', tc(0));
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.[0]).toContain('also passes with the run-start source (revert check)');
  });

  it('a time-dependent red (F) that flips with no edit is caught by the revert check', async () => {
    const later = Date.now() + 1500;
    const h = await redThenJunk(`${IMPORT}it('later', () => { expect(Date.now() + countUsers()).toBeGreaterThan(${later}); });\n`);
    await new Promise((r) => setTimeout(r, Math.max(0, later - Date.now()) + 300));
    const g = await h.gate();
    expect(g.status).toBe('fail');
    expect(g.details?.[0]).toContain('also passes with the run-start source (revert check)');
  });

  it('a red that really depends on the change still passes the revert check', async () => {
    const h = await harness();
    await h.write('test/users.test.ts', `${IMPORT}const want = 1;\nit('counts', () => { expect(countUsers()).toBe(want); });\n`);
    await h.runTests(['test/users.test.ts']);
    await h.write('src/users.ts', FIXED);
    const g = await h.gate();
    expect(g.status, JSON.stringify(g)).toBe('pass');
    expect(g.summary).toContain('red again with the original source');
  });

  it('shallow reds (9) do not unlock: naming src code is not asserting on it', async () => {
    for (const body of [
      'void countUsers; expect([].length).toBe(1);',
      'const t = true; void countUsers; expect(t).toBe(false);',
      "void countUsers; expect(JSON.parse('1')).toBe(2);",
      "expect(typeof countUsers).toBe('nonsense');",
    ]) {
      const h = await harness();
      await h.write('test/users.test.ts', `${IMPORT}it('x', () => { ${body} });\n`);
      await h.runTests(['test/users.test.ts']);
      expect(h.latest('test/users.test.ts')?.validRed, body).toBe(false);
      expect((await h.write('src/users.ts', FIXED)).decision, body).toBe('block');
    }
  });
});
