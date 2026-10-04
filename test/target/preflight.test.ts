/**
 * Preflight (run.ts): the profile is computed before the first model turn, and a brownfield task
 * that declares no `scope` gets the target's own roots as its write scope instead of the template's
 * src/ + test/ (which deadlocks a tests/ or lib/ layout). A declared scope is never overridden, and
 * the built-in denies (config, package.json, dot-files) still hold. Whether a task declares its scope
 * is decided by the task front end (LoadedTask.declaresScope), whatever the file's format or spelling.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writePolicy } from '../../plugins/lib/path-policy.ts';
import { preflight } from '../../src/core/run.ts';
import { setActiveLayout } from '../../src/core/target.ts';
import { loadTask } from '../../src/core/task.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { scratch, VARIANTS, writeTree } from './_variants.ts';

const tmp = scratch('preflight');
afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});

function taskFile(name: string, scope: string, ext = 'yaml'): string {
  const file = join(tmp.dir, `${name}.task.${ext}`);
  writeFileSync(file, `kind: brownfield\nid: ${name}\ntitle: t\ntarget: api\nchange: add a thing\n${scope}`);
  return file;
}

describe.each(VARIANTS.filter((v) => v.runner !== 'jest'))('preflight default scope: $name', (v) => {
  it('an undeclared scope becomes the target layout; writes outside it and to config stay denied', async () => {
    const root = join(tmp.dir, v.name.replace(/[^a-z0-9]+/gi, '-'));
    writeTree(root, v.files);
    const loaded = await loadTask(taskFile('no-scope', ''));
    expect(loaded.declaresScope).toBe(false);
    const task = loaded.task;
    const r = await preflight(task, loaded.declaresScope, createWorkspace(root, '.'));
    expect(r.error).toBeUndefined();
    expect(r.scopeFromProfile).toBe(true);
    for (const allowed of [v.red.source, v.suggest.test]) expect(writePolicy(task, allowed).allowed, allowed).toBe(true);
    for (const denied of ['package.json', 'vitest.config.ts', 'tsconfig.json', '.env', 'node_modules/x/index.ts', 'README.md']) {
      expect(writePolicy(task, denied).allowed, denied).toBe(false);
    }
  });
});

describe('preflight: a declared scope wins', () => {
  it('keeps the task\'s own allow/deny lists untouched', async () => {
    const v = VARIANTS.find((x) => x.name.startsWith('tests/'));
    if (v === undefined) throw new Error('tests/ variant missing');
    const root = join(tmp.dir, 'declared');
    writeTree(root, v.files);
    const loaded = await loadTask(taskFile('declared', 'scope:\n  allow: ["src/**/*.ts"]\n  deny: ["src/lib/**"]\n'));
    expect(loaded.declaresScope).toBe(true);
    const task = loaded.task;
    const r = await preflight(task, loaded.declaresScope, createWorkspace(root, '.'));
    expect(r.scopeFromProfile).toBe(false);
    expect(task.kind === 'brownfield' ? task.scope : null).toEqual({ allow: ['src/**/*.ts'], deny: ['src/lib/**'] });
    expect(writePolicy(task, 'tests/math.test.ts').allowed).toBe(false);
    expect(r.profile?.testSupportRoots).toEqual(['tests']);
  });

  it('a deny-only scope keeps its denies and takes the allow list from the target layout', async () => {
    const v = VARIANTS.find((x) => x.name.startsWith('tests/'));
    if (v === undefined) throw new Error('tests/ variant missing');
    const root = join(tmp.dir, 'deny-only');
    writeTree(root, v.files);
    const loaded = await loadTask(taskFile('deny-only', 'scope:\n  deny: ["src/math.ts"]\n'));
    expect(loaded.declaresScope).toBe(false);
    const task = loaded.task;
    const r = await preflight(task, loaded.declaresScope, createWorkspace(root, '.'));
    expect(r.scopeFromProfile).toBe(true);
    expect(writePolicy(task, 'tests/math.test.ts').allowed).toBe(true);
    expect(writePolicy(task, 'src/math.ts').allowed).toBe(false);
  });

  // The front end decides, not a re-read of the file: other formats and key spellings count the same.
  it.each<[string, string, string, boolean]>([
    ['yaml, canonical scope', 'yaml', 'scope:\n  allow: ["lib/**/*.ts"]\n', true],
    ['yaml, capitalised key and alias', 'yaml', 'Scope:\n  Include: lib/**/*.ts, tests/**/*.ts\n', true],
    ['yaml, scope as a plain list', 'yaml', 'scope: ["lib/**/*.ts"]\n', true],
    ['yaml, no scope', 'yaml', '', false],
  ])('%s', async (_name, ext, scope, declared) => {
    expect((await loadTask(taskFile(`shape-${String(declared)}-${scope.length}`, scope, ext))).declaresScope).toBe(declared);
  });

  it('markdown: front-matter scope is declared; a free-text task declares none', async () => {
    const withScope = join(tmp.dir, 'fm.md');
    writeFileSync(withScope, '---\nkind: brownfield\ntarget: api\nscope:\n  allow: ["lib/**/*.ts"]\n---\nAdd a thing to the API.\n');
    expect((await loadTask(withScope)).declaresScope).toBe(true);
    const free = join(tmp.dir, 'free.md');
    writeFileSync(free, 'Add a delete endpoint to the projects API.\n');
    expect((await loadTask(free, { target: 'api' })).declaresScope).toBe(false);
  });

  it('a greenfield task never takes a scope from the profile', async () => {
    const root = join(tmp.dir, 'greenfield');
    writeTree(root, { 'src/a.ts': '' });
    const file = join(tmp.dir, 'g.task.yaml');
    writeFileSync(file, 'kind: greenfield\nid: g\ntitle: t\nbrief: a tiny API\n');
    const loaded = await loadTask(file);
    const r = await preflight(loaded.task, loaded.declaresScope, createWorkspace(root, '.'));
    expect(r.scopeFromProfile).toBe(false);
    expect(loaded.task.kind).toBe('greenfield');
  });
});
