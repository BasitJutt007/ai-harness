/**
 * The web layout of an in-place run (a session in any web repository, TargetLayout.codeKinds 'web'):
 * JavaScript and single-file components are code the harness traces and governs, JavaScript tests are
 * tests, and a red on a JavaScript module counts. Every widening has its TypeScript-layout twin (file
 * mode), which stays exactly as before.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isGovernedSource } from '../../plugins/lib/red.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { saveInitial } from '../../src/core/initial.ts';
import {
  computeTargetProfile,
  inPlaceProfile,
  isGovernedCodePath,
  isSourcePath,
  isTestPath,
  LEGACY_LAYOUT,
  setActiveLayout,
  suggestTestPath,
  type TargetLayout,
} from '../../src/core/target.ts';
import { missingSourceModule, runTargetTests } from '../../src/core/testing.ts';
import { buildTestMap, staticTestCases } from '../../src/core/testmap.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type { LogStore } from '../../src/core/types.ts';
import { scratch, writeTree } from './_variants.ts';

const tmp = scratch('web-layout');
afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };
const WEB: TargetLayout = { ...LEGACY_LAYOUT, codeKinds: 'web' };

describe('predicates: JavaScript and components are code in a web layout only', () => {
  it('a .test.js / .spec.jsx file is a test in a web layout; in the TypeScript layout it is not (the twin)', () => {
    for (const f of ['src/sum.test.js', 'src/Button.spec.jsx', 'test/x.test.mjs']) {
      expect(isTestPath(f, WEB), f).toBe(true);
      expect(isTestPath(f, LEGACY_LAYOUT), f).toBe(false);
    }
    expect(isTestPath('src/sum.test.ts', LEGACY_LAYOUT)).toBe(true);
  });

  it('JavaScript and .vue/.svelte under a source root are governed source in a web layout; never in the TypeScript layout', () => {
    for (const f of ['src/sum.js', 'src/Button.jsx', 'src/App.vue', 'src/routes/Page.svelte', 'src/x.cjs']) {
      expect(isSourcePath(f, WEB), f).toBe(true);
      expect(isGovernedCodePath(f, WEB), f).toBe(true);
      expect(isSourcePath(f, LEGACY_LAYOUT), f).toBe(false);
      expect(isGovernedCodePath(f, LEGACY_LAYOUT), f).toBe(false);
    }
    // declarations, styles and data are never governed code
    for (const f of ['src/env.d.ts', 'src/a.css', 'src/i18n/en.json']) expect(isGovernedCodePath(f, WEB), f).toBe(false);
    // the TypeScript layout is unchanged
    expect(isGovernedCodePath('src/money.ts', LEGACY_LAYOUT)).toBe(true);
    expect(isGovernedCodePath('src/App.tsx', LEGACY_LAYOUT)).toBe(true);
  });

  it("red.ts isGovernedSource follows the active layout", () => {
    setActiveLayout(WEB);
    try {
      expect(isGovernedSource('src/sum.js')).toBe(true);
    } finally {
      setActiveLayout(undefined);
    }
    expect(isGovernedSource('src/sum.js')).toBe(false);
  });

  it('a JavaScript source gets a JavaScript test suggestion in a web layout; TypeScript keeps .test.ts', () => {
    expect(suggestTestPath('src/sum.js', WEB)).toBe('test/sum.test.js');
    expect(suggestTestPath('src/Button.jsx', WEB)).toBe('test/Button.test.jsx');
    expect(suggestTestPath('src/money.ts', WEB)).toBe('test/money.test.ts');
    expect(suggestTestPath('src/sum.js', LEGACY_LAYOUT)).toMatch(/\.test\.ts$/);
  });
});

/** A JavaScript web app: node:test, src/ + test/ (with a helper), a component the tests import. */
const JS_APP = {
  'package.json': JSON.stringify({ name: 'js-web', private: true, type: 'module', scripts: { test: 'node --test test/' } }),
  'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n',
  'src/App.vue': '<template><p>{{ sum(1, 2) }}</p></template>\n<script setup>\nimport { sum } from "./sum.js";\n</script>\n',
  'test/helpers.js': 'export const two = 2;\n',
  'test/sum.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.js';\nimport { two } from './helpers.js';\ntest('adds', () => {\n  assert.equal(sum(1, 1), two + 1);\n});\n",
  'test/app.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport App from '../src/App.vue';\ntest('renders', () => {\n  assert.ok(App);\n});\n",
};

describe('a JavaScript repository in place', () => {
  it('the in-place profile learns the JavaScript test dir; the file-mode profile does not (the twin)', async () => {
    const root = join(tmp.dir, 'js-profile');
    writeTree(root, JS_APP);
    const web = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace: true });
    expect(web.codeKinds).toBe('web');
    expect(web.testSupportRoots).toEqual(['test']);
    expect(inPlaceProfile(web)).toBe(web);
    const file = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(file.codeKinds).toBeUndefined();
    expect(inPlaceProfile(file).codeKinds).toBe('web');
  });

  it('the test map covers .js sources and the components a test imports; the TypeScript layout sees no JavaScript test', async () => {
    const root = join(tmp.dir, 'js-map');
    writeTree(root, JS_APP);
    const ws = createWorkspace(root, '.');
    const web = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace: true });
    const map = await buildTestMap(ws, web);
    expect(map.testsFor('src/sum.js')).toEqual(['test/sum.test.js']);
    expect(map.testsFor('src/App.vue')).toEqual(['test/app.test.js']);
    expect(map.coverage['test/sum.test.js']).toEqual(['src/sum.js']); // the helper is test support, never covered
    const ts = await buildTestMap(ws, LEGACY_LAYOUT);
    expect(Object.keys(ts.coverage)).toEqual([]);
  });

  it('a missing module named by a JavaScript test is a missing .js source in a web layout; a TypeScript importer keeps .ts', () => {
    const root = join(tmp.dir, 'js-missing');
    writeTree(root, { 'src/keep.js': 'export {};\n' });
    const msg = (spec: string, from: string): string => `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${join(root, spec)}' imported from ${join(root, from)}`;
    expect(missingSourceModule(root, msg('src/total.js', 'test/total.test.js'), WEB)).toBe('src/total.js');
    expect(missingSourceModule(root, msg('src/total.js', 'test/total.test.ts'), WEB)).toBe('src/total.ts');
    // an existing JavaScript module is never "missing"
    expect(missingSourceModule(root, msg('src/keep.js', 'test/keep.test.js'), WEB)).toBeNull();
  });

  it('a JSX test is parsed as JSX: every case is found and asserts on the imported component', () => {
    const text = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { Button } from '../src/Button.jsx';\ntest('renders a label', () => {\n  const el = <Button label=\"Go\" />;\n  assert.equal(el.props.label, 'Go');\n});\ntest('second', () => {\n  assert.equal(Button.name, 'Button');\n});\n";
    const cases = staticTestCases('test/button.test.jsx', text, { resolve: (s) => (s.startsWith('..') ? 'src/Button.jsx' : null), reachesSource: () => true });
    expect(cases.map((c) => c.name)).toEqual(['renders a label', 'second']);
    expect(cases.every((c) => c.exercisesSource)).toBe(true);
  });

  it('runs node:test on the JavaScript tests and a failing assertion on a .js module is a valid red', async () => {
    const root = join(tmp.dir, 'js-run');
    writeTree(root, { ...JS_APP, 'test/app.test.js': "import { test } from 'node:test';\ntest('noop', () => {});\n" });
    const web = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT, inPlace: true });
    expect(web.runner).toMatchObject({ kind: 'node-test', supported: true });
    const report = await runTargetTests({ root, files: ['test/sum.test.js'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: web.runner, layout: web });
    const obs = report.observations.find((o) => o.file === 'test/sum.test.js');
    expect(obs).toMatchObject({ status: 'fail', validRed: true });
    expect(obs?.cases?.[0]).toMatchObject({ name: 'adds', status: 'fail', exercisesSource: true });
  });
});

describe('the run-start snapshot keeps every governable kind', () => {
  it('stores .tsx, .js, .jsx, .vue and .svelte blobs next to .ts (the revert check needs them); styles and data are not code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initial-kinds-'));
    try {
      const files = new Map([['src/a.ts', 'a'], ['src/B.tsx', 'b'], ['src/c.js', 'c'], ['src/D.jsx', 'd'], ['src/E.vue', 'e'], ['src/F.svelte', 'f'], ['src/g.css', 'g'], ['src/h.json', 'h']]);
      await saveInitial(dir, files);
      expect(readdirSync(join(dir, 'initial')).length).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
