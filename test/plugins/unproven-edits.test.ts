/**
 * unprovenEdits (plugins/lib/proof.ts) reads only what the run changed: git's answer for the owner's checkout
 * (files that differ from the base commit, untracked files git does not ignore), never every git-visible file;
 * the whole checkout is looked at only when git cannot answer (the twin). A changed binary or huge file is not
 * read as text: it is named with that note and the rest of the gate still runs, so it is never green and never
 * "could not inspect changes" for the whole gate.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import { MAX_TEXT_BYTES, unprovenEdits } from '../../plugins/lib/proof.ts';
import type { RunContext, RunnerSummary, Workspace } from '../../src/core/plugin-api.ts';
import { brownfieldTask, makeHarness, realExec, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const SUPPORTED: RunnerSummary = { kind: 'vitest', name: 'vitest 5.0.3', supported: true };
const BIG = `${'x'.repeat(MAX_TEXT_BYTES + 1024)}\n`;

/** An in-place harness over a real git repository (the API root is its top), committed, with run-start hashes. */
async function gitHarness(files: Record<string, string>, opts: { repoTop?: string } = {}) {
  const h = await makeHarness({ label: 'unproven-edits', task: brownfieldTask(), rootRel: '', files, exec: realExec });
  dirs.push(h.dir);
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: h.dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'feat/x');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  for (const [rel, content] of Object.entries(files)) h.ctx.state.initialHashes.set(rel, sha(content));
  const ctx: RunContext = { ...h.ctx, inPlace: { repoTop: opts.repoTop ?? h.dir, branch: 'feat/x' }, runner: SUPPORTED };
  return { ...h, ctx, git };
}

/** The workspace with its whole-checkout listing counted (git's answer must make it unnecessary). */
function countingLists(ws: Workspace): { ws: Workspace; lists: () => number } {
  let n = 0;
  return { ws: { ...ws, list: async (p: string[]) => { n += 1; return ws.list(p); } }, lists: () => n };
}

describe('unprovenEdits reads only the changed files', () => {
  it("git's answer: only the changed stylesheet is named; the unchanged huge file and the binary are never listed or read", async () => {
    const h = await gitHarness({ 'src/a.css': 'a{}\n', 'data/huge.json': BIG, 'public/logo.png': '\u0089PNG\u0000\u0001', 'src/money.ts': 'export const a = 1;\n' });
    await h.ws.write('src/a.css', 'a{color:red}\n');
    const counted = countingLists(h.ws);
    expect(await unprovenEdits({ ...h.ctx, workspace: counted.ws })).toEqual([{ file: 'src/a.css', why: 'a stylesheet: no test can observe it' }]);
    expect(counted.lists()).toBe(0);
  });

  it('the twin: where git cannot answer (the in-place top is not a repository top) every visible file is compared, with the same answer', async () => {
    const h = await gitHarness({ 'src/a.css': 'a{}\n', 'src/money.ts': 'export const a = 1;\n' }, { repoTop: '/no/such/repository' });
    await h.ws.write('src/a.css', 'a{color:red}\n');
    const counted = countingLists(h.ws);
    expect(await unprovenEdits({ ...h.ctx, workspace: counted.ws })).toEqual([{ file: 'src/a.css', why: 'a stylesheet: no test can observe it' }]);
    expect(counted.lists()).toBe(1);
  });

  it('new untracked files and deleted files are changes; a file written and changed back is not', async () => {
    const h = await gitHarness({ 'src/old.css': 'a{}\n', 'src/same.md': '# same\n' });
    await h.ws.write('docs/new.md', '# new\n');
    const { rm } = await import('node:fs/promises');
    await rm(h.ws.resolve('src/old.css'));
    await h.ws.write('src/same.md', '# same\n');
    h.ctx.state.written.add('src/same.md');
    expect((await unprovenEdits(h.ctx)).map((e) => e.file)).toEqual(['docs/new.md', 'src/old.css']);
  });

  it('a git-ignored change is not an edit of the run (the listing never showed it either)', async () => {
    const h = await gitHarness({ '.gitignore': 'tmp/\n', 'src/a.css': 'a{}\n' });
    await h.ws.write('tmp/scratch.md', 'x\n');
    expect(await unprovenEdits(h.ctx)).toEqual([]);
  });
});

describe('a changed binary or huge file is named with a note, never read as text', () => {
  it('names each, with why, and the gate still runs to its own verdict (UNPROVEN naming them, not "could not inspect changes")', async () => {
    const h = await gitHarness({ 'public/logo.png': '\u0089PNG\u0000\u0001', 'data/huge.json': 'small\n' });
    await h.ws.write('public/logo.png', '\u0089PNG\u0000\u0002');
    await h.ws.write('data/huge.json', BIG);
    const edits = await unprovenEdits(h.ctx);
    expect(edits).toEqual([
      { file: 'data/huge.json', why: expect.stringMatching(/^a file of 2\.0 MB \(over 2 MB\), not read: no test can observe it$/) },
      { file: 'public/logo.png', why: 'a binary file, not read: no test can observe it' },
    ]);
    const r = await observedRedGate.run(h.ctx, 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toBe('no test proves data/huge.json, public/logo.png; verify by hand');
  });

  it('an unchanged binary is not an edit (the twin): it hashes as the run-start snapshot did', async () => {
    const h = await gitHarness({ 'public/logo.png': '\u0089PNG\u0000\u0001', 'src/a.css': 'a{}\n' });
    h.ctx.state.written.add('public/logo.png');
    expect(await unprovenEdits(h.ctx)).toEqual([]);
  });

  it('a changed file that cannot be read is named, never taken as unchanged', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const h = await gitHarness({ 'src/a.css': 'a{}\n' });
    await h.ws.write('src/a.css', 'a{color:red}\n');
    chmodSync(h.ws.resolve('src/a.css'), 0o000);
    try {
      expect(await unprovenEdits(h.ctx)).toEqual([{ file: 'src/a.css', why: expect.stringMatching(/^could not be read \(.*EACCES.*\): no test can observe it$/) }]);
    } finally {
      chmodSync(h.ws.resolve('src/a.css'), 0o644);
    }
  });
});
