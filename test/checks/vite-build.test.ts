/**
 * vite-build inside the sandbox: browserslist walks up from each file for its config, through directories
 * the confined build may not read, so the harness reads the repository's own config itself and passes it as
 * BROWSERSLIST (which browserslist takes before any walk). The confined child gets exactly that value; with
 * no config anywhere in the repository, browserslist's own `defaults`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import viteBuild, { browserslistQueries, parseBrowserslistRc } from '../../plugins/checks/vite-build.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { confinedEnv } from '../../src/core/sandbox.ts';
import type { Exec, ExecOptions } from '../../src/core/plugin-api.ts';
import { memoryLogs } from './_ctx.ts';

const base = mkdtempSync(join(tmpdir(), 'vite-build-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const root = join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe("the repository's own browserslist config", () => {
  it('package.json "browserslist": a list, or its production entry', () => {
    expect(browserslistQueries(tree('pkg-list', { 'package.json': JSON.stringify({ browserslist: ['> 1%', 'not dead'] }) }))).toBe('> 1%, not dead');
    const perEnv = tree('pkg-env', { 'package.json': JSON.stringify({ browserslist: { production: ['last 2 chrome versions'], development: ['last 1 chrome version'] } }) });
    expect(browserslistQueries(perEnv)).toBe('last 2 chrome versions');
  });

  it('a .browserslistrc: its [production] section, comments ignored', () => {
    const text = '# targets\n> 0.5%\nnot dead\n\n[production]\nlast 2 versions\n[development]\nlast 1 chrome version\n';
    expect(parseBrowserslistRc(text)).toEqual(['last 2 versions']);
    expect(parseBrowserslistRc('> 1% # common\nIE 11\n')).toEqual(['> 1%', 'IE 11']);
    expect(browserslistQueries(tree('rc', { 'package.json': '{}', '.browserslistrc': 'chrome 120\n' }))).toBe('chrome 120');
  });

  it("a package of a monorepo finds the repository top's config, never one above the repository (the twin)", () => {
    const top = tree('mono', { 'package.json': JSON.stringify({ browserslist: 'firefox esr' }), 'packages/web/package.json': '{}' });
    const web = join(top, 'packages', 'web');
    expect(browserslistQueries(web, top)).toBe('firefox esr');
    expect(browserslistQueries(web)).toBe('defaults');
  });

  it("none at all: browserslist's own defaults", () => {
    expect(browserslistQueries(tree('none', { 'package.json': '{}' }))).toBe('defaults');
  });
});

describe('the confined vite build receives it', () => {
  it('passes BROWSERSLIST as a harness-set value of the sandbox policy, which the confined env keeps', async () => {
    const root = tree('build', {
      'package.json': JSON.stringify({ name: 'web', browserslist: ['safari 16'] }),
      'node_modules/vite/bin/vite.js': '',
    });
    const calls: ExecOptions[] = [];
    const fake: Exec = async (_cmd, _args, opts) => {
      calls.push(opts);
      return { code: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
    const ctx = await createCheckContext({ root, exec: fake, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    const findings = await viteBuild.run(ctx);
    expect(findings).toEqual([expect.objectContaining({ rule: 'vite-build', status: 'pass' })]);
    const sandbox = calls[0]?.sandbox;
    expect(sandbox).toMatchObject({ network: 'none', env: { BROWSERSLIST: 'safari 16' } });
    if (sandbox === undefined) throw new Error('the build ran unconfined');
    expect(confinedEnv({ BROWSERSLIST: 'from-the-operator' }, sandbox)['BROWSERSLIST']).toBe('safari 16');
    // the twin: the operator's own BROWSERSLIST never reaches a confined child
    expect(confinedEnv({ BROWSERSLIST: 'from-the-operator' }, { writable: sandbox.writable, network: 'none' })['BROWSERSLIST']).toBeUndefined();
  });
});
