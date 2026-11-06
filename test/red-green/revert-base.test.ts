/**
 * The observed-red revert check needs a BEHAVIOURAL flip, with the harness's real runner (node:test through
 * tsx, sandboxed) on a small React + Vite TypeScript app in the OS temp dir.
 *
 * The reverted copy of a file that existed at run start keeps the exports the run made of its run-start
 * declarations (export-only, verified): a test that imports a function the run exported still loads there,
 * so its case must fail on what the run-start code does. A case that only fails to LOAD in the reverted copy
 * is no flip for such a file (no assertion ran, nothing was compared), while for a file new in the run
 * (absent in the reverted copy) a load failure is the only way to fail, and counts. Each rule is paired with
 * its twin, on the real runner and on the gate's decision.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import { recordUnlocked } from '../../plugins/lib/red.ts';
import { exec } from '../../src/core/exec.ts';
import { saveInitial } from '../../src/core/initial.ts';
import type { RunContext, TestRunReport } from '../../src/core/plugin-api.ts';
import { createServices } from '../../src/core/services.ts';
import { computeTargetProfile, setActiveLayout } from '../../src/core/target.ts';
import { brownfieldTask, emptyRegistry, HARNESS_ROOT, makeHarness, removeTmp, sha } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  setActiveLayout(undefined);
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const API_FILE = 'src/store/x/api.ts';
const API = [
  'export interface Page {',
  '  items: string[];',
  '  next: string | null;',
  '}',
  '',
  'function appendPage(prev: Page, page: Page): Page {',
  '  return { items: [...page.items], next: page.next };',
  '}',
  '',
  'export async function loadMore(prev: Page, fetchPage: (cursor: string) => Promise<Page>): Promise<Page> {',
  '  if (prev.next === null) return prev;',
  '  return appendPage(prev, await fetchPage(prev.next));',
  '}',
  '',
].join('\n');
const BUG = 'return { items: [...page.items], next: page.next };';
const FIX = 'return { items: [...prev.items, ...page.items], next: page.next };';
const EXPORTED = API.replace('function appendPage', 'export function appendPage');

const APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'pager-web', private: true, type: 'module', dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0', typescript: '^5.0.0' } }),
  [API_FILE]: API,
};

const TEST_FILE = 'test/merge.test.ts';
const testOf = (name: string): string => [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  `import { ${name} } from '../src/store/x/api';`,
  '',
  "test('appending a page keeps the items already loaded', () => {",
  `  assert.deepEqual(${name}({ items: ['a'], next: 'c2' }, { items: ['b'], next: null }).items, ['a', 'b']);`,
  '});',
  '',
].join('\n');

/** A run over APP (run-start snapshot kept), in place, with the real runner and services. */
async function harness() {
  const h = await makeHarness({ label: 'revert-base', task: brownfieldTask(), files: APP, exec, under: realpathSync(tmpdir()) });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(APP)) h.ctx.state.initialHashes.set(rel, sha(content));
  await saveInitial(h.ctx.run.runDir, new Map(Object.entries(APP)));
  const profile = await computeTargetProfile({ apiRoot: h.ws.root, repoRoot: h.dir, harnessRoot: HARNESS_ROOT, inPlace: true });
  expect(profile.runner).toMatchObject({ kind: 'node-test', supported: true });
  const services = createServices({ ws: h.ws, registry: emptyRegistry(), state: h.ctx.state, logs: h.ctx.logs, exec, harnessRoot: HARNESS_ROOT, runDir: h.ctx.run.runDir, profile });
  const ctx: RunContext = { ...h.ctx, services, runner: profile.runner, inPlace: { repoTop: h.dir, branch: 'fix/pages' } };
  return { ...h, ctx, services };
}

/** red (the case fails on its assertion with `buggy`), then `fixed` (green), as an unlocked file; the gate's verdict. */
async function redThenGreen(h: Awaited<ReturnType<typeof harness>>, test: string, buggy: string, fixed: string) {
  await h.ws.write(TEST_FILE, test);
  await h.ws.write(API_FILE, buggy);
  const red = await h.services.runTests([TEST_FILE]);
  expect(red.observations[0]).toMatchObject({ status: 'fail', validRed: true });
  recordUnlocked(h.ctx.state, API_FILE);
  await h.ws.write(API_FILE, fixed);
  expect((await h.services.runTests([TEST_FILE])).ok).toBe(true);
  return observedRedGate.run(h.ctx, 'finish');
}

describe('the reverted copy keeps the exports the run made of run-start declarations', () => {
  it('a test importing a function the run exported loads in the reverted copy and FAILS ON ITS ASSERTION there: the flip counts', async () => {
    const h = await harness();
    await h.ws.write(TEST_FILE, testOf('appendPage'));
    await h.ws.write(API_FILE, EXPORTED.replace(BUG, FIX));
    const diff = await h.services.runTestsReverted([TEST_FILE], [API_FILE]);
    expect(diff.exportsKept).toEqual({ [API_FILE]: ['appendPage'] });
    expect(diff.current.observations[0]?.cases?.map((c) => c.status)).toEqual(['pass']);
    expect(diff.reverted.observations[0]).toMatchObject({ status: 'fail' });
    expect(diff.reverted.observations[0]?.cases?.map((c) => c.status)).toEqual(['fail']);
    const g = await redThenGreen(h, testOf('appendPage'), EXPORTED, EXPORTED.replace(BUG, FIX));
    expect(g, JSON.stringify(g)).toMatchObject({ status: 'pass' });
    expect(g.summary).toContain(`the reverted copies kept the exports the run added (${API_FILE}: appendPage)`);
  }, 180_000);

  it('twin: a declaration new in the run cannot be kept; its reverted copy only fails to LOAD, which proves nothing for an existing file', async () => {
    const h = await harness();
    const merge = 'export function mergePages(prev: Page, page: Page): Page {\n  return { items: [...page.items], next: page.next };\n}\n';
    const withMerge = `${API}${merge}`;
    await h.ws.write(TEST_FILE, testOf('mergePages'));
    await h.ws.write(API_FILE, withMerge.replace(BUG, FIX));
    const diff = await h.services.runTestsReverted([TEST_FILE], [API_FILE]);
    expect(diff.exportsKept).toBeUndefined();
    expect(diff.reverted.observations[0]).toMatchObject({ status: 'error', missingExport: { name: 'mergePages' } });
    expect(diff.reverted.observations[0]?.cases?.map((c) => c.status)).toEqual(['error']);
    const g = await redThenGreen(h, testOf('mergePages'), withMerge, `${API}${merge.replace(BUG, FIX)}`);
    expect(g.status).toBe('fail');
    expect(g.details?.join('\n')).toContain(`${API_FILE}: ${TEST_FILE}: "appending a page keeps the items already loaded" only fails to LOAD with ${API_FILE} at its run-start content (revert check): a load failure is no behavioural flip`);
  }, 180_000);
});

describe('the gate counts a load failure in the reverted copy only for a file new in the run', () => {
  /** A run whose test went red and green, and whose differential run reports `revStatus` for the case. */
  async function proofWith(revStatus: 'fail' | 'error', newFile: boolean) {
    const file = newFile ? 'src/store/x/merge.ts' : API_FILE;
    const h = await harness();
    const test = `import { test } from 'node:test';\nimport { appendPage } from '../${file.replace(/\.ts$/, '')}';\ntest('t', () => { appendPage; });\n`;
    await h.ws.write('test/t.test.ts', test);
    await h.ws.write(file, newFile ? 'export function appendPage() { return 1; }\n' : EXPORTED.replace(BUG, FIX));
    recordUnlocked(h.ctx.state, file);
    const obs = (status: 'fail' | 'error' | 'pass') => ({
      file: 'test/t.test.ts', hash: sha(test), status, collected: status === 'error' ? 0 : 1, failed: status === 'fail' ? 1 : 0, validRed: status !== 'pass', reason: status, turn: 1, at: '',
      cases: [{ name: 't', status, bodyHash: 'b', exercisesSource: true, constantOnly: false }],
    });
    h.ctx.state.tests.push(obs(newFile ? 'error' : 'fail'));
    const report = (status: 'fail' | 'error' | 'pass'): TestRunReport => ({ ok: status === 'pass', totals: { files: 1, tests: 1, passed: status === 'pass' ? 1 : 0, failed: 0 }, observations: [obs(status)], summary: '', logPath: '' });
    const ctx: RunContext = { ...h.ctx, services: { ...h.ctx.services, runTests: async () => report('pass'), runTestsReverted: async () => ({ current: report('pass'), reverted: report(revStatus) }) } };
    return observedRedGate.run(ctx, 'finish');
  }

  it('an existing file whose reverted copy only fails to LOAD: not a flip (fail, saying so)', async () => {
    const r = await proofWith('error', false);
    expect(r.status).toBe('fail');
    expect(r.details?.join('\n')).toContain(`${API_FILE}: test/t.test.ts: "t" only fails to LOAD with ${API_FILE} at its run-start content (revert check): a load failure is no behavioural flip`);
  });

  it('twin: the same file whose reverted copy fails on an assertion is proven', async () => {
    expect(await proofWith('fail', false)).toMatchObject({ status: 'pass' });
  });

  it('twin: a file new in the run, absent in the reverted copy, flips by a load failure (nothing can import it there)', async () => {
    expect(await proofWith('error', true)).toMatchObject({ status: 'pass' });
  });
});
