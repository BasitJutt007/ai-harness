/**
 * The deadlock a live session hit, end to end in a scripted SESSION with the real registry (every real hook
 * and gate), the real runner and real standards, on a small React + Vite TypeScript app with node:test
 * (through tsx) in the OS temp dir, outside the harness checkout.
 *
 * The bug is in a module-private function. The agent's test imports it, so the test fails to LOAD; a load
 * failure is no red for a file that existed at run start, and the fix (export plus the new body in one
 * write) is refused. The lock message names the way out; the export-only edit is allowed while the file is
 * locked; the test then fails on an assertion (the red); the fix goes in; the suite is green; finish; and
 * the verdict printed is the one the fresh gates gave: "Work completed", with observed-red's revert check
 * proving the flip against the run-start content WITH the export (the reverted copy loads and fails on the
 * assertion). The model hears every refusal and its reason, never decides the verdict.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { detectMechanism, isolationInfo } from '../../src/core/sandbox.ts';
import { WORK_COMPLETED } from '../../src/session/ui.ts';
import { calls, git, proposal, realRegistry, runScripted, text, type Ran, type WebRepo } from './helpers.ts';

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

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'pager-web', private: true, type: 'module', scripts: { build: 'vite build' }, dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^7.0.0', typescript: '^5.0.0' } }, null, 2)}\n`,
  'tsconfig.json': `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }, null, 2)}\n`,
  '.gitignore': 'node_modules\ndist\n',
  'index.html': '<!doctype html>\n<div id="app"></div>\n<script type="module" src="/src/main.ts"></script>\n',
  'src/main.ts': "import { loadMore } from './store/x/api';\n\nconst app = document.querySelector('#app');\nvoid loadMore({ items: [], next: null }, async () => ({ items: [], next: null })).then((p) => {\n  if (app !== null) app.textContent = String(p.items.length);\n});\n",
  [API_FILE]: API,
  'test/load.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadMore } from '../src/store/x/api';\n\ntest('the last page loads nothing more', async () => {\n  const last = { items: ['a'], next: null };\n  assert.equal(await loadMore(last, async () => ({ items: ['x'], next: null })), last);\n});\n",
  'README.md': '# pager-web\n',
};

const TEST_FILE = 'test/merge.test.ts';
const MERGE_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendPage } from '../src/store/x/api';",
  '',
  "test('appending a page keeps the items already loaded', () => {",
  "  assert.deepEqual(appendPage({ items: ['a'], next: 'c2' }, { items: ['b'], next: null }).items, ['a', 'b']);",
  '});',
  '',
].join('\n');

let r: WebRepo;
let ran: Ran;
/** Everything the model was sent, as one string (tool results and refusals included). */
let sent = '';

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'export-red-session-')));
  const repo = join(base, 'pager-web');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Ada Owner');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'branch', 'development');
  git(repo, 'switch', '-q', '-c', 'fix/page-merge');
  // Its own tsc and Vite, as installed for the owner: the harness's node_modules (git-ignored).
  symlinkSync(join(HARNESS_ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
  r = { base, repo, home, env: { ...process.env, SF_HARNESS_HOME: home, NO_COLOR: '1' }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  const steps = [
    calls(['propose_contract', proposal({
      slug: 'page-merge',
      problem: 'Loading more pages drops the items already shown: appendPage in src/store/x/api.ts keeps only the new page.',
      scenarios: [{ when: 'a second page is appended to a first one', then: 'the items of both pages are kept, in order' }],
      commit: 'fix(store): keep the loaded items when a page is appended',
    })]),
    calls(['write_file', { path: TEST_FILE, content: MERGE_TEST }]),
    calls(['run_tests', { files: [TEST_FILE] }]),
    // The fix and the export in one write: refused (locked, and not export-only).
    calls(['write_file', { path: API_FILE, content: API.replace('function appendPage', 'export function appendPage').replace(BUG, FIX) }]),
    calls(['edit_file', { path: API_FILE, find: 'function appendPage', replace: 'export function appendPage' }]),
    calls(['run_tests', { files: [TEST_FILE] }]),
    calls(['edit_file', { path: API_FILE, find: BUG, replace: FIX }]),
    calls(['run_tests', {}]),
    calls(['finish', { summary: 'appendPage keeps the items already loaded; test/merge.test.ts went red on an assertion, then green with the whole suite.' }]),
    text('Done.'),
  ];
  ran = await runScripted(r, steps, ['loading more pages drops the items already shown, fix it', 'yes'], { registry: await realRegistry() });
  sent = JSON.stringify(ran.driver.requests.map((q) => q.messages));
}, 600_000);

afterAll(() => {
  if (process.env['KEEP_DEMO'] === undefined) r?.cleanup();
});

describe.skipIf(detectMechanism() === 'none' && isolationInfo().mode === 'auto')('a test that imports a module-private function, in a session', () => {
  it('the test fails to load; run_tests shows the model the load error and the export way out', () => {
    expect(sent).toContain("ERROR test/merge.test.ts: suite error: SyntaxError: The requested module '../src/store/x/api' does not provide an export named 'appendPage'");
    expect(sent).toContain("test/merge.test.ts failed to load: the module '../src/store/x/api' it imports does not export appendPage.");
  });

  it('the fix in one write is refused with the lock message naming the export way out; the export-only edit is allowed', () => {
    expect(sent).toContain(`test/merge.test.ts failed to load: it imports appendPage from ${API_FILE}, which declares appendPage but does not export it`);
    expect(sent).toContain(`Next: add \`export\` to the existing declaration of appendPage in ${API_FILE}. An export-only edit`);
    expect(sent).toContain('This write is not export-only: line 6');
    expect(sent).toContain(`observed-red: export-only edit of ${API_FILE} allowed while it is locked (exports appendPage; nothing else changed). It unlocks nothing`);
  });

  it('red on an assertion before the fix, then green', () => {
    expect(sent).toContain('observed red: test/merge.test.ts');
    expect(ran.out).toMatch(/✎ edit_file edited src\/store\/x\/api\.ts \(\+1 −1\)/);
    expect(ran.out).toMatch(/◆ finish accepted by the gates/);
  });

  it('every required gate, run fresh, is green: "Work completed"; observed-red proved the flip against the export-only base', () => {
    const kind = ran.runJson['lastVerdict'];
    expect(ran.out.includes(WORK_COMPLETED)).toBe(kind === 'DONE');
    expect(kind, ran.out.slice(ran.out.indexOf('gates  fresh run'))).toBe('DONE');
    // The verdict's own gate run (gates.json): the revert check ran against the run-start content plus the export.
    const gates = JSON.parse(readFileSync(join(ran.dir, 'gates.json'), 'utf8')) as { results: Array<{ gate: string; status: string; summary: string }> };
    const red = gates.results.find((g) => g.gate === 'observed-red');
    expect(red?.status).toBe('pass');
    expect(red?.summary).toContain('1 changed source files went red -> green (1 on unchanged cases, 0 on edited cases by differential proof)');
    expect(red?.summary).toContain(`the reverted copies kept the exports the run added (${API_FILE}: appendPage)`);
    expect(git(r.repo, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(git(r.repo, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort()).toEqual([`?? ${TEST_FILE}`, `M ${API_FILE}`]);
  });
});
