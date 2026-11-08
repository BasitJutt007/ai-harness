/**
 * Measured files: a file the task declares the item's Measure probes (a screen no unit test can load).
 * - The red lock opens it only in a run bound to an item whose proposal recorded a before value.
 * - observed-red leaves a changed measured file to item-metric (it still had to pass the hook).
 * - item-metric proves each changed measured file by reverting it ALONE: the reading must change; a
 *   measured file whose own change moves nothing fails, and the file is restored either way.
 * Paired: every pass has the fail it must not become.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import itemMetric from '../../plugins/gates/item-metric.ts';
import observedRed from '../../plugins/gates/observed-red.ts';
import { lockState, MEASURED_BY, recordUnlocked } from '../../plugins/lib/red.ts';
import { exec } from '../../src/core/exec.ts';
import { parseContract, proposeItem, recordReply } from '../../src/core/items.ts';
import type { MetricReading } from '../../src/core/items.ts';
import { newRunState } from '../../src/core/run-store.ts';
import { normalizeTask } from '../../src/core/task.ts';
import type { BrownfieldTask, RunContext } from '../../src/core/types.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { contractFor, writeContract } from '../support/items.ts';

const SLUG = 'measured-screen';
/** The Measure: counts the defects a screen still has (each "BUG" marker in src/screen.tsx and src/helper.ts). */
const SCRIPT = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');",
  "console.log((read('src/screen.tsx') + read('src/helper.ts')).split('BUG').length - 1);",
  '',
].join('\n');
const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let dir: string;
let harness: string;
let items: string;
let repo: string;

function task(measured: string[] | undefined): BrownfieldTask {
  return {
    kind: 'brownfield', id: SLUG, title: 't', target: '.', change: 'c', behaviours: [],
    scope: { allow: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts'], deny: [] }, allowBreaking: false, standards: 'baseline',
    ...(measured === undefined ? {} : { measured }),
  } as unknown as BrownfieldTask;
}

function before(value: number): MetricReading {
  return { value, sha: 'a'.repeat(40), ref: 'origin/main', command: 'node metrics/screen.mjs', scriptSha256: sha(SCRIPT), stdoutSha256: '', excerpt: String(value), confinement: 'test' };
}

/** A repo whose screen has 2 BUG markers at the base commit; an item proposed with the given before value. */
function setup(opts: { measured?: string[]; before?: MetricReading | null; bound?: boolean } = {}): RunContext {
  const contract = contractFor(SLUG, { Measure: 'node metrics/screen.mjs' });
  writeContract(items, SLUG, contract);
  proposeItem(items, SLUG, { session: 't', before: opts.before === undefined ? before(2) : opts.before });
  recordReply(items, SLUG, 'yes', 'tty', 't');
  const state = newRunState();
  for (const f of ['src/screen.tsx']) state.initialHashes.set(f, sha(readFileSync(join(repo, f), 'utf8')));
  return {
    run: { id: 'r', harnessRoot: harness, baseSha: git(repo, 'rev-parse', 'HEAD') },
    task: task(opts.measured ?? ['src/screen.tsx']),
    ...(opts.bound === false ? {} : { item: { slug: SLUG, root: items, contractHash: parseContract(contract).hash } }),
    workspace: createWorkspace(repo, '.'),
    state,
    exec,
    services: { testMap: async () => ({ testsFor: () => [] }), runTests: async () => ({ observations: [] }) },
  } as unknown as RunContext;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'measured-'));
  harness = join(dir, 'harness');
  items = join(dir, 'items-root');
  repo = join(dir, 'repo');
  for (const d of [join(harness, 'metrics'), items, join(repo, 'src')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(harness, 'metrics', 'screen.mjs'), SCRIPT);
  writeFileSync(join(repo, 'src', 'screen.tsx'), 'export const a = "BUG";\nexport const b = "BUG";\n');
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the red lock and measured files', () => {
  it('opens a measured file in a run bound to an item with a before value', async () => {
    const lock = await lockState(setup(), 'src/screen.tsx');
    expect(lock).toMatchObject({ unlocked: true, unlockedBy: [MEASURED_BY] });
  });

  it('keeps it locked without an item, without a before value, or when the task does not declare it', async () => {
    expect((await lockState(setup({ bound: false }), 'src/screen.tsx')).unlocked).toBe(false);
    expect((await lockState(setup({ before: null }), 'src/screen.tsx')).unlocked).toBe(false);
    expect((await lockState(setup({ measured: ['src/other.tsx'] }), 'src/screen.tsx')).unlocked).toBe(false);
  });
});

describe('observed-red leaves measured files to item-metric', () => {
  it('passes a change made only to measured files that went through the hook', async () => {
    const ctx = setup();
    writeFileSync(join(repo, 'src', 'screen.tsx'), 'export const a = 1;\n');
    recordUnlocked(ctx.state, 'src/screen.tsx');
    const r = await observedRed.run(ctx, 'finish');
    expect(r.status).toBe('pass');
    expect(r.summary).toMatch(/left to item-metric \(src\/screen\.tsx\)/);
  });

  it('fails a measured file changed behind the hook, and treats an undeclared one like any source file', async () => {
    const sneaked = setup();
    writeFileSync(join(repo, 'src', 'screen.tsx'), 'export const a = 1;\n');
    expect((await observedRed.run(sneaked, 'finish')).status).toBe('fail');
    const undeclared = setup({ measured: ['src/other.tsx'] });
    recordUnlocked(undeclared.state, 'src/screen.tsx');
    const r = await observedRed.run(undeclared, 'finish');
    expect(r.status).toBe('fail');
    expect(r.summary).toBe('no observed red in this run');
  });
});

describe('item-metric proves each changed measured file by its own revert', () => {
  it('passes when reverting the measured file alone moves the metric back, and restores the file', async () => {
    const ctx = setup();
    const fixed = 'export const a = "fixed";\nexport const b = "fixed";\n';
    writeFileSync(join(repo, 'src', 'screen.tsx'), fixed);
    const r = await itemMetric.run(ctx, 'finish');
    expect(r.status).toBe('pass');
    expect(r.summary).toMatch(/before 2 .*this run's tree 0.*moves it back when reverted alone \(src\/screen\.tsx\)/);
    expect(readFileSync(join(repo, 'src', 'screen.tsx'), 'utf8')).toBe(fixed);
  }, 30_000);

  it("fails a measured file whose own change moves nothing (the metric moved through another file)", async () => {
    const ctx = setup({ before: before(3) });
    // The base reads 2 here, the proposal said 3: a helper file holds the third BUG at proposal time in this story.
    const cosmetic = 'export const a = "BUG";\nexport const b = "BUG"; // reworded\n';
    writeFileSync(join(repo, 'src', 'screen.tsx'), cosmetic);
    const r = await itemMetric.run(ctx, 'finish');
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toMatch(/src\/screen\.tsx: with this file alone at its run-start content the metric still reads 2: its own change moves nothing/);
    expect(readFileSync(join(repo, 'src', 'screen.tsx'), 'utf8')).toBe(cosmetic);
  }, 30_000);

  it('fails, as before, when the metric did not move at all', async () => {
    const r = await itemMetric.run(setup(), 'finish');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/did not move/);
  }, 30_000);
});

describe('the task field', () => {
  it('a brownfield task accepts measured (a single glob becomes a list); a greenfield task carries it with a note', () => {
    const bf = normalizeTask({ kind: 'brownfield', id: 'm', title: 'm', target: '.', change: 'c', measured: 'src/screen.tsx' });
    expect(bf.task.kind === 'brownfield' && bf.task.measured).toEqual(['src/screen.tsx']);
    const gf = normalizeTask({ kind: 'greenfield', id: 'g', title: 'g', brief: 'b', measured: ['src/x.tsx'] });
    expect(gf.warnings.join('\n')).toMatch(/"measured" has no effect on a greenfield task/);
  });
});
