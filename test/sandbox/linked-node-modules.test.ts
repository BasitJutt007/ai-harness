/**
 * In place, node_modules may be a link to another checkout: a git worktree of the owner's repository whose
 * node_modules links to the main checkout's (the grader's real case), with the generated Prisma client
 * inside it. Confined test code must read through the link (the realpath of node_modules), both in the
 * checkout itself and in a revert-check copy, and the in-process TypeScript fence must see the same files;
 * nothing else of the other checkout becomes readable. Checked against the real mechanism.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { detectMechanism, readFence, setConfinedRoot } from '../../src/core/sandbox.ts';
import { computeTargetProfile } from '../../src/core/target.ts';
import { runTargetTests } from '../../src/core/testing.ts';
import { createTsFence } from '../../src/core/ts-fence.ts';
import type { LogStore } from '../../src/core/types.ts';

let base: string;
let main: string;
let wt: string;
let scratch: string;
const logs: LogStore = { write: async (name) => `(memory)/${name}` };

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'nm-link-')));
  main = join(base, 'main');
  wt = join(base, 'wt');
  scratch = join(base, 'scratch');
  mkdirSync(scratch);
  put(main, 'node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', main: 'index.js' }));
  put(main, 'node_modules/pkg/index.js', 'module.exports = 42;\n');
  put(main, 'node_modules/.prisma/client/index.js', 'module.exports = { client: "generated" };\n');
  put(main, 'secret.txt', 'the main checkout, outside node_modules\n');
  put(wt, 'package.json', JSON.stringify({ name: 'app', private: true, scripts: { test: 'node --test test/' } }));
  put(wt, 'src/db.cjs', "module.exports = require('.prisma/client');\n");
  put(wt, 'test/db.test.cjs', "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst db = require('../src/db.cjs');\ntest('client', () => assert.equal(db.client, 'generated'));\n");
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: wt });
  symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'), 'dir');
});
afterEach(() => {
  setConfinedRoot(null);
  rmSync(base, { recursive: true, force: true });
});

const READ = "const fs = require('node:fs'); const r = {}; for (const p of JSON.parse(process.argv[1])) { try { fs.readFileSync(p); r[p] = 'ok'; } catch (e) { r[p] = e.code; } } console.log(JSON.stringify(r));";

describe('a node_modules linked from another checkout, in place', () => {
  it('the read fence allows the realpath of node_modules (not the rest of the other checkout)', () => {
    setConfinedRoot(wt);
    const f = readFence(process.execPath, wt, [scratch]);
    expect(f.allow).toContain(join(main, 'node_modules'));
    expect(f.allow).not.toContain(main);
  });

  it.runIf(detectMechanism() !== 'none')('confined code reads packages and the Prisma client through the link, never the other checkout itself', async () => {
    setConfinedRoot(wt);
    const paths = [join(wt, 'node_modules', 'pkg', 'index.js'), join(wt, 'node_modules', '.prisma', 'client', 'index.js'), join(main, 'secret.txt')];
    const out = await exec(process.execPath, ['-e', READ, JSON.stringify(paths)], { cwd: wt, sandbox: { writable: [scratch], network: 'none' }, timeoutMs: 20_000 });
    const r = JSON.parse(out.stdout) as Record<string, string>;
    expect([r[paths[0] ?? ''], r[paths[1] ?? '']]).toEqual(['ok', 'ok']);
    expect(r[paths[2] ?? '']).not.toBe('ok');
  });

  it.runIf(detectMechanism() !== 'none')("the target's tests run confined in the checkout and load the generated client", async () => {
    setConfinedRoot(wt);
    const p = await computeTargetProfile({ apiRoot: wt, repoRoot: wt, harnessRoot: HARNESS_ROOT, inPlace: true });
    const report = await runTargetTests({ root: wt, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(report.observations.map((o) => [o.file, o.status])).toEqual([['test/db.test.cjs', 'pass']]);
  });

  it.runIf(detectMechanism() !== 'none')('a revert-check copy linked to the same node_modules reads it too', async () => {
    const copy = join(base, 'copy');
    put(copy, 'probe.txt', '');
    symlinkSync(realpathSync(join(wt, 'node_modules')), join(copy, 'node_modules'), 'dir');
    const out = await exec(process.execPath, ['-e', "console.log(require('pkg'), require('.prisma/client').client)"], { cwd: copy, sandbox: { writable: [scratch], network: 'none' }, timeoutMs: 20_000 });
    expect(out.stdout.trim()).toBe('42 generated');
  });

  it('the in-process TypeScript fence sees node_modules through the link, not the other checkout', () => {
    setConfinedRoot(wt);
    const fence = createTsFence(wt);
    expect(fence.allows('node_modules/pkg/index.js')).toBe(true);
    expect(fence.allows('node_modules/.prisma/client/index.js')).toBe(true);
    expect(fence.allows(join(main, 'secret.txt'))).toBe(false);
  });
});
