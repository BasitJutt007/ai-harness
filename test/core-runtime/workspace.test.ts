import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { createWorkspace, createWorktree, gitToplevel, isProtectedBranch, removeWorktree, sha256 } from '../../src/core/workspace.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('workspace');
afterAll(() => tmp.cleanup());

describe('sha256', () => {
  it('hashes strings and buffers identically', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(Buffer.from('abc'))).toBe(sha256('abc'));
  });
});

describe('workspace path safety', () => {
  const repo = join(tmp.dir, 'ws-repo');
  const outside = join(tmp.dir, 'outside');
  beforeAll(() => {
    mkdirSync(join(repo, 'api/src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(repo, 'api/src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(outside, 'secret.ts'), 'x');
    mkdirSync(join(repo, 'api/node_modules/pkg'), { recursive: true });
    writeFileSync(join(repo, 'api/node_modules/pkg/index.ts'), '');
    symlinkSync(outside, join(repo, 'api/src/escape'), 'dir');
  });

  it('resolves and normalises inside paths', async () => {
    const ws = createWorkspace(repo, 'api');
    expect(ws.rootRel).toBe('api');
    expect(ws.resolve('src/a.ts')).toBe(join(repo, 'api/src/a.ts'));
    expect(ws.rel('./src//a.ts')).toBe('src/a.ts');
    expect(ws.rel(join(repo, 'api/src/a.ts'))).toBe('src/a.ts');
    expect(ws.rel('src/new/dir/x.ts')).toBe('src/new/dir/x.ts');
    expect(await ws.read('src/a.ts')).toContain('a = 1');
    expect(await ws.read('src/missing.ts')).toBeNull();
    await ws.write('src/deep/b.ts', 'b');
    expect(await ws.exists('src/deep/b.ts')).toBe(true);
    expect(await ws.list(['**/*.ts'])).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });

  it('rejects .. escapes', () => {
    const ws = createWorkspace(repo, 'api');
    expect(() => ws.resolve('../x.ts')).toThrow(/escapes/);
    expect(() => ws.resolve('src/../../x.ts')).toThrow(/escapes/);
    expect(() => ws.rel(join(repo, 'other.ts'))).toThrow(/escapes/);
  });

  it('rejects absolute paths and NUL bytes', async () => {
    const ws = createWorkspace(repo, 'api');
    expect(() => ws.resolve('/etc/passwd')).toThrow(/absolute/);
    expect(() => ws.resolve('C:\\x')).toThrow(/absolute/);
    expect(() => ws.resolve('src/a.ts\0')).toThrow(/NUL/);
    await expect(ws.write('/tmp/x.ts', 'x')).rejects.toThrow(/absolute/);
  });

  it('rejects symlink escapes (existing and not-yet-existing targets)', async () => {
    const ws = createWorkspace(repo, 'api');
    expect(() => ws.resolve('src/escape/secret.ts')).toThrow(/symlink/);
    expect(() => ws.resolve('src/escape/new/file.ts')).toThrow(/symlink/);
    await expect(ws.read('src/escape/secret.ts')).rejects.toThrow(/symlink/);
    await expect(ws.write('src/escape/pwn.ts', 'x')).rejects.toThrow(/symlink/);
    expect(existsSync(join(outside, 'pwn.ts'))).toBe(false);
  });

  it('writes atomically: never through a symlink or hard link at the target, never onto a directory', async () => {
    const ws = createWorkspace(repo, 'api');
    writeFileSync(join(repo, 'api/src/real.ts'), 'original\n');
    symlinkSync('real.ts', join(repo, 'api/src/sym.ts'));
    linkSync(join(repo, 'api/src/real.ts'), join(repo, 'api/src/hard.ts'));
    await ws.write('src/sym.ts', 'via symlink\n');
    await ws.write('src/hard.ts', 'via hard link\n');
    expect(readFileSync(join(repo, 'api/src/real.ts'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(repo, 'api/src/sym.ts'), 'utf8')).toBe('via symlink\n');
    expect(readFileSync(join(repo, 'api/src/hard.ts'), 'utf8')).toBe('via hard link\n');
    mkdirSync(join(repo, 'api/src/adir.ts'));
    await expect(ws.write('src/adir.ts', 'x')).rejects.toThrow(/directory/);
    expect(readdirSync(join(repo, 'api/src')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects an API root outside the repo', () => {
    expect(() => createWorkspace(repo, '../elsewhere')).toThrow(/escapes/);
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('createWorktree', () => {
  const repo = join(tmp.dir, 'git-repo');
  const harnessRoot = join(tmp.dir, 'harness-root');
  const config = { ...loadConfig(), worktreeDir: '.harness/worktrees' };

  beforeAll(async () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    mkdirSync(harnessRoot, { recursive: true });
    await git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'hi\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  });

  it('gitToplevel returns the real repo root', async () => {
    expect(await gitToplevel(join(repo))).toBe(realpathSync(repo));
  });

  it('creates a branch + worktree and reports the base', async () => {
    const r = await createWorktree({ harnessRoot, config, repoDir: repo, runId: 'run-1', branch: 'harness/test-1' });
    expect(r.worktreeRoot).toBe(realpathSync(join(harnessRoot, '.harness/worktrees/run-1')));
    expect(r.baseBranch).toBe('main');
    expect(r.baseSha).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(join(r.worktreeRoot, 'README.md'))).toBe(true);
    expect(await git(r.worktreeRoot, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('harness/test-1');
    // The target's own dependencies come first (its node_modules is linked in); the harness's is only the
    // fallback, reached by walking up because the worktree is inside the harness root (never linked here).
    expect(realpathSync(join(r.worktreeRoot, 'node_modules'))).toBe(realpathSync(join(repo, 'node_modules')));
    await removeWorktree(repo, r.worktreeRoot);
    expect(existsSync(r.worktreeRoot)).toBe(false);
  });

  it('links node_modules when the worktree is outside the harness root', async () => {
    const outsideCfg = { ...config, worktreeDir: join(tmp.dir, 'external-worktrees') };
    const r = await createWorktree({ harnessRoot, config: outsideCfg, repoDir: repo, runId: 'run-6', branch: 'harness/test-6' });
    expect(existsSync(join(r.worktreeRoot, 'node_modules'))).toBe(true);
    await removeWorktree(repo, r.worktreeRoot);
  });

  it('protects branches regardless of ref prefix, letter case or depth', () => {
    const patterns = ['main', 'master', 'release/*'];
    for (const b of ['main', 'Main', 'MAIN', 'refs/heads/main', 'heads/main', 'release/1', 'Release/1', 'release/1/hotfix', 'main/x']) {
      expect(isProtectedBranch(b, patterns), b).toBe(true);
    }
    for (const b of ['harness/users-api', 'feature/main-page', 'mainline', 'releases']) {
      expect(isProtectedBranch(b, patterns), b).toBe(false);
    }
  });

  it('refuses protected branches', async () => {
    await expect(createWorktree({ harnessRoot, config, repoDir: repo, runId: 'run-2', branch: 'main' })).rejects.toThrow(/protected/);
    await expect(createWorktree({ harnessRoot, config, repoDir: repo, runId: 'run-3', branch: 'release/1.0' })).rejects.toThrow(/protected/);
    await expect(createWorktree({ harnessRoot, config, repoDir: repo, runId: 'run-7', branch: 'Main' })).rejects.toThrow(/protected/);
  });

  it('refuses an existing branch', async () => {
    await git(repo, 'branch', 'feature/exists');
    await expect(createWorktree({ harnessRoot, config, repoDir: repo, runId: 'run-4', branch: 'feature/exists' })).rejects.toThrow(/already exists/);
  });

  it('reports HEAD as base branch when detached', async () => {
    const sha = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '-q', '--detach', sha);
    const r = await createWorktree({ harnessRoot, config, repoDir: repo, runId: 'run-5', branch: 'harness/test-5' });
    expect(r.baseBranch).toBe('HEAD');
    expect(r.baseSha).toBe(sha);
    await removeWorktree(repo, r.worktreeRoot);
    await git(repo, 'checkout', '-q', 'main');
  });
});
