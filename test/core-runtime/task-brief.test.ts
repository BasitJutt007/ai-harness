/**
 * How a normalized task reaches the model, and where template knowledge lives: the free-text brief
 * and carried keys verbatim, declared types as declared, tests named as the deliverable, and the
 * template's conventions/read-only paths read from templates/<name>/harness.template.json (generic
 * text and no extra read-only paths for a template without one).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { greenfieldReadOnly, writePolicy } from '../../plugins/lib/path-policy.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { fieldLine, scaffoldApiOf, taskBrief } from '../../src/core/prompt.ts';
import { decodeTask, normalizeTask } from '../../src/core/task.ts';
import { GENERIC_SIGNATURE_GLOBS, templateManifest } from '../../src/core/template.ts';
import type { GreenfieldTask, Task } from '../../src/core/types.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('task-brief');
afterAll(() => tmp.cleanup());

function load(text: string, name = 'x.task.yaml'): Task {
  return normalizeTask(decodeTask(text, name).data, { source: name, file: name }).task;
}

function green(t: Task): GreenfieldTask {
  if (t.kind !== 'greenfield') throw new Error('expected greenfield');
  return t;
}

describe('taskBrief: what the model is told', () => {
  it('free-text brief and carried keys appear verbatim; declared types are printed as declared', () => {
    const brief = 'Build a bakery API.\n\n  - customers have email (unique)\n  - orders have a status';
    const t = load(
      [
        'title: Bakery',
        'description: |',
        ...brief.split('\n').map((l) => `  ${l}`),
        'auth: {type: bearer, scopes: [read, write]}',
        'notes: "Use cursor pagination: {cursor, limit}."',
        'resources:',
        '  order:',
        '    tags: "string[]"',
        '    lines: array<OrderLine>',
        '    total: money',
        '    placedOn: date',
        '    customer: Customer',
        '    note:',
      ].join('\n'),
    );
    const b = taskBrief(t, { tree: '' });
    expect(b).toContain(`Brief (verbatim from the task file):\n${brief}\n`);
    expect(b).toContain('Additional details from the task file (verbatim):\nauth:\n  type: bearer\n  scopes:\n    - read\n    - write\nnotes: "Use cursor pagination: {cursor, limit}."');
    for (const line of ['tags: string[]', 'lines: array<OrderLine>', 'total: money', 'placedOn: date', 'customer: Customer', 'note: unspecified type']) {
      expect(b.split('\n')).toContain(line);
    }
    // never the self-contradicting "string (declared type …)" form
    expect(b).not.toMatch(/declared type/);
  });

  it('greenfield without resources says so; resource notes are printed under their resource', () => {
    const b = taskBrief(load('Build a pets API with name and species.', 'pets.txt'), { tree: '' });
    expect(b).toContain('Resources: none listed; derive them from the brief.');
    const withNotes = taskBrief(load('title: T\nresources: [{name: order, fields: {total: decimal}, relations: belongs to customer}]\n'), { tree: '' });
    expect(withNotes).toMatch(/total: decimal\noperations: list, get, create, update, delete\nnote: relations: belongs to customer/);
  });

  it('tells the model its tests are the deliverable, in both kinds', () => {
    expect(taskBrief(load('title: T\nbrief: x\n'), { tree: '' })).toMatch(/Your tests are a deliverable: cover every resource operation and behaviour/);
    const brown = taskBrief(load('kind: brownfield\ntitle: T\nchange: Add search.\n'), { tree: '' });
    expect(brown).toMatch(/Your tests are a deliverable: cover the change and every acceptance criterion .*existing tests must keep passing/);
  });

  it('brownfield: resources named by the task and an explicit brief are shown', () => {
    const t = load('kind: brownfield\ntitle: T\nchange: Add tags.\nresources: {tag: {label: string}}\n');
    const b = taskBrief(t, { tree: '' });
    expect(b).toContain('Resources named by the task (new or extended):\nResource tag (plural tags)\nlabel: string');
    expect(b).not.toContain('server-managed id (uuid)');
    const strict = normalizeTask({ kind: 'brownfield', id: 'b', title: 'B', target: '.', change: 'C', brief: 'Background.' }, { strict: true }).task;
    expect(taskBrief(strict, { tree: '' })).toContain('Brief (verbatim from the task file):\nBackground.');
  });

  it('fieldLine: rawType wins over the canonical name; enum values win over both', () => {
    expect(fieldLine({ name: 'q', type: 'integer', rawType: 'int', required: true, unique: false, readOnly: false, min: 1 })).toBe('q: int, required, min 1');
    expect(fieldLine({ name: 's', type: 'enum', rawType: 'string', values: ['a', 'b'], required: false, unique: false, readOnly: false })).toBe('s: enum [a|b]');
    expect(fieldLine({ name: 'x', type: 'unknown', required: false, unique: false, readOnly: false })).toBe('x: unspecified type');
  });
});

describe('template manifest: template knowledge lives in the template', () => {
  const templates = join(tmp.dir, 'templates');
  mkdirSync(join(templates, 'bare', 'src'), { recursive: true });
  mkdirSync(join(templates, 'custom'), { recursive: true });
  mkdirSync(join(templates, 'broken'), { recursive: true });
  writeFileSync(join(templates, 'custom', 'harness.template.json'), JSON.stringify({ readOnly: ['core/**'], signatureGlobs: ['core/*.ts'] }));
  writeFileSync(join(templates, 'broken', 'harness.template.json'), '{"readOnly": "src/**"}');

  it('express-zod: read-only globs, brief lines, entry point and signature globs come from its manifest', () => {
    const m = templateManifest('express-zod');
    expect(m).toMatchObject({ readOnly: ['src/lib/**', 'src/server.ts'], entry: { module: 'src/app.ts', export: 'createApp' } });
    const b = taskBrief(green(load('title: T\nbrief: x\n')), { tree: '' });
    for (const line of m?.brief ?? []) expect(b).toContain(line);
    expect(b).toContain('Every createApp() call must start with empty state');
  });

  it('a template without a manifest: null, generic brief text, generic signature globs', () => {
    expect(templateManifest('bare', templates)).toBeNull();
    const t = { ...green(load('title: T\nbrief: x\n')), template: 'bare' };
    const b = taskBrief(t, { tree: '', template: null });
    expect(b).toMatch(/template "bare" ships no conventions \(no harness\.template\.json\)/);
    expect(b).not.toContain('createApp');
    expect(b).not.toContain('src/lib');
    expect(GENERIC_SIGNATURE_GLOBS).toEqual(['src/**/*.ts']);
  });

  it('a manifest without brief lines: generic text plus its read-only paths', () => {
    const m = templateManifest('custom', templates);
    expect(m).toEqual({ readOnly: ['core/**'], brief: [], signatureGlobs: ['core/*.ts'] });
    const b = taskBrief({ ...green(load('title: T\nbrief: x\n')), template: 'custom' }, { tree: '', template: m });
    expect(b).toContain('Read-only (writes are blocked): core/**.');
  });

  it('a malformed manifest is an error, never silently ignored', () => {
    expect(() => templateManifest('broken', templates)).toThrow(/invalid template manifest .*readOnly/);
  });

  it('signature globs of the manifest decide the scaffold API section', async () => {
    const root = join(tmp.dir, 'api');
    mkdirSync(join(root, 'core'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'core', 'a.ts'), 'export function helper(): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'src', 'b.ts'), 'export const other = 2;\n');
    const ws = createWorkspace(tmp.dir, 'api');
    expect(await scaffoldApiOf(ws, templateManifest('custom', templates))).toBe('core/a.ts:1  export function helper(): number');
    expect(await scaffoldApiOf(ws, null)).toBe('src/b.ts:1  export const other = 2;');
  });

  it('path policy: the manifest\'s read-only globs block writes (case-insensitively); no manifest, no extra block', () => {
    const t = green(load('title: T\nbrief: x\n'));
    expect(greenfieldReadOnly('express-zod')).toEqual(['src/lib/**', 'src/server.ts']);
    for (const p of ['src/lib/problem.ts', 'SRC/LIB/problem.ts', 'src/server.ts']) {
      const d = writePolicy(t, p);
      expect(d.allowed, p).toBe(false);
      expect(d.reason).toContain('read-only scaffold (src/lib/**, src/server.ts)');
    }
    expect(writePolicy(t, 'src/routes/users.ts').allowed).toBe(true);
    // a template the harness has no manifest for declares nothing read-only beyond the built-in denies
    const other = { ...t, template: 'no-such-template' };
    expect(greenfieldReadOnly('no-such-template')).toEqual([]);
    expect(writePolicy(other, 'src/lib/problem.ts').allowed).toBe(true);
    expect(writePolicy(other, 'package.json').allowed).toBe(false);
    expect(writePolicy(other, 'tsconfig.json').allowed).toBe(false);
  });

  it('the manifest is never copied into a scaffolded API', async () => {
    const { scaffold } = await import('../../src/core/run.ts');
    const dest = join(tmp.dir, 'scaffolded');
    await scaffold(join(HARNESS_ROOT, 'templates'), 'express-zod', dest, 'x-api');
    const files = await createWorkspace(dest, '.').list(['**/*']);
    expect(files).toContain('src/app.ts');
    expect(files.some((p) => p.endsWith('harness.template.json'))).toBe(false);
  });
});
