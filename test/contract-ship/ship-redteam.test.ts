/**
 * Red team for ship: the harness ships, the agent never does, and shipping must
 * never be able to damage the repository (protected branches, force pushes,
 * hooks, a tree that changed after the gates looked at it).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ship } from '../../src/core/ship.ts';
import type { Exec, GatePlugin, GateResult, PluginRecord } from '../../src/core/types.ts';
import { brownfieldTask, git, isolatedExec, makeCtx, repoTmp, stubGate, writeFiles } from './helpers.ts';

const tmp = repoTmp('ship-redteam');
afterAll(() => tmp.cleanup());

let counter = 0;
async function setup(branch = 'harness/projects-change'): Promise<{ dir: string; repo: string; remote: string; baseSha: string; branch: string }> {
  const dir = join(tmp.dir, `case-${++counter}`);
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  writeFiles(repo, { 'api/src/app.ts': 'export const v = 1;\n', 'README.md': 'readme\n' });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  await git(dir, 'init', '-q', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-q', 'origin', 'refs/heads/main:refs/heads/main');
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', '-b', branch);
  writeFiles(repo, { 'api/src/app.ts': 'export const v = 2;\n' });
  return { dir, repo, remote, baseSha, branch };
}

/** gh is never really run: `ok` = installed + authenticated, records calls. */
function fakeGh(calls: string[][] = []): Exec {
  return (cmd, args, opts) => {
    if (cmd !== 'gh') return isolatedExec(cmd, args, opts);
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: args[0] === 'pr' ? 'https://example.test/pr/1\n' : 'ok\n', stderr: '', durationMs: 0, timedOut: false });
  };
}

const pass = stubGate('stub', { status: 'pass', summary: 'ok' });

function gate(name: string, run: () => GateResult): PluginRecord<GatePlugin> {
  return { plugin: { kind: 'gate', name, description: name, phases: ['ship'], run: () => Promise.resolve(run()) }, file: `plugins/gates/${name}.ts`, sha256: 'x' };
}

function ctxFor(s: { repo: string; baseSha: string }, over: { branch: string; baseBranch?: string; exec?: Exec; gates?: PluginRecord<GatePlugin>[] }) {
  return makeCtx({
    repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: over.branch, baseBranch: over.baseBranch ?? 'main',
    baseSha: s.baseSha, exec: over.exec ?? fakeGh(), gates: over.gates ?? [pass],
  });
}

async function untouched(s: { repo: string; baseSha: string }): Promise<void> {
  expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
  expect(await git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
}

describe('ship: branch names', () => {
  it('refuses protected branches in any spelling, and ref-like or HEAD names', async () => {
    const s = await setup();
    for (const branch of ['Main', 'MAIN', 'refs/heads/main', 'heads/main', 'release/1', 'release/1/hotfix', 'HEAD', 'master', 'refs/heads/feature']) {
      const ctx = ctxFor(s, { branch });
      const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
      expect(r.status, branch).toBe('refused');
      // Refused by name, before anything else is looked at (not merely because HEAD differs).
      expect(r.reasons[0], branch).toMatch(/protected branch|invalid branch name/);
    }
    await untouched(s);
  });

  it('refuses when the branch equals the base branch, ignoring letter case and ref prefixes', async () => {
    const s = await setup('feature/x');
    for (const baseBranch of ['feature/x', 'Feature/X', 'refs/heads/feature/x']) {
      const ctx = ctxFor(s, { branch: 'feature/x', baseBranch });
      const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
      expect(r.status, baseBranch).toBe('refused');
      expect(r.reasons[0]).toContain('is the base branch');
    }
    await untouched(s);
  });

  it('refuses a detached HEAD worktree', async () => {
    const s = await setup();
    await git(s.repo, 'checkout', '-q', '--detach');
    const ctx = ctxFor(s, { branch: s.branch });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons[0]).toContain('not the run branch');
  });
});

describe('ship: the committed tree is the tree the gates proved', () => {
  it('re-runs gates fresh: a change made after a green finish is caught', async () => {
    const s = await setup();
    const contentGate = gate('content', () =>
      readFileSync(join(s.repo, 'api/src/app.ts'), 'utf8').includes('BAD') ? { status: 'fail', summary: 'bad content' } : { status: 'pass', summary: 'ok' });
    writeFileSync(join(s.repo, 'api/src/app.ts'), 'export const v = "BAD";\n'); // after "finish"
    const ctx = ctxFor(s, { branch: s.branch, gates: [contentGate] });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toContain('bad content');
    await untouched(s);
  });

  it('refuses when something modifies the API root while the ship gates run', async () => {
    const s = await setup();
    // Stands in for e.g. a background process left by a test: the gate passes, then the tree changes.
    const racing = gate('racing', () => {
      writeFileSync(join(s.repo, 'api/src/app.ts'), 'export const v = "sneaky";\n');
      return { status: 'pass', summary: 'looked fine' };
    });
    const ctx = ctxFor(s, { branch: s.branch, gates: [racing] });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons[0]).toContain('changed while the ship gates were running');
    await untouched(s);
  });
});

describe('ship: pushing can never damage the remote or run repository code', () => {
  it('never force-pushes: a diverged remote branch is left intact (status committed)', async () => {
    const s = await setup();
    // Someone else's commit already sits on the remote under the same branch name.
    const other = join(s.dir, 'other');
    await git(s.dir, 'clone', '-q', s.remote, other);
    await git(other, 'checkout', '-q', '-b', s.branch);
    writeFiles(other, { 'theirs.txt': 'theirs\n' });
    await git(other, 'add', '-A');
    await git(other, 'commit', '-q', '-m', 'theirs');
    await git(other, 'push', '-q', 'origin', `refs/heads/${s.branch}:refs/heads/${s.branch}`);
    const theirs = await git(other, 'rev-parse', 'HEAD');

    const ctx = ctxFor(s, { branch: s.branch });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('committed');
    expect(r.reasons[0]).toContain('push to origin failed');
    expect(await git(s.dir, 'ls-remote', s.remote, `refs/heads/${s.branch}`)).toContain(theirs);
    expect(r.commands?.some((c) => c.includes('--force') && !c.includes('--no-force'))).toBe(false);
  });

  it('does not run the repository’s git hooks for the harness commit and push', async () => {
    const s = await setup();
    const marker = join(s.dir, 'hook-ran');
    const hooks = join(s.repo, '.githooks');
    mkdirSync(hooks, { recursive: true });
    for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
      writeFileSync(join(hooks, h), `#!/bin/sh\necho ${h} >> "${marker}"\n`);
      chmodSync(join(hooks, h), 0o755);
    }
    await git(s.repo, 'config', 'core.hooksPath', '.githooks');
    const ctx = ctxFor(s, { branch: s.branch });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('shipped');
    expect(existsSync(marker)).toBe(false);
  });

  it('a run that started from a detached HEAD pushes but opens no PR against "HEAD"', async () => {
    const s = await setup();
    const calls: string[][] = [];
    const ctx = ctxFor(s, { branch: s.branch, baseBranch: 'HEAD', exec: fakeGh(calls) });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('committed');
    expect(r.reasons[0]).toContain('detached HEAD');
    expect(calls.some((a) => a[0] === 'pr')).toBe(false);
  });

  it('refuses a fine-grained GitHub token in the staged diff', async () => {
    const s = await setup();
    writeFileSync(join(s.repo, 'api/src/app.ts'), `export const t = "github_pat_${'A1'.repeat(20)}";\n`);
    const ctx = ctxFor(s, { branch: s.branch });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toContain('GitHub token');
    await untouched(s);
  });
});
