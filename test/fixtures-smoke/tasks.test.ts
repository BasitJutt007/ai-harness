/**
 * Task files are provider-neutral YAML that the harness's own task loader accepts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseTask } from '../../src/core/task.ts';
import { ROOT, providerHits } from './helpers.ts';

const FILES = ['tasks/users-api.task.yaml', 'tasks/projects-change.task.yaml'];
const PROVIDER_KEY = /^(model|models|provider|driver|engine|temperature|api[_-]?key|max[_-]?tokens)$/i;

function keysOf(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysOf(v, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)]);
}

function load(file: string): { text: string; data: unknown } {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return { text, data: parseYaml(text) };
}

describe.each(FILES)('%s', (file) => {
  it('parses as YAML and contains no provider/model keys or names', () => {
    const { text, data } = load(file);
    expect(typeof data).toBe('object');
    const offending = keysOf(data).filter((k) => PROVIDER_KEY.test(k.split('.').at(-1) ?? ''));
    expect(offending).toEqual([]);
    expect(providerHits(text)).toEqual([]);
  });

  it('is accepted by the harness task schema', () => {
    const { data } = load(file);
    expect(() => parseTask(data, file)).not.toThrow();
  });
});

describe('users-api task', () => {
  it('describes the users resource exactly', () => {
    const task = parseTask(load('tasks/users-api.task.yaml').data);
    if (task.kind !== 'greenfield') throw new Error('expected a greenfield task');
    expect(task).toMatchObject({ id: 'users-api', output: 'generated/users-api', template: 'express-zod', basePath: '/v1' });
    expect(existsSync(join(ROOT, 'templates', task.template))).toBe(true);
    const [user] = task.resources;
    expect(user?.name).toBe('user');
    expect(user?.plural).toBe('users');
    expect(user?.operations).toEqual(['list', 'get', 'create', 'update', 'delete']);
    expect(user?.fields).toEqual([
      expect.objectContaining({ name: 'email', type: 'email', required: true, unique: true }),
      expect.objectContaining({ name: 'name', type: 'string', required: true, min: 1, max: 100 }),
      expect.objectContaining({ name: 'role', type: 'enum', values: ['admin', 'member'], default: 'member' }),
    ]);
    const behaviours = task.behaviours.join('\n');
    for (const needle of ['409', 'cursor', 'default 20', 'max 100', '404', '422', 'Idempotency-Key', '204']) {
      expect(behaviours).toContain(needle);
    }
  });
});

describe('projects-change task', () => {
  it('targets the sample and forbids breaking changes', () => {
    const task = parseTask(load('tasks/projects-change.task.yaml').data);
    if (task.kind !== 'brownfield') throw new Error('expected a brownfield task');
    expect(task.target).toBe('samples/existing-api');
    expect(existsSync(join(ROOT, task.target, 'src/app.ts'))).toBe(true);
    expect(task.allowBreaking).toBe(false);
    expect(task.change).toContain('DELETE /v1/projects/{projectId}');
    expect(task.change).toContain('status');
    expect(task.behaviours.length).toBeGreaterThanOrEqual(5);
  });
});
