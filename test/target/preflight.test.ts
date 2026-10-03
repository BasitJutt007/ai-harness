/**
 * Preflight (run.ts): the profile is computed before the first model turn, and a brownfield task
 * that declares no `scope` gets the target's own roots as its write scope instead of the template's
 * src/ + test/ (which deadlocks a tests/ or lib/ layout). A declared scope is never overridden, and
 * the built-in denies (config, package.json, dot-files) still hold.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writePolicy } from '../../plugins/lib/path-policy.ts';
import { preflight } from '../../src/core/run.ts';
import { setActiveLayout } from '../../src/core/target.ts';
import { parseTask } from '../../src/core/task.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { scratch, VARIANTS, writeTree } from './_variants.ts';

const tmp = scratch('preflight');
afterAll(() => {
  setActiveLayout(undefined);
  tmp.cleanup();
});

function taskFile(name: string, scope: string): string {
  const file = join(tmp.dir, `${name}.task.yaml`);
  writeFileSync(file, `kind: brownfield\nid: ${name}\ntitle: t\ntarget: api\nchange: add a thing\n${scope}`);
  return file;
}

describe.each(VARIANTS.filter((v) => v.runner !== 'jest'))('preflight default scope: $name', (v) => {
  it('an undeclared scope becomes the target layout; writes outside it and to config stay denied', async () => {
    const root = join(tmp.dir, v.name.replace(/[^a-z0-9]+/gi, '-'));
    writeTree(root, v.files);
    const file = taskFile('no-scope', '');
    const task = parseTask({ kind: 'brownfield', id: 'no-scope', title: 't', target: 'api', change: 'add a thing' });
    const r = await preflight(task, file, createWorkspace(root, '.'));
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
    const file = taskFile('declared', 'scope:\n  allow: ["src/**/*.ts"]\n  deny: ["src/lib/**"]\n');
    const task = parseTask({ kind: 'brownfield', id: 'declared', title: 't', target: 'api', change: 'x', scope: { allow: ['src/**/*.ts'], deny: ['src/lib/**'] } });
    const r = await preflight(task, file, createWorkspace(root, '.'));
    expect(r.scopeFromProfile).toBe(false);
    expect(task.kind === 'brownfield' ? task.scope : null).toEqual({ allow: ['src/**/*.ts'], deny: ['src/lib/**'] });
    expect(writePolicy(task, 'tests/math.test.ts').allowed).toBe(false);
    expect(r.profile?.testSupportRoots).toEqual(['tests']);
  });

  it('an unreadable task file counts as declaring a scope (never widened on a guess)', async () => {
    const root = join(tmp.dir, 'unreadable');
    writeTree(root, { 'src/a.ts': '' });
    const task = parseTask({ kind: 'brownfield', id: 'u', title: 't', target: 'api', change: 'x' });
    const before = task.kind === 'brownfield' ? [...task.scope.allow] : [];
    const r = await preflight(task, join(tmp.dir, 'missing.task.yaml'), createWorkspace(root, '.'));
    expect(r.scopeFromProfile).toBe(false);
    expect(task.kind === 'brownfield' ? task.scope.allow : []).toEqual(before);
  });
});
