import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookPlugin, HookVerdict, RunContext, ToolCallInfo } from '../../src/core/plugin-api.ts';
import observedRed from '../../plugins/hooks/observed-red.ts';
import pathGuard from '../../plugins/hooks/path-guard.ts';
import secretGuard from '../../plugins/hooks/secret-guard.ts';
import unsafeGuard from '../../plugins/hooks/unsafe-code-guard.ts';
import editFile from '../../plugins/tools/edit_file.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import { brownfieldTask, callInfo, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(opts: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = await makeHarness({ label: 'hooks', ...opts });
  dirs.push(h.dir);
  return h;
}

function pre(hook: HookPlugin, call: ToolCallInfo, ctx: RunContext): Promise<HookVerdict> {
  return hook.run({ event: 'pre_tool', call }, ctx);
}

const write = (p: string, content = 'export const a = 1;\n'): ToolCallInfo => callInfo(writeFile, { path: p, content });

function reasonOf(v: HookVerdict): string {
  return v.decision === 'block' ? v.reason : '';
}

describe('path-guard', () => {
  it('blocks escapes, built-in denies and non-ts files', async () => {
    const { ctx } = await harness();
    for (const p of ['../x.ts', 'src/../../x.ts', '/etc/passwd.ts']) {
      expect((await pre(pathGuard, write(p), ctx)).decision, p).toBe('block');
    }
    for (const p of ['package.json', 'tsconfig.build.json', '.env', '.env.local', 'vitest.config.ts', 'types/x.d.ts', 'node_modules/a/b.ts', '.git/config', 'contract.lock.json']) {
      const v = await pre(pathGuard, write(p), ctx);
      expect(v.decision, p).toBe('block');
    }
    expect(reasonOf(await pre(pathGuard, write('README.md'), ctx))).toContain('not a .ts file');
    expect((await pre(pathGuard, write('src/routes/items.ts'), ctx)).decision).toBe('pass');
    expect((await pre(pathGuard, write('test/items.test.ts'), ctx)).decision).toBe('pass');
    expect((await pre(pathGuard, { ...write('src/a.ts'), paths: [] }, ctx)).decision).toBe('block');
  });

  it('blocks symlink escapes', async () => {
    const { ctx, ws, dir } = await harness();
    await symlink(path.join(dir, '..'), path.join(ws.root, 'link'));
    expect(reasonOf(await pre(pathGuard, write('link/evil.ts'), ctx))).toContain('escapes the API root');
  });

  it('denies the greenfield scaffold lib and server', async () => {
    const { ctx } = await harness();
    expect(reasonOf(await pre(pathGuard, write('src/lib/problem.ts'), ctx))).toContain('read-only scaffold');
    expect((await pre(pathGuard, write('src/server.ts'), ctx)).decision).toBe('block');
    expect(reasonOf(await pre(pathGuard, write('scripts/x.ts'), ctx))).toContain('outside the greenfield write scope');
  });

  it('applies brownfield scope allow/deny', async () => {
    const { ctx } = await harness({ task: brownfieldTask({ allow: ['src/**/*.ts', 'test/**/*.ts'], deny: ['src/legacy/**'] }) });
    expect((await pre(pathGuard, write('src/lib/util.ts'), ctx)).decision).toBe('pass');
    expect(reasonOf(await pre(pathGuard, write('src/legacy/old.ts'), ctx))).toContain('deny list');
    expect(reasonOf(await pre(pathGuard, write('scripts/x.ts'), ctx))).toContain('allow list');
  });
});

describe('observed-red hook', () => {
  it('blocks → red recorded → unlocked → test edited without rerun → locked again', async () => {
    const h = await harness({ files: { 'test/items.test.ts': "import { list } from '../src/items.js';\n// v1\n" } });
    const src = write('src/items.ts', 'export const list = () => [];\n');

    // No test run yet: blocked with an actionable reason.
    const v1 = await pre(observedRed, src, h.ctx);
    expect(v1.decision).toBe('block');
    expect(reasonOf(v1)).toContain('test/items.test.ts: never run');
    expect(reasonOf(v1)).toContain('run_tests { "files": ["test/items.test.ts"] }');

    // A passing run is not red.
    await h.services.runTests(['test/items.test.ts']);
    expect(reasonOf(await pre(observedRed, src, h.ctx))).toContain('no red observed (last run: pass)');

    // Observe red → unlocked.
    h.outcomes.set('test/items.test.ts', 'fail');
    await h.services.runTests(['test/items.test.ts']);
    expect((await pre(observedRed, src, h.ctx)).decision).toBe('pass');

    // Edit the test without re-running → locked again, with the exact next step.
    await h.ws.write('test/items.test.ts', "import { list } from '../src/items.js';\n// v2\n");
    const v3 = await pre(observedRed, src, h.ctx);
    expect(reasonOf(v3)).toContain('edited since last run');
    expect(reasonOf(v3)).toContain('re-run the edited test(s)');

    // Re-run (now passing): red was observed earlier and the latest run saw current content → unlocked.
    h.outcomes.set('test/items.test.ts', 'pass');
    await h.services.runTests(['test/items.test.ts']);
    expect((await pre(observedRed, src, h.ctx)).decision).toBe('pass');
  });

  it('explains when no test covers the file, and always allows tests and non-src files', async () => {
    const h = await harness();
    const v = await pre(observedRed, write('src/orphan.ts'), h.ctx);
    expect(reasonOf(v)).toContain('no test covers it');
    expect((await pre(observedRed, write('test/orphan.test.ts'), h.ctx)).decision).toBe('pass');
    expect((await pre(observedRed, write('src/orphan.test.ts'), h.ctx)).decision).toBe('pass');
  });
});

describe('unsafe-code-guard', () => {
  it('blocks any / x! / ts-ignore with locations', async () => {
    const { ctx } = await harness();
    const content = 'export function f(x: any) {\n  return x!.y;\n}\n// @ts-ignore\n';
    const reason = reasonOf(await pre(unsafeGuard, write('src/a.ts', content), ctx));
    expect(reason).toContain('src/a.ts:1:22');
    expect(reason).toContain('src/a.ts:2:11');
    expect(reason).toContain('src/a.ts:4:4');
  });

  it("allows 'company', != and non-ts files", async () => {
    const { ctx } = await harness();
    const ok = 'export const company = "acme";\nexport const diff = (x: number, y: number) => x != y;\n';
    expect((await pre(unsafeGuard, write('src/a.ts', ok), ctx)).decision).toBe('pass');
    expect((await pre(unsafeGuard, write('notes.md', 'x: any'), ctx)).decision).toBe('pass');
  });

  it('checks edit_file against the edited result and ignores pre-existing violations', async () => {
    const { ctx } = await harness({ files: { 'src/a.ts': 'let legacy: any = 1;\nexport const b = 2;\n' } });
    const fine = callInfo(editFile, { path: 'src/a.ts', find: 'b = 2', replace: 'b = 3' }, ctx.workspace);
    expect((await pre(unsafeGuard, fine, ctx)).decision).toBe('pass');
    const bad = callInfo(editFile, { path: 'src/a.ts', find: 'b = 2', replace: 'b = (legacy as any)' }, ctx.workspace);
    expect(reasonOf(await pre(unsafeGuard, bad, ctx))).toContain('src/a.ts:2:');
  });
});

describe('secret-guard', () => {
  it('blocks key-like content in writes and edits', async () => {
    const { ctx } = await harness({ files: { 'src/a.ts': 'export const k = "";\n' } });
    const key = 'AKIA' + 'Q'.repeat(16);
    const v = await pre(secretGuard, write('src/config.ts', `export const key = "${key}";\n`), ctx);
    expect(reasonOf(v)).toContain('src/config.ts:1  AWS access key id');
    expect(reasonOf(v)).not.toContain(key);
    const e = callInfo(editFile, { path: 'src/a.ts', find: '""', replace: `"${'ghp_' + 'z'.repeat(36)}"` }, ctx.workspace);
    expect((await pre(secretGuard, e, ctx)).decision).toBe('block');
    expect((await pre(secretGuard, write('src/ok.ts', 'export const k = process.env.KEY;\n'), ctx)).decision).toBe('pass');
  });
});
