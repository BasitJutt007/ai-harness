/**
 * The Measure script lives in metrics/ under the ITEMS ROOT, so a session can keep metrics/<slug>.mjs
 * in its state directory outside the harness repo. In file mode the items root is the harness root,
 * and a test items root without its own script still finds the harness's (the file-mode location).
 * Every existing rule stays: the script must lie inside metrics/ of the root it is read from.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMeasure } from '../../src/core/items.ts';
import { measureScriptPath, readMetric } from '../../src/core/measure.ts';

let base: string;
let harness: string;
let items: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'measure-root-')));
  harness = join(base, 'harness');
  items = join(base, 'state');
  repo = join(base, 'repo');
  mkdirSync(join(harness, 'metrics'), { recursive: true });
  mkdirSync(join(items, 'metrics'), { recursive: true });
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'count.txt'), '7\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const COUNT = "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('count.txt', 'utf8').trim());\n";

function spec(text: string) {
  const m = parseMeasure(text);
  if ('error' in m) throw new Error(m.error);
  return m;
}

describe('measureScriptPath', () => {
  it('reads metrics/ under the items root first', () => {
    writeFileSync(join(items, 'metrics', 'count.mjs'), COUNT);
    writeFileSync(join(harness, 'metrics', 'count.mjs'), 'console.log(0)\n');
    expect(measureScriptPath('metrics/count.mjs', [items, harness])).toEqual({ ok: true, path: join(items, 'metrics', 'count.mjs') });
  });

  it('falls back to the harness metrics/ when the items root has no such script (file mode with a separate items root)', () => {
    writeFileSync(join(harness, 'metrics', 'count.mjs'), COUNT);
    expect(measureScriptPath('metrics/count.mjs', [items, harness])).toEqual({ ok: true, path: join(harness, 'metrics', 'count.mjs') });
  });

  it('a script under neither root is no reading, and the reason names the items root', () => {
    const r = measureScriptPath('metrics/none.mjs', [items, harness]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(`Measure script metrics/none.mjs does not exist in metrics/ under the items root (${items}) or the harness`);
  });

  it('file mode (one root) keeps its wording', () => {
    const r = measureScriptPath('metrics/none.mjs', [harness, harness]);
    if (!r.ok) expect(r.reason).toBe('Measure script metrics/none.mjs does not exist in the harness');
    else throw new Error('expected a refusal');
  });

  it('a path that leaves metrics/ is refused even when the file exists (the bypass), whatever the root', () => {
    writeFileSync(join(items, 'outside.mjs'), COUNT);
    for (const s of ['metrics/../outside.mjs', 'outside.mjs', '../state/outside.mjs']) {
      const r = measureScriptPath(s, [items, harness]);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/is outside metrics\//);
    }
    // the contract parser refuses these spellings before any of this runs
    expect(parseMeasure('node metrics/../outside.mjs')).toHaveProperty('error');
  });
});

describe('readMetric with an items root', () => {
  it("runs the session's own metrics/<slug>.mjs from the items root", async () => {
    writeFileSync(join(items, 'metrics', 'count.mjs'), COUNT);
    const r = await readMetric({ harnessRoot: harness, itemsRoot: items, repoDir: repo, ref: 'HEAD', measure: spec('node metrics/count.mjs'), label: 'count' });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (r.ok) expect(r.reading.value).toBe(7);
  });

  it('without an items root it reads the harness metrics/ as before', async () => {
    writeFileSync(join(items, 'metrics', 'count.mjs'), COUNT);
    const r = await readMetric({ harnessRoot: harness, repoDir: repo, ref: 'HEAD', measure: spec('node metrics/count.mjs'), label: 'count' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Measure script metrics/count.mjs does not exist in the harness');
  });
});
