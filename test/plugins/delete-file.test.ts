/**
 * delete_file: the model may remove what IT created in this run (a scratch helper, an abandoned
 * module) and nothing else. Like every write it passes the pre_tool hooks first.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import observedRed from '../../plugins/hooks/observed-red.ts';
import pathGuard from '../../plugins/hooks/path-guard.ts';
import testPreservation from '../../plugins/hooks/test-preservation.ts';
import deleteFile from '../../plugins/tools/delete_file.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import type { HookPlugin, RunContext } from '../../src/core/plugin-api.ts';
import { brownfieldTask, callInfo, callTool, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const EXISTING = { 'src/app.ts': 'export const app = 1;\n', 'test/app.test.ts': "import { app } from '../src/app.ts';\n", 'test/helpers.ts': 'export const h = 1;\n' };

async function harness() {
  const h = await makeHarness({ label: 'delete', task: brownfieldTask(), files: EXISTING });
  dirs.push(h.dir);
  for (const [rel, content] of Object.entries(EXISTING)) h.ctx.state.initialHashes.set(rel, sha(content));
  return h;
}

/** Pre hooks in registry order; the first block wins (as the loop runs them). */
async function firstBlock(p: string, ctx: RunContext): Promise<string | null> {
  const hooks: HookPlugin[] = [observedRed, pathGuard, testPreservation];
  const call = callInfo(deleteFile, { path: p });
  for (const hook of hooks) {
    const v = await hook.run({ event: 'pre_tool', call }, ctx);
    if (v.decision === 'block') return hook.name;
  }
  return null;
}

describe('delete_file', () => {
  it('deletes a file this run created, and reports the removed lines', async () => {
    const h = await harness();
    for (const p of ['test/scratch.ts', 'src/abandoned.ts', 'test/explore.test.ts']) {
      expect((await callTool(writeFile, { path: p, content: 'export const x = 1;\nexport const y = 2;\n' }, h.ctx)).ok).toBe(true);
      expect(await firstBlock(p, h.ctx), p).toBeNull(); // no red needed to undo the run's own file
      const r = await callTool(deleteFile, { path: p }, h.ctx);
      expect(r.ok, r.summary).toBe(true);
      expect(r.summary).toBe(`deleted ${p} (−2 lines)`);
      expect(r.raw).toContain('+++ /dev/null');
      expect(existsSync(path.join(h.ctx.workspace.root, p))).toBe(false);
    }
  });

  it('refuses files that existed at run start, files the run did not write, and paths outside the API root', async () => {
    const h = await harness();
    for (const p of Object.keys(EXISTING)) {
      const r = await callTool(deleteFile, { path: p }, h.ctx);
      expect(r.ok, p).toBe(false);
      expect(r.summary).toContain('existed when the run started');
      expect(existsSync(path.join(h.ctx.workspace.root, p))).toBe(true);
    }
    // Created some other way (e.g. by test code at run time): not the run's own write.
    await h.ctx.workspace.write('src/generated.ts', 'export {};\n');
    expect((await callTool(deleteFile, { path: 'src/generated.ts' }, h.ctx)).summary).toContain('was not created by this run');
    for (const p of ['../outside.ts', '/etc/hosts', 'src/missing.ts']) expect((await callTool(deleteFile, { path: p }, h.ctx)).ok, p).toBe(false);
  });

  it('goes through the pre_tool hooks: path-guard, and the red lock / test preservation for files that existed', async () => {
    const h = await harness();
    expect(await firstBlock('src/app.ts', h.ctx)).toBe('observed-red');
    expect(await firstBlock('test/app.test.ts', h.ctx)).toBe('test-preservation');
    expect(await firstBlock('test/helpers.ts', h.ctx)).toBe('test-preservation');
    expect(await firstBlock('package.json', h.ctx)).toBe('path-guard');
    expect(await firstBlock('../x.ts', h.ctx)).toBe('path-guard');
  });
});
