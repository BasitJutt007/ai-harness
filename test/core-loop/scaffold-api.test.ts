/**
 * Scaffold API in the greenfield brief (real-model finding F6: models read every scaffold file
 * up front, then again when compaction folded those reads): the exported signatures of the
 * scaffold's helper files, one `path:line  export …` line each.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { compactTree, scaffoldApi, scaffoldApiOf, taskBrief } from '../../src/core/prompt.ts';
import { templateManifest } from '../../src/core/template.ts';
import type { Task } from '../../src/core/types.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { GREENFIELD } from './fakes.ts';

describe('scaffoldApi', () => {
  it('lists exported lines with path:line, sorted by path, bodies and trailing braces dropped', () => {
    const out = scaffoldApi([
      { path: 'src/lib/z.ts', content: "import x from 'y';\n\nexport function z(a: string): number {\n  return 1;\n}\nconst hidden = 1;\n" },
      { path: 'src/app.ts', content: 'export const Schema = z.object(\n  { a: z.string() },\n);\nexport type T = number;\n' },
    ]);
    expect(out.split('\n')).toEqual([
      'src/app.ts:1  export const Schema = z.object(…)',
      'src/app.ts:4  export type T = number;',
      'src/lib/z.ts:3  export function z(a: string): number',
    ]);
  });

  it('clips very long signature lines and returns an empty string when nothing is exported', () => {
    const long = `export function f(${'a: string, '.repeat(30)}): void {`;
    const line = scaffoldApi([{ path: 'src/a.ts', content: long }]);
    expect(line.length).toBe('src/a.ts:1  '.length + 151);
    expect(line.endsWith('…')).toBe(true);
    expect(scaffoldApi([{ path: 'src/a.ts', content: 'const x = 1;\n' }])).toBe('');
    expect(scaffoldApi([])).toBe('');
  });

  it('over the shipped template: the helper API, not the server entry or the tests, in a few hundred tokens', async () => {
    const ws = createWorkspace(join(HARNESS_ROOT, 'templates'), 'express-zod');
    // the signature globs come from the template's own manifest, not from core code
    const manifest = templateManifest('express-zod');
    expect(manifest?.signatureGlobs).toEqual(['src/lib/**/*.ts', 'src/app.ts', 'src/routes/index.ts']);
    const api = await scaffoldApiOf(ws, manifest);
    expect(await scaffoldApiOf(ws)).toBe(api); // the default template's manifest by default
    expect(api).toMatch(/^src\/app\.ts:\d+ {2}export function createApp\(\)/m);
    expect(api).toMatch(/^src\/routes\/index\.ts:\d+ {2}export function registerRoutes\(app: Router\): void$/m);
    expect(api).toMatch(/^src\/lib\/problem\.ts:\d+ {2}export function notFound\(/m);
    expect(api).toMatch(/^src\/lib\/pagination\.ts:\d+ {2}export function paginate</m);
    expect(api).not.toMatch(/src\/server\.ts|^test\//m);
    expect(api.length).toBeLessThan(3_000);
  });
});

describe('taskBrief', () => {
  it('greenfield: carries the scaffold API after the conventions', () => {
    const brief = taskBrief(GREENFIELD, { tree: compactTree(['src/app.ts']), scaffoldApi: 'src/app.ts:6  export function createApp(): Express' });
    expect(brief).toContain('Scaffold API (exported signatures; read_file a line range only when you need a body):\nsrc/app.ts:6  export function createApp(): Express');
    expect(brief.indexOf('Mount routers in src/routes/index.ts')).toBeLessThan(brief.indexOf('Scaffold API'));
  });

  it('greenfield without one (or an empty one), and brownfield: no scaffold API section', () => {
    expect(taskBrief(GREENFIELD, { tree: '' })).not.toContain('Scaffold API');
    expect(taskBrief(GREENFIELD, { tree: '', scaffoldApi: '' })).not.toContain('Scaffold API');
    const brown: Task = {
      kind: 'brownfield',
      id: 'p',
      title: 'Projects',
      target: 'samples/existing-api',
      change: 'Add archived status.',
      scope: { allow: ['src/**'], deny: [] },
      behaviours: ['x'],
      limits: { maxTurns: 5, maxOutputTokens: 100 },
      allowBreaking: false,
    };
    expect(taskBrief(brown, { tree: '', scaffoldApi: 'src/app.ts:6  export function createApp(): Express' })).not.toContain('Scaffold API');
  });
});

describe('greenfield brief: per-app state', () => {
  it('tells the model that createApp() starts with empty state (real runs: module-level stores leaked across tests)', async () => {
    const { taskBrief } = await import('../../src/core/prompt.ts');
    const { loadTask } = await import('../../src/core/task.ts');
    const { task } = await loadTask('tasks/users-api.task.yaml');
    const brief = taskBrief(task, { tree: '' });
    expect(brief).toContain('Every createApp() call must start with empty state');
  });
});
