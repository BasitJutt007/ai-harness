/**
 * What counts as red, with the harness's REAL runner: any assertion API on a value from src/ counts
 * (vitest expect, vitest's chai assert, node:assert, assert(cond), an assertion helper imported from
 * test code, supertest's .expect), judged at the statement that failed. Constant-only assertions,
 * hand-thrown errors and a constant failure after a real assertion do not; the revert check stays the
 * final authority at finish.
 */
import { afterEach, describe, expect, it } from 'vitest';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import runTestsTool from '../../plugins/tools/run_tests.ts';
import writeFileTool from '../../plugins/tools/write_file.ts';
import { exec } from '../../src/core/exec.ts';
import { saveInitial } from '../../src/core/initial.ts';
import { createServices } from '../../src/core/services.ts';
import { brownfieldTask, callInfo, callTool, emptyRegistry, HARNESS_ROOT, makeHarness, removeTmp, sha } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'assertion-apis', type: 'module', private: true }),
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
  'src/users.ts': 'export function countUsers(): number {\n  return 0;\n}\n',
  'src/app.ts': [
    "import express from 'express';",
    "import { countUsers } from './users.ts';",
    'export function createApp() {',
    '  const app = express();',
    "  app.get('/users/count', (_req, res) => { res.status(200).json({ count: countUsers() }); });",
    '  return app;',
    '}',
    '',
  ].join('\n'),
  // A pure assertion helper: it imports nothing from src/.
  'test/expect-helpers.ts': "import { expect } from 'vitest';\nexport function expectCount(n: number, want: number): void {\n  expect(n).toBe(want);\n}\n",
};

const HEAD = [
  "import { assert as vassert, expect, it } from 'vitest';",
  "import assert from 'node:assert/strict';",
  "import request from 'supertest';",
  "import { createApp } from '../src/app.ts';",
  "import { countUsers } from '../src/users.ts';",
  "import { expectCount } from './expect-helpers.ts';",
  'void [vassert, assert, request, createApp, countUsers, expectCount, expect];',
].join('\n');

const COUNTS: Array<[string, string]> = [
  ['vitest-expect', 'expect(countUsers()).toBe(1);'],
  ['vitest-assert', 'vassert.equal(countUsers(), 1);'],
  ['node-assert', 'assert.equal(countUsers(), 1);'],
  ['assert-cond', 'assert(countUsers() === 1);'],
  ['imported-helper', 'expectCount(countUsers(), 1);'],
  ['helper-on-response', "const res = await request(createApp()).get('/users/count');\n  expectCount((res.body as { count: number }).count, 1);"],
  ['supertest-expect', "await request(createApp()).get('/users/count').expect(201);"],
];
const REJECTED: Array<[string, string]> = [
  ['constant-expect', 'countUsers();\n  expect(1).toBe(2);'],
  ['assert-fail', "countUsers();\n  assert.fail('red');"],
  ['throw-only', "countUsers();\n  throw new Error('red');"],
  ['constant-after-real', 'expect(countUsers()).toBe(0);\n  expect(1).toBe(2);'],
  ['constant-helper', 'countUsers();\n  expectCount(1, 2);'],
];

const testFile = (name: string, body: string): string => `${HEAD}\nit('${name}', async () => {\n  ${body}\n});\n`;

async function harness(extra: Record<string, string>) {
  const files = { ...BASE, ...extra };
  const h = await makeHarness({ label: 'assert-apis', task: brownfieldTask(), files, exec });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(BASE)) h.ctx.state.initialHashes.set(rel, sha(content));
  await saveInitial(h.ctx.run.runDir, new Map(Object.entries(BASE)));
  h.ctx.services = createServices({ ws: h.ws, registry: emptyRegistry(), state: h.ctx.state, logs: h.ctx.logs, exec, harnessRoot: HARNESS_ROOT, runDir: h.ctx.run.runDir });
  const latest = (file: string) => h.ctx.state.tests.filter((o) => o.file === file).at(-1);
  return { ...h, latest };
}

describe('red counting with the real runner: any assertion API', () => {
  it('counts a failing assertion on source in every style, and rejects constant / throw-only failures', async () => {
    const extra: Record<string, string> = {};
    for (const [name, body] of [...COUNTS, ...REJECTED]) extra[`test/${name}.test.ts`] = testFile(name, body);
    const h = await harness(extra);
    await callTool(runTestsTool, {}, h.ctx);
    for (const [name] of COUNTS) {
      const o = h.latest(`test/${name}.test.ts`);
      expect(o?.status, name).toBe('fail');
      expect(o?.validRed, `${name}: ${o?.reason ?? 'not run'}`).toBe(true);
    }
    for (const [name] of REJECTED) {
      const o = h.latest(`test/${name}.test.ts`);
      expect(o?.status, name).toBe('fail');
      expect(o?.validRed, `${name}: ${o?.reason ?? 'not run'}`).toBe(false);
      expect(o?.reason, name).toContain('red rejected: the failing cases only assert constants');
    }
  }, 120_000);

  it('a node:assert red unlocks the source, and red -> green passes the gate (revert check included)', async () => {
    const t = testFile('counts one', 'assert.equal(countUsers(), 1);');
    const h = await harness({ 'test/users.test.ts': t });
    await callTool(runTestsTool, { files: ['test/users.test.ts'] }, h.ctx);
    expect(h.latest('test/users.test.ts')?.validRed).toBe(true);
    const fixed = 'export function countUsers(): number {\n  return 1;\n}\n';
    const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: 'src/users.ts', content: fixed }) }, h.ctx);
    expect(v.decision).toBe('pass');
    await h.ws.write('src/users.ts', fixed);
    const g = await observedRedGate.run(h.ctx, 'finish');
    expect(g.status, JSON.stringify(g)).toBe('pass');
  }, 120_000);
});
