/**
 * A workspace over the owner's real checkout (visibility 'git', opt-in) shows the read tools only
 * git-visible files: tracked, or untracked and not ignored (so a file the agent creates appears).
 * `.env*` is refused even when tracked, `.git` always, ignored paths always, each with its reason.
 * The file-mode twin (default visibility, a run's own worktree) lists and reads as before.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import listFiles from '../../plugins/tools/list_files.ts';
import outline from '../../plugins/tools/outline.ts';
import readFile from '../../plugins/tools/read_file.ts';
import searchCode from '../../plugins/tools/search_code.ts';
import { frontLoad } from '../../src/core/prompt.ts';
import { createWorkspace, gitHiddenReason, isEnvPath, isGitPath } from '../../src/core/workspace.ts';
import type { RunContext, Workspace } from '../../src/core/types.ts';
import { fakeCtx } from '../core-loop/fakes.ts';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function put(rel: string, content: string): void {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

beforeEach(() => {
  repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'ws-visibility-'))), 'app');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  put('.gitignore', 'dist/\nnode_modules/\n*.log\n.env.local\nbuild/\n');
  put('src/a.ts', "export const token = 'TOKEN_IN_SOURCE';\n");
  put('.env', 'API_KEY=TOKEN_IN_ENV\n'); // committed by mistake: still never shown
  put('config/.ENV.prod', 'X=TOKEN_IN_ENV\n');
  put('src/gone.ts', 'export {};\n');
  git('add', '.');
  put('build/keep.txt', 'tracked though ignored\n');
  git('add', '-f', 'build/keep.txt');
  git('commit', '-q', '-m', 'init');
  // After the commit: an untracked file (an agent's new file), ignored output and secrets, a deletion.
  put('src/new.ts', "export const fresh = 'TOKEN_IN_SOURCE';\n");
  put('dist/out.js', 'built\n');
  put('node_modules/pkg/index.js', 'module.exports = 1;\n');
  put('debug.log', 'TOKEN_IN_LOG\n');
  put('.env.local', 'API_KEY=TOKEN_IN_ENV\n');
  unlinkSync(join(repo, 'src/gone.ts'));
});
afterEach(() => rmSync(join(repo, '..'), { recursive: true, force: true }));

function ctxFor(ws: Workspace): RunContext {
  const { ctx } = fakeCtx();
  return { ...ctx, workspace: ws };
}

describe("visibility 'git': what the workspace lists", () => {
  it('lists only git-visible files: tracked (even if they match an ignore rule) and untracked-not-ignored; never .env*, never deleted', async () => {
    const ws = createWorkspace(repo, '.', { visibility: 'git' });
    expect(ws.visibility).toBe('git');
    expect(await ws.list(['**/*'])).toEqual(['.gitignore', 'build/keep.txt', 'src/a.ts', 'src/new.ts']);
    expect(await ws.list(['src/**/*.ts'])).toEqual(['src/a.ts', 'src/new.ts']);
  });

  it('file-mode twin: the default workspace lists every file as before (and has no hidden())', async () => {
    const ws = createWorkspace(repo, '.');
    expect(ws.visibility).toBeUndefined();
    expect(ws.hidden).toBeUndefined();
    const all = await ws.list(['**/*']);
    for (const f of ['.env', '.env.local', 'debug.log', 'config/.ENV.prod', 'src/new.ts']) expect(all).toContain(f);
    expect(all).not.toContain('dist/out.js'); // LIST_IGNORE as before
  });

  it('an API root below the repository top lists its own files, root-relative', async () => {
    const ws = createWorkspace(repo, 'src', { visibility: 'git' });
    expect(await ws.list(['**/*'])).toEqual(['a.ts', 'new.ts']);
  });
});

describe("visibility 'git': hidden() and its reasons", () => {
  it('names why each refused path is refused', async () => {
    const ws = createWorkspace(repo, '.', { visibility: 'git' });
    const hidden = async (rel: string): Promise<string | null> => (ws.hidden === undefined ? 'no hidden()' : ws.hidden(rel));
    expect(await hidden('.env')).toMatch(/environment file \(\.env\*\): it can hold secrets, so it is never shown, even when tracked/);
    expect(await hidden('config/.ENV.prod')).toMatch(/environment file/);
    expect(await hidden('.git/config')).toMatch(/inside \.git/);
    expect(await hidden('debug.log')).toMatch(/is ignored by git/);
    expect(await hidden('node_modules/pkg/index.js')).toMatch(/is ignored by git/);
    expect(await hidden('dist')).toMatch(/is ignored by git/);
  });

  it('the legitimate twins are shown: tracked, untracked-not-ignored, and tracked-though-ignored', async () => {
    const ws = createWorkspace(repo, '.', { visibility: 'git' });
    for (const rel of ['src/a.ts', 'src/new.ts', 'build/keep.txt', 'src', '.gitignore', 'environment.ts']) expect(await ws.hidden?.(rel), rel).toBeNull();
  });

  it('a check git cannot answer is a refusal (fail closed)', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'not-a-repo-')));
    try {
      expect(await gitHiddenReason(outside, 'a.ts')).toMatch(/could not tell whether a\.ts is ignored by git/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(isEnvPath('a/.envrc')).toBe(true);
    expect(isEnvPath('src/environment.ts')).toBe(false);
    expect(isGitPath('sub/.GIT/HEAD')).toBe(true);
    expect(isGitPath('src/.gitkeep')).toBe(false);
  });
});

describe('the read tools over a git-visibility workspace', () => {
  it('read_file and outline refuse .env (tracked), ignored files and .git, with the reason; a source file reads (the twin)', async () => {
    const ctx = ctxFor(createWorkspace(repo, '.', { visibility: 'git' }));
    for (const [path, why] of [['.env', /environment file/], ['debug.log', /ignored by git/], ['.git/HEAD', /inside \.git/]] as const) {
      const r = await readFile.run({ path }, ctx);
      expect(r.ok, path).toBe(false);
      expect(r.summary).toMatch(why);
      expect(r.summary).not.toMatch(/TOKEN_IN/);
      const o = await outline.run({ path }, ctx);
      expect(o.ok).toBe(false);
      expect(o.summary).toMatch(why);
    }
    const ok = await readFile.run({ path: 'src/a.ts' }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.summary).toContain('TOKEN_IN_SOURCE');
    expect((await outline.run({ path: 'src/new.ts' }, ctx)).ok).toBe(true);
  });

  it('a symlink to .env is refused by what it points at', async () => {
    symlinkSync('../.env', join(repo, 'src', 'settings.ts'));
    const ctx = ctxFor(createWorkspace(repo, '.', { visibility: 'git' }));
    const r = await readFile.run({ path: 'src/settings.ts' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/environment file/);
  });

  it('list_files shows only visible files and refuses a hidden directory by name', async () => {
    const ctx = ctxFor(createWorkspace(repo, '.', { visibility: 'git' }));
    const all = await listFiles.run({}, ctx);
    expect(all.data).toEqual({ files: ['.gitignore', 'build/keep.txt', 'src/a.ts', 'src/new.ts'] });
    const nm = await listFiles.run({ dir: 'node_modules' }, ctx);
    expect(nm.ok).toBe(false);
    expect(nm.summary).toMatch(/node_modules is ignored by git/);
    expect((await listFiles.run({ dir: 'src' }, ctx)).data).toEqual({ files: ['src/a.ts', 'src/new.ts'] });
  });

  /** Tracked symlinks to a secret, to an ignored file, out of the root and into .git, plus a link to a source file (the twin). */
  function plantLinks(): void {
    const outside = join(repo, '..', 'outside.txt');
    writeFileSync(outside, 'TOKEN_OUTSIDE\n');
    symlinkSync('../.env', join(repo, 'src', 'env-link.ts'));
    symlinkSync('../debug.log', join(repo, 'src', 'log-link.ts'));
    symlinkSync(outside, join(repo, 'src', 'out-link.ts'));
    symlinkSync('../.git/config', join(repo, 'src', 'git-link.ts'));
    symlinkSync('a.ts', join(repo, 'src', 'alias.ts'));
    git('add', 'src');
    git('commit', '-q', '-m', 'links');
  }

  it('a tracked symlink is listed only when its target would be: never to .env, an ignored file, .git or out of the root', async () => {
    plantLinks();
    const ws = createWorkspace(repo, '.', { visibility: 'git' });
    const listed = await ws.list(['**/*']);
    expect(listed).toContain('src/alias.ts');
    for (const f of ['src/env-link.ts', 'src/log-link.ts', 'src/out-link.ts', 'src/git-link.ts']) expect(listed, f).not.toContain(f);
  });

  it('search_code with glob **/* never reads through a symlink to a hidden file; a link to source is searched', async () => {
    plantLinks();
    const ctx = ctxFor(createWorkspace(repo, '.', { visibility: 'git' }));
    const r = await searchCode.run({ pattern: 'TOKEN_', glob: '**/*' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).not.toMatch(/TOKEN_IN_ENV|TOKEN_IN_LOG|TOKEN_OUTSIDE/);
    expect(r.summary).not.toMatch(/\[core\]/); // nothing of .git/config either
    expect(r.summary).toContain('src/alias.ts:1:');
    expect(r.summary).toContain('src/a.ts:1:');
  });

  it('the baseline front-load never includes a hidden file through a symlink', async () => {
    plantLinks();
    const text = await frontLoad({ ws: createWorkspace(repo, '.', { visibility: 'git' }), checks: [] });
    expect(text).not.toMatch(/TOKEN_IN_ENV|TOKEN_IN_LOG|TOKEN_OUTSIDE|repositoryformatversion/);
    expect(text).toContain('=== src/alias.ts ===');
    // file-mode twin: the default workspace front-loads every file it lists
    expect(await frontLoad({ ws: createWorkspace(repo, '.'), checks: [] })).toContain('TOKEN_IN_ENV');
  });

  it('search_code never reads a hidden file, whatever the glob', async () => {
    const ctx = ctxFor(createWorkspace(repo, '.', { visibility: 'git' }));
    const r = await searchCode.run({ pattern: 'TOKEN_IN', glob: '**/*' }, ctx);
    expect(r.summary).toContain('src/a.ts:1:');
    expect(r.summary).toContain('src/new.ts:1:');
    expect(r.summary).not.toMatch(/TOKEN_IN_ENV|TOKEN_IN_LOG/);
    // file-mode twin: the default workspace searches everything it lists
    const plain = await searchCode.run({ pattern: 'TOKEN_IN', glob: '**/*' }, ctxFor(createWorkspace(repo, '.')));
    expect(plain.summary).toContain('TOKEN_IN_ENV');
  });
});
