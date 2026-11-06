/**
 * Production JavaScript is never test support in place. A dedicated test dir can be learned only because it
 * lies outside the build (tsconfig include ["src"] and a runner glob 'api/**\/*.test.js' make api/ one); in a
 * web layout (an in-place run) a file there is test support only when it sits under a conventionally named
 * test directory. Anything else (api/charge.js) is governed code: it needs a red, or is named UNPROVEN, so an
 * edit to it next to a proven src/ edit can never end "Work completed". Each refusal is paired with its
 * allowed twin (a helper under __tests__/ is still support), and the in-place rule with file mode's.
 */
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import { proofTier, unprovenEdits } from '../../plugins/lib/proof.ts';
import { recordUnlocked } from '../../plugins/lib/red.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import type { RunContext, RunnerSummary, TargetLayout, TestRunReport } from '../../src/core/plugin-api.ts';
import { computeTargetProfile, isGovernedCodePath, isTestSupportPath, LEGACY_LAYOUT, setActiveLayout } from '../../src/core/target.ts';
import { scratch, writeTree } from '../target/_variants.ts';
import { brownfieldTask, callInfo, makeHarness, removeTmp, sha } from './helpers.ts';

const tmp = scratch('web-test-support');
const dirs: string[] = [];
afterEach(async () => {
  setActiveLayout(undefined);
  await Promise.all(dirs.splice(0).map(removeTmp));
});
afterAll(() => tmp.cleanup());

/** The mixed repository of the finding: TypeScript under src/, production JavaScript and its tests under api/. */
const MIXED = {
  'package.json': JSON.stringify({ name: 'mixed', private: true, type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '5.0.3', typescript: '6.0.3' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts', 'api/**/*.test.js'] } });\n",
  'src/money.ts': 'export const cents = (n: number): number => Math.round(n * 100);\n',
  'src/money.test.ts': "import { expect, it } from 'vitest';\nimport { cents } from './money.ts';\nit('cents', () => expect(cents(1)).toBe(100));\n",
  'api/charge.js': "import { cents } from '../src/money.ts';\nexport const charge = (n) => ({ amount: cents(n) });\n",
  'api/charge.test.js': "import { expect, it } from 'vitest';\nimport { charge } from './charge.js';\nit('charge', () => expect(charge(1).amount).toBe(100));\n",
  'api/__tests__/fixtures.js': 'export const card = { number: "4242" };\n',
};

describe('the layout of the mixed repository', () => {
  it('in place: api/ stays a test dir, but api/charge.js is governed code; a helper under __tests__/ is still support (the twin)', async () => {
    const root = join(tmp.dir, 'mixed');
    writeTree(root, MIXED);
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace: true });
    expect(p.testSupportRoots).toEqual(['api']);
    expect(p.codeKinds).toBe('web');
    expect(isTestSupportPath('api/charge.js', p)).toBe(false);
    expect(isGovernedCodePath('api/charge.js', p)).toBe(true);
    expect(isTestSupportPath('api/__tests__/fixtures.js', p)).toBe(true);
    expect(isGovernedCodePath('api/__tests__/fixtures.js', p)).toBe(false);
    expect(isTestSupportPath('api/charge.test.js', p)).toBe(false);
  });

  it('file-mode twin: the 01 rule is unchanged (any non-test file in a dedicated test dir is support)', async () => {
    const root = join(tmp.dir, 'mixed-file');
    writeTree(root, { ...MIXED, 'api/helpers.ts': 'export const two = 2;\n' });
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.testSupportRoots).toEqual(['api']);
    expect(p.codeKinds).toBeUndefined();
    expect(isTestSupportPath('api/helpers.ts', p)).toBe(true);
    expect(isGovernedCodePath('api/helpers.ts', p)).toBe(false);
  });
});

const SUPPORTED: RunnerSummary = { kind: 'vitest', name: 'vitest 5.0.3', supported: true };
const IN_PLACE = { inPlace: { repoTop: '/repo', branch: 'feat/x' } };
/** The mixed layout as an in-place run has it (tests of src/ under test/, so the fake test map sees them). */
const WEB: TargetLayout = {
  ...LEGACY_LAYOUT, sourceRoots: ['src'], testRoots: ['api', 'test'], testSupportRoots: ['api', 'test'],
  testGlobs: ['test/**/*.test.ts', 'api/**/*.test.js'], codeKinds: 'web',
};

const START = {
  'src/money.ts': 'export const cents = (n) => n * 100;\n',
  'test/money.test.ts': "import { cents } from '../src/money.ts';\n",
  'api/charge.js': 'export const charge = (n) => n;\n',
  'api/__tests__/fixtures.js': 'export const card = 1;\n',
};

/** An in-place harness over START (plus `extra`) whose src/money.ts went red -> green (and red again on revert). */
async function provenSrcEdit(layout: TargetLayout, extra: Record<string, string> = {}, money = 'export const cents = (n) => Math.round(n * 100);\n') {
  const files = { ...START, ...extra };
  const h = await makeHarness({ label: 'web-support', task: brownfieldTask(), files });
  dirs.push(h.dir);
  setActiveLayout(layout);
  for (const [rel, content] of Object.entries(files)) h.ctx.state.initialHashes.set(rel, sha(content));
  const ctx: RunContext = { ...h.ctx, ...IN_PLACE, runner: SUPPORTED };
  const inner = h.services.runTests;
  ctx.services.runTests = async (files) => {
    const report = await inner(files);
    for (const o of report.observations) o.cases = [{ name: 'case', status: o.status, bodyHash: o.hash, exercisesSource: true, constantOnly: false }];
    return report;
  };
  const copy = async (files: string[], status: 'pass' | 'fail'): Promise<TestRunReport> => ({
    ok: status === 'pass', totals: { files: files.length, tests: files.length, passed: 0, failed: 0 }, summary: '', logPath: '',
    observations: await Promise.all(files.map(async (file) => {
      const hash = sha((await h.ws.read(file)) ?? '');
      return { file, hash, status, collected: 1, failed: status === 'fail' ? 1 : 0, validRed: false, reason: '', turn: 1, at: '', cases: [{ name: 'case', status, bodyHash: hash, exercisesSource: true, constantOnly: false }] };
    })),
  });
  ctx.services.runTestsReverted = async (files) => ({ current: await copy(files, 'pass'), reverted: await copy(files, 'fail') });
  h.outcomes.set('test/money.test.ts', 'fail');
  await ctx.services.runTests();
  h.outcomes.set('test/money.test.ts', 'pass');
  recordUnlocked(ctx.state, 'src/money.ts');
  await h.ws.write('src/money.ts', money);
  return { ...h, ctx };
}

describe('an edit to production JavaScript in a test dir never passes silently', () => {
  it('the twin first: a proven src/ edit alone passes the observed-red gate', async () => {
    const h = await provenSrcEdit(WEB);
    expect(await observedRedGate.run(h.ctx, 'finish')).toMatchObject({ status: 'pass' });
  });

  it('the mixed change (api/charge.js too) is UNPROVEN, naming api/charge.js: never "Work completed"', async () => {
    const h = await provenSrcEdit(WEB);
    await h.ws.write('api/charge.js', 'export const charge = (n) => n * 2;\n');
    const r = await observedRedGate.run(h.ctx, 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toMatch(/no test proves api\/charge\.js; verify by hand/);
    expect(r.details).toEqual(['api/charge.js: logic outside the source roots (src/): a red only counts for code under them']);
  });

  it('a changed helper under api/__tests__/ is test support: the proof, never an unproven edit (the twin)', async () => {
    const h = await provenSrcEdit(WEB);
    await h.ws.write('api/__tests__/fixtures.js', 'export const card = 2;\n');
    expect(await observedRedGate.run(h.ctx, 'finish')).toMatchObject({ status: 'pass' });
  });

  it('the observed-red hook names the api/charge.js edit (a record, not a silent pass); a __tests__ helper passes (the twin)', async () => {
    const h = await provenSrcEdit(WEB);
    const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFile, { path: 'api/charge.js', content: 'export const charge = 1;\n' }) }, h.ctx);
    expect(v).toMatchObject({ decision: 'record' });
    if (v.decision === 'record') expect(v.note).toMatch(/no test can prove api\/charge\.js \(logic outside the source roots/);
    const helper = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFile, { path: 'api/__tests__/fixtures.js', content: 'export const card = 3;\n' }) }, h.ctx);
    expect(helper).toEqual({ decision: 'pass' });
  });

  it('proof tiers: logic under the source roots needs its red; logic outside them is UNPROVEN; file mode keeps one tier', () => {
    setActiveLayout(WEB);
    expect(proofTier({ ...IN_PLACE, runner: SUPPORTED }, 'src/money.ts')).toEqual({ tier: 'red' });
    expect(proofTier({ ...IN_PLACE, runner: SUPPORTED }, 'api/charge.js')).toMatchObject({ tier: 'unproven', why: expect.stringMatching(/outside the source roots/) });
    expect(proofTier({ runner: SUPPORTED }, 'api/charge.js')).toEqual({ tier: 'red' });
  });
});

/**
 * The folder-name rule is narrow: integration/, spec/ and specs/ find tests (TEST_DIR_RE) but production code
 * uses those names too (a payment provider integration, an API spec module), so in place they never make a file
 * test support. A support file that production code imports is production code too: named, never the proof.
 */
describe('production JavaScript in a folder named like a test dir, and support that production imports', () => {
  const INTEGRATION = {
    ...MIXED,
    'api/integration/charge.js': "import { cents } from '../../src/money.ts';\nexport const charge = (n) => ({ amount: cents(n) });\n",
    'api/integration/charge.test.js': "import { expect, it } from 'vitest';\nimport { charge } from './charge.js';\nit('charge', () => expect(charge(1).amount).toBe(100));\n",
    'api/spec/openapi.js': 'export const spec = { openapi: "3.1.0" };\n',
  };

  it('in place: api/integration/charge.js and api/spec/openapi.js are governed; __tests__/, e2e/, __mocks__/ and test/ helpers stay support (the twins)', async () => {
    const root = join(tmp.dir, 'integration');
    writeTree(root, { ...INTEGRATION, 'api/e2e/login.js': 'export const user = "a";\n' });
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace: true });
    expect(p.testSupportRoots).toEqual(['api']);
    for (const f of ['api/integration/charge.js', 'api/spec/openapi.js', 'api/specs/x.js']) {
      expect(isTestSupportPath(f, p), f).toBe(false);
      expect(isGovernedCodePath(f, p), f).toBe(true);
    }
    for (const f of ['api/__tests__/fixtures.js', 'api/e2e/login.js', 'api/integration/__mocks__/stripe.js', 'api/integration/test/helpers.js']) {
      expect(isTestSupportPath(f, p), f).toBe(true);
    }
  });

  it('file-mode twin: the 01 rule is unchanged (api/integration/helper.ts in a dedicated test dir is support)', async () => {
    const root = join(tmp.dir, 'integration-file');
    writeTree(root, { ...INTEGRATION, 'api/integration/helper.ts': 'export const two = 2;\n' });
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.testSupportRoots).toEqual(['api']);
    expect(isTestSupportPath('api/integration/helper.ts', p)).toBe(true);
  });

  const EXTRA = { 'api/integration/charge.js': 'export const charge = (n) => n;\n' };

  it('a proven src/ edit plus an api/integration/charge.js edit is UNPROVEN naming it, and the hook records it', async () => {
    const h = await provenSrcEdit(WEB, EXTRA);
    const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFile, { path: 'api/integration/charge.js', content: 'export const charge = (n) => n * 2;\n' }) }, h.ctx);
    expect(v).toMatchObject({ decision: 'record' });
    await h.ws.write('api/integration/charge.js', 'export const charge = (n) => n * 2;\n');
    expect(await unprovenEdits(h.ctx)).toEqual([{ file: 'api/integration/charge.js', why: expect.stringMatching(/logic outside the source roots/) }]);
    const r = await observedRedGate.run(h.ctx, 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toMatch(/no test proves api\/integration\/charge\.js; verify by hand/);
  });

  it('the twin: the same proven src/ edit with an api/__tests__/ helper change passes', async () => {
    const h = await provenSrcEdit(WEB, EXTRA);
    await h.ws.write('api/__tests__/fixtures.js', 'export const card = 2;\n');
    expect(await unprovenEdits(h.ctx)).toEqual([]);
    expect(await observedRedGate.run(h.ctx, 'finish')).toMatchObject({ status: 'pass' });
  });

  const HELPER = { 'test/helpers/round.js': 'export const round = (n) => Math.round(n);\n' };

  it('a changed test helper that production code imports is named UNPROVEN, with its importer', async () => {
    const h = await provenSrcEdit(WEB, HELPER, "import { round } from '../test/helpers/round.js';\nexport const cents = (n) => round(n * 100);\n");
    await h.ws.write('test/helpers/round.js', 'export const round = (n) => Math.floor(n);\n');
    expect(await unprovenEdits(h.ctx)).toEqual([{ file: 'test/helpers/round.js', why: expect.stringMatching(/^test support that production code imports \(src\/money\.ts\)/) }]);
    const r = await observedRedGate.run(h.ctx, 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toMatch(/no test proves test\/helpers\/round\.js/);
  });

  it('the twin: the same helper change, imported only by a test, is the proof and passes', async () => {
    const h = await provenSrcEdit(WEB, { ...HELPER, 'test/money.test.ts': "import { cents } from '../src/money.ts';\nimport { round } from './helpers/round.js';\n" });
    await h.ws.write('test/helpers/round.js', 'export const round = (n) => Math.floor(n);\n');
    expect(await unprovenEdits(h.ctx)).toEqual([]);
    expect(await observedRedGate.run(h.ctx, 'finish')).toMatchObject({ status: 'pass' });
  });

  it('an unchanged helper that production code imports is not named (only changes are)', async () => {
    const h = await provenSrcEdit(WEB, HELPER, "import { round } from '../test/helpers/round.js';\nexport const cents = (n) => round(n * 100);\n");
    expect(await unprovenEdits(h.ctx)).toEqual([]);
  });
});
