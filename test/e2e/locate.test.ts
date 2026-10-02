/**
 * Run orchestration edges that need no agent: where a task lands (any git repo), what the
 * scaffold copies, and that setup refusals leave no worktree or branch behind.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../../src/core/cli.ts';
import { executeRun, locateApi, scaffold } from '../../src/core/run.ts';
import { loadTask } from '../../src/core/task.ts';
import type { BrownfieldTask, GreenfieldTask } from '../../src/core/types.ts';
import { collector, git, PROJECTS_TASK, SCRIPTS, tempRepo, USERS_TASK } from './helpers.ts';

const tmp = tempRepo('locate', { 'existing/api/src': join(SCRIPTS, 'users-api', 'src') });
afterAll(() => tmp.cleanup());

async function greenfield(output: string): Promise<GreenfieldTask> {
  const t = (await loadTask(USERS_TASK)).task;
  if (t.kind !== 'greenfield') throw new Error('expected greenfield');
  return { ...t, output };
}

async function brownfield(target: string): Promise<BrownfieldTask> {
  const t = (await loadTask(PROJECTS_TASK)).task;
  if (t.kind !== 'brownfield') throw new Error('expected brownfield');
  return { ...t, target };
}

describe('locateApi', () => {
  it('greenfield: the repo is the git toplevel of the nearest existing ancestor of the output', async () => {
    expect(await locateApi(await greenfield('generated/users-api'), tmp.repo)).toEqual({ repoDir: tmp.repo, rootRel: 'generated/users-api' });
    expect(await locateApi(await greenfield('a/b/c'), tmp.repo)).toEqual({ repoDir: tmp.repo, rootRel: 'a/b/c' });
  });

  it('brownfield: the repo of an existing target directory', async () => {
    expect(await locateApi(await brownfield('existing/api'), tmp.repo)).toEqual({ repoDir: tmp.repo, rootRel: 'existing/api' });
    expect(await locateApi(await brownfield('.'), tmp.repo)).toEqual({ repoDir: tmp.repo, rootRel: '.' });
    await expect(locateApi(await brownfield('missing/api'), tmp.repo)).rejects.toThrow(/does not exist/);
  });

  it('refuses a directory that is not in a git repository, and an output that is the repo root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'harness-locate-'));
    try {
      await expect(locateApi(await greenfield('generated/users-api'), outside)).rejects.toThrow(/not inside a git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    await expect(locateApi(await greenfield('.'), tmp.repo)).rejects.toThrow(/must be a sub-directory/);
  });
});

describe('scaffold', () => {
  it('copies the template but never node_modules, .vite or dist; fills __API_NAME__', async () => {
    const templates = join(tmp.dir, 'templates');
    for (const d of ['t/src', 't/node_modules/x', 't/.vite/deps', 't/dist', 't/test/.vite']) mkdirSync(join(templates, d), { recursive: true });
    writeFileSync(join(templates, 't/package.json'), '{ "name": "__API_NAME__" }\n');
    writeFileSync(join(templates, 't/src/app.ts'), 'export {};\n');
    writeFileSync(join(templates, 't/node_modules/x/index.js'), '');
    writeFileSync(join(templates, 't/.vite/deps/a.json'), '{}');
    writeFileSync(join(templates, 't/dist/app.js'), '');
    const dest = join(tmp.dir, 'scaffolded');
    await scaffold(templates, 't', dest, 'my-api');
    expect(readdirSync(dest).sort()).toEqual(['package.json', 'src', 'test']);
    expect(readdirSync(join(dest, 'test'))).toEqual([]);
    await expect(scaffold(templates, 't', dest, 'x')).rejects.toThrow(/non-empty/);
    await expect(scaffold(templates, 'nope', join(tmp.dir, 'other'), 'x')).rejects.toThrow(/template not found/);
  });
});

describe('setup refusals leave nothing behind', () => {
  it('greenfield output already committed in the base branch: refused before any worktree', async () => {
    const repo = tempRepo('refuse', { 'generated/users-api/README.md': join(SCRIPTS, 'users-api.json') });
    try {
      await expect(
        executeRun({
          taskFile: USERS_TASK,
          driver: 'scripted',
          driverOptions: { script: join(SCRIPTS, 'users-api.json') },
          baseline: false,
          ship: false,
          repoBase: repo.repo,
          runsDir: repo.runsDir,
          tokensDir: repo.tokensDir,
          log: collector().out,
        }),
      ).rejects.toThrow(/refusing to scaffold/);
      expect(git(repo.repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
      expect(git(repo.repo, ['branch', '--list', 'harness/*'])).toBe('');
    } finally {
      repo.cleanup();
    }
  });

  it('unknown driver and missing driver options fail with a clear error (exit 1), usage errors exit 2', async () => {
    const out = collector();
    expect(await main(['run', USERS_TASK, '--driver', 'nope', '--repo', tmp.repo], out.out)).toBe(1);
    expect(out.text()).toMatch(/unknown driver "nope"\. Available drivers: .*scripted/);
    const out2 = collector();
    expect(await main(['run', USERS_TASK, '--driver', 'scripted', '--repo', tmp.repo], out2.out)).toBe(1);
    expect(out2.text()).toMatch(/could not start: .*script=/);
    expect(await main(['run', USERS_TASK], collector().out)).toBe(2);
    expect(await main(['run', 'missing.task.yaml', '--driver', 'scripted'], collector().out)).toBe(2);
    expect(await main(['run', USERS_TASK, '--driver', 'scripted', '--bogus', 'x'], collector().out)).toBe(2);
    expect(await main(['run', USERS_TASK, '--driver', 'scripted', '--remote', 'origin'], collector().out)).toBe(2);
    expect(await main([], collector().out)).toBe(2);
    expect(await main(['help'], collector().out)).toBe(0);
    expect(git(tmp.repo, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });
});
