/**
 * Proof tiers of an in-place run (plugins/lib/proof.ts): logic needs an observed red where a supported
 * runner can run a test for it; everything else is allowed and named UNPROVEN by the observed-red gate
 * ("no test proves <files>; verify by hand"), so it can never end "Work completed". Each in-place
 * allowance is paired with the refusal that still holds (a supported runner keeps the red rule) and with
 * file mode, which keeps one tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import observedRedGate, { withUnprovenEdits } from '../../plugins/gates/observed-red.ts';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import { proofTier, unprovenEdits, unprovenLine } from '../../plugins/lib/proof.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import type { HookVerdict, RunContext, RunnerSummary } from '../../src/core/plugin-api.ts';
import { setActiveLayout, LEGACY_LAYOUT } from '../../src/core/target.ts';
import { brownfieldTask, callInfo, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  setActiveLayout(undefined);
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const SUPPORTED: RunnerSummary = { kind: 'vitest', name: 'vitest 5.0.3', supported: true };
const VUE_RUNNER: RunnerSummary = { ...SUPPORTED, components: ['.vue'] };
const UNSUPPORTED: RunnerSummary = { kind: 'unknown', name: 'karma', supported: false, reason: 'unsupported test runner karma (Angular ng test)' };
const IN_PLACE = { inPlace: { repoTop: '/repo', branch: 'feat/x' } };

describe('proofTier', () => {
  it('in place: logic with a supported runner is red tier; without one it is UNPROVEN with the reason', () => {
    expect(proofTier({ ...IN_PLACE, runner: SUPPORTED }, 'src/money.ts')).toEqual({ tier: 'red' });
    expect(proofTier({ ...IN_PLACE, runner: UNSUPPORTED }, 'src/money.ts')).toEqual({ tier: 'unproven', why: 'logic, but unsupported test runner karma (Angular ng test)' });
    expect(proofTier({ ...IN_PLACE }, 'src/money.ts')).toMatchObject({ tier: 'unproven', why: expect.stringMatching(/no test runner was detected/) });
  });

  it('in place: a component is red tier only where the runner can load its kind', () => {
    setActiveLayout({ ...LEGACY_LAYOUT, codeKinds: 'web' });
    expect(proofTier({ ...IN_PLACE, runner: VUE_RUNNER }, 'src/App.vue')).toEqual({ tier: 'red' });
    expect(proofTier({ ...IN_PLACE, runner: SUPPORTED }, 'src/App.vue')).toMatchObject({ tier: 'unproven', why: expect.stringMatching(/cannot load \.vue files/) });
    expect(proofTier({ ...IN_PLACE, runner: VUE_RUNNER }, 'src/Page.svelte')).toMatchObject({ tier: 'unproven' });
  });

  it('in place: styles, markup, docs and data are UNPROVEN whatever the runner', () => {
    for (const [f, kind] of [['src/a.css', 'a stylesheet'], ['public/index.html', 'markup'], ['docs/a.md', 'documentation'], ['src/en.json', 'data or configuration']] as const) {
      expect(proofTier({ ...IN_PLACE, runner: SUPPORTED }, f)).toEqual({ tier: 'unproven', why: `${kind}: no test can observe it` });
    }
  });

  it('file mode (the twin): one tier, every governed file needs its red, whatever the runner', () => {
    expect(proofTier({ runner: UNSUPPORTED }, 'src/money.ts')).toEqual({ tier: 'red' });
    expect(proofTier({}, 'src/money.ts')).toEqual({ tier: 'red' });
  });
});

/** A harness with a run-start snapshot of `files` (initialHashes), in place unless `fileMode`. */
async function harness(files: Record<string, string>, runner: RunnerSummary | undefined, opts: { fileMode?: boolean } = {}) {
  const h = await makeHarness({ label: 'proof-tiers', task: brownfieldTask(), files });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(files)) h.ctx.state.initialHashes.set(rel, sha(content));
  const ctx: RunContext = { ...h.ctx, ...(opts.fileMode === true ? {} : IN_PLACE), ...(runner !== undefined ? { runner } : {}) };
  return { ...h, ctx };
}

const hook = (ctx: RunContext, path: string, content = 'export const a = 2;\n'): Promise<HookVerdict> =>
  observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFile, { path, content }) }, ctx);

describe('observed-red hook in place', () => {
  const START = { 'src/money.ts': 'export const a = 1;\n', 'test/money.test.ts': "import { a } from '../src/money.ts';\n" };

  it('logic without a supported runner is let through with a note naming why no test can prove it', async () => {
    const h = await harness(START, UNSUPPORTED);
    const v = await hook(h.ctx, 'src/money.ts');
    expect(v).toMatchObject({ decision: 'record' });
    if (v.decision === 'record') expect(v.note).toMatch(/no test can prove src\/money\.ts \(logic, but unsupported test runner karma.*verdict will be UNPROVEN/);
  });

  it('the refusal that holds: with a supported runner the same edit still needs its red', async () => {
    const h = await harness(START, SUPPORTED);
    const v = await hook(h.ctx, 'src/money.ts');
    expect(v.decision).toBe('block');
    if (v.decision === 'block') expect(v.reason).toMatch(/^observed-red: src\/money\.ts is locked/);
  });

  it('file mode (the twin): without a supported runner the edit is still locked (one tier)', async () => {
    const h = await harness(START, UNSUPPORTED, { fileMode: true });
    expect((await hook(h.ctx, 'src/money.ts')).decision).toBe('block');
  });
});

describe('observed-red gate in place: UNPROVEN edits are named, never green', () => {
  it('a stylesheet-only change: UNPROVEN "no test proves <files>; verify by hand", not a failure for want of a red', async () => {
    const h = await harness({ 'src/a.css': 'a{}\n', 'src/money.ts': 'export const a = 1;\n' }, SUPPORTED);
    await h.ws.write('src/a.css', 'a{color:red}\n');
    await h.ws.write('docs/new.md', '# new\n');
    const r = await observedRedGate.run(h.ctx, 'finish');
    expect(r).toMatchObject({ status: 'unproven', summary: 'no test proves docs/new.md, src/a.css; verify by hand' });
    expect(r.details).toEqual(['docs/new.md: documentation: no test can observe it', 'src/a.css: a stylesheet: no test can observe it']);
    expect(r.humanMustVerify?.[0]).toMatch(/^docs\/new\.md: no test proves this change/);
  });

  it('file-mode twin: the same change has no red to show for it (fail), as in 01', async () => {
    const h = await harness({ 'src/a.css': 'a{}\n', 'src/money.ts': 'export const a = 1;\n' }, SUPPORTED, { fileMode: true });
    await h.ws.write('src/a.css', 'a{color:red}\n');
    expect(await observedRedGate.run(h.ctx, 'finish')).toMatchObject({ status: 'fail', summary: 'no observed red in this run' });
  });

  it('logic edited without a supported runner: UNPROVEN naming it; with one and no red: the red rule fails it (the twin)', async () => {
    const start = { 'src/money.ts': 'export const a = 1;\n' };
    const h = await harness(start, UNSUPPORTED);
    await h.ws.write('src/money.ts', 'export const a = 2;\n');
    expect(await observedRedGate.run(h.ctx, 'finish')).toMatchObject({ status: 'unproven', summary: 'no test proves src/money.ts; verify by hand' });
    const twin = await harness(start, SUPPORTED);
    await twin.ws.write('src/money.ts', 'export const a = 2;\n');
    expect(await observedRedGate.run(twin.ctx, 'finish')).toMatchObject({ status: 'fail' });
  });

  it('tests and test support are the proof, never unproven edits; a deleted file is an edit', async () => {
    const h = await harness({ 'test/helpers.ts': 'export {};\n', 'src/old.css': 'a{}\n' }, SUPPORTED);
    await h.ws.write('test/a.test.ts', "import { it } from 'vitest';\nit('x', () => {});\n");
    await h.ws.write('test/helpers.ts', 'export const two = 2;\n');
    const { rm } = await import('node:fs/promises');
    await rm(h.ws.resolve('src/old.css'));
    expect(await unprovenEdits(h.ctx)).toEqual([{ file: 'src/old.css', why: 'a stylesheet: no test can observe it' }]);
  });

  it('file mode lists no unproven edits at all', async () => {
    const h = await harness({ 'src/a.css': 'a{}\n' }, SUPPORTED, { fileMode: true });
    await h.ws.write('src/a.css', 'b{}\n');
    expect(await unprovenEdits(h.ctx)).toEqual([]);
  });
});

describe('withUnprovenEdits', () => {
  const edits = [{ file: 'src/a.css', why: 'a stylesheet: no test can observe it' }];
  it('turns a pass into UNPROVEN naming the files, keeps a failure failing with the files listed, and leaves a run without such edits alone', () => {
    expect(withUnprovenEdits({ status: 'pass', summary: '2 red observations' }, edits)).toMatchObject({ status: 'unproven', summary: `2 red observations; but ${unprovenLine(edits)}` });
    const failed = withUnprovenEdits({ status: 'fail', summary: 'x', details: ['src/m.ts: never red'] }, edits);
    expect(failed).toMatchObject({ status: 'fail', details: ['src/m.ts: never red', 'unproven: src/a.css: a stylesheet: no test can observe it'] });
    expect(withUnprovenEdits({ status: 'pass', summary: 'ok' }, [])).toEqual({ status: 'pass', summary: 'ok' });
    expect(unprovenLine([...edits, ...['b', 'c', 'd', 'e'].map((f) => ({ file: `${f}.md`, why: '' }))])).toBe('no test proves src/a.css, b.md, c.md, d.md and 1 more; verify by hand');
  });
});
