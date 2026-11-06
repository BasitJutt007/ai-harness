/**
 * Fail-closed audit: what a Measure script prints never leaves readMetric. In a session the script is
 * model-written, so its output must reach neither the model (the reason a reading failed is repeated
 * to it) nor a record that is committed and pushed (a reading is written to the item ledger). Each
 * mutation is a script that tries to get a marker out through one path; the marker must appear in no
 * failure reason and in no reading. The baseline (a script that prints a number) reads it, with an
 * empty excerpt. A mutation whose marker comes out is a leak: fix readMetric, never this list.
 *
 *   npm run audit:mutations
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { readMetric } from '../../src/core/measure.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';

const MARKER = 'LEAK-MARKER-7f3a';
let base = '';
let repo = '';
let items = '';

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'measure-audit-')));
  repo = join(base, 'repo');
  items = join(base, 'items');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(items, 'metrics'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  // A secret committed by mistake: the script must not find it in the measure checkout.
  writeFileSync(join(repo, '.env'), `API_TOKEN=${MARKER}\n`);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function read(name: string, source: string): ReturnType<typeof readMetric> {
  writeFileSync(join(items, 'metrics', `${name}.mjs`), source);
  return readMetric({ harnessRoot: HARNESS_ROOT, itemsRoot: items, repoDir: repo, ref: 'HEAD', measure: { script: `metrics/${name}.mjs`, args: [], text: `node metrics/${name}.mjs` }, label: name });
}

const LEAKS: Array<{ name: string; source: string; ok: boolean }> = [
  { name: 'stdout-then-exit', source: `console.log('${MARKER}');\nprocess.exit(1);\n`, ok: false },
  { name: 'stderr-then-exit', source: `console.error('${MARKER}');\nprocess.exit(2);\n`, ok: false },
  { name: 'only-the-marker', source: `console.log('${MARKER}');\n`, ok: false },
  { name: 'marker-after-the-number', source: `console.log(3);\nconsole.log('${MARKER}');\n`, ok: false },
  { name: 'marker-in-a-json-value', source: `console.log(JSON.stringify({ metric: 'm', value: '${MARKER}' }));\n`, ok: false },
  { name: 'marker-and-a-moving-number', source: `console.log('${MARKER}');\nconsole.log(Math.floor(Math.random() * 1e9));\n`, ok: false },
  { name: 'a-flood-then-exit', source: `for (let i = 0; i < 2000; i += 1) console.log('${MARKER}');\nprocess.exit(3);\n`, ok: false },
  { name: 'an-uncaught-throw', source: `throw new Error('${MARKER}');\n`, ok: false },
  { name: 'marker-before-a-good-number', source: `console.log('${MARKER}');\nconsole.log(4);\n`, ok: true },
  { name: 'reads-the-committed-env', source: "import { existsSync, readFileSync } from 'node:fs';\nconsole.log(existsSync('.env') ? readFileSync('.env', 'utf8') : '');\nconsole.log(existsSync('.env') ? 1 : 0);\n", ok: true },
];

describe.skipIf(detectMechanism() === 'none')('audit: a Measure\'s output never leaves readMetric', () => {
  it('a script that prints a number is read, with no output kept (the baseline)', async () => {
    const r = await read('baseline', 'console.log(2);\n');
    expect(r).toMatchObject({ ok: true, reading: { value: 2, excerpt: '' } });
  });

  for (const m of LEAKS) {
    it(`no leak: ${m.name}`, async () => {
      const r = await read(m.name, m.source);
      expect(r.ok).toBe(m.ok);
      expect(JSON.stringify(r)).not.toContain(MARKER);
      if (m.name === 'reads-the-committed-env' && r.ok) expect(r.reading.value).toBe(0);
    });
  }
});
