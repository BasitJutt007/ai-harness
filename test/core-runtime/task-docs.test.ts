/** docs/task-format.md: every example in the doc loads as the doc says it does. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { decodeTask, normalizeTask } from '../../src/core/task.ts';
import type { Task } from '../../src/core/types.ts';

const DOC = readFileSync(join(HARNESS_ROOT, 'docs', 'task-format.md'), 'utf8');

/** The fenced block that follows the bold example heading `label`. */
function example(label: string): string {
  const at = DOC.indexOf(`**${label}`);
  if (at === -1) throw new Error(`no example "${label}" in docs/task-format.md`);
  const m = DOC.slice(at).match(/```[a-z]*\n([\s\S]*?)```/);
  if (m === null) throw new Error(`no code block after "${label}"`);
  return m[1] ?? '';
}

function load(text: string, name: string, opts: { target?: string } = {}): Task {
  return normalizeTask(decodeTask(text, name).data, { ...opts, source: name, file: name }).task;
}

describe('docs/task-format.md examples', () => {
  it('structured: canonical, also under --strict-task', () => {
    const text = example('Structured');
    const t = load(text, 'users-api.task.yaml');
    expect(t).toMatchObject({ kind: 'greenfield', id: 'users-api', output: 'generated/users-api' });
    expect(normalizeTask(decodeTask(text, 'u.yaml', true).data, { strict: true }).task).toEqual(t);
  });

  it('map style: models map, field strings, endpoints, criteria as a string', () => {
    const t = load(example('Map style'), 'dealership.task.yaml');
    if (t.kind !== 'greenfield') throw new Error('expected greenfield');
    expect(t).toMatchObject({ id: 'dealership', title: 'Car dealership', output: 'generated/dealership', brief: 'Dealers list cars for sale; buyers reserve them.' });
    expect(t.resources.map((r) => r.name)).toEqual(['car', 'reservation']);
    expect(t.resources[0]?.fields.map((f) => `${f.name}:${f.type}`)).toEqual(['make:string', 'model:string', 'year:integer', 'price:decimal']);
    expect(t.resources[1]?.fields[1]).toMatchObject({ name: 'status', type: 'enum', values: ['pending', 'confirmed', 'cancelled'], default: 'pending' });
    expect(t.resources[1]?.operations).toEqual(['list', 'create']);
    expect(t.behaviours).toContain('Endpoint: POST /v1/reservations/:id/cancel');
    expect(t.behaviours).toContain('Cancelling twice returns 409.');
  });

  it('free text: front matter makes it brownfield; without it, --target does', () => {
    const text = example('Free text');
    const t = load(text, 'add-search.md');
    expect(t).toMatchObject({ kind: 'brownfield', id: 'add-search', title: 'Add search to projects', target: '.' });
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const viaFlag = load(body, 'add-search.md', { target: '/abs/their-api' });
    expect(viaFlag).toMatchObject({ kind: 'brownfield', target: '/abs/their-api', title: 'Add search to projects' });
    if (t.kind !== 'brownfield' || viaFlag.kind !== 'brownfield') throw new Error('expected brownfield');
    expect(viaFlag.change).toBe(t.change);
  });
});
