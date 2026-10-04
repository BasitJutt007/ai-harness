/**
 * `harness task check <file>`: normalize a task file without a run (no tokens): the canonical task
 * and every note, exit 0 iff valid; --strict-task keeps the canonical-only behaviour for CI;
 * --target / --output override the file. `run` accepts the same task flags.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { main, USAGE } from '../../src/core/cli.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('task-cli');
afterAll(() => tmp.cleanup());

async function cli(...argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(argv, (l) => lines.push(l));
  return { code, text: lines.join('\n') };
}

function file(name: string, body: string): string {
  const p = join(tmp.dir, name);
  writeFileSync(p, body);
  return p;
}

const FIXTURES = join(HARNESS_ROOT, 'test', 'fixtures', 'tasks');

describe('harness task check', () => {
  it('prints the notes and the canonical task as YAML; exit 0', async () => {
    const r = await cli('task', 'check', join(FIXTURES, '10-capitalised-plural.yaml'));
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/^kind {6}greenfield {2}id shop-api {2}output generated\/shop-api$/m);
    expect(r.text).toContain('  - id "Shop_API" -> "shop-api"');
    const yaml = r.text.split('canonical task:\n')[1] ?? '';
    const task: unknown = parseYaml(yaml.split('\n').map((l) => l.slice(2)).join('\n'));
    expect(task).toMatchObject({ kind: 'greenfield', id: 'shop-api', resources: [{ name: 'order-item' }] });
  });

  it('a canonical file has no notes', async () => {
    const r = await cli('task', 'check', join(HARNESS_ROOT, 'tasks', 'users-api.task.yaml'));
    expect(r.code).toBe(0);
    expect(r.text).toContain('notes     (none: the file is canonical)');
  });

  it('--json prints the whole normalization record', async () => {
    const r = await cli('task', 'check', join(FIXTURES, '12-markdown.md'), '--json');
    expect(r.code).toBe(0);
    const j: unknown = JSON.parse(r.text);
    expect(j).toMatchObject({ format: 'markdown', strict: false, task: { kind: 'greenfield', title: 'Pets API' } });
  });

  it('an invalid file: every issue, exit 1; a provider key is still refused', async () => {
    const r = await cli('task', 'check', join(FIXTURES, '09-model-key.yaml'));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/key "model" is not allowed/);
  });

  it('--strict-task: the canonical schema only (an alias-shaped file fails, a canonical one passes)', async () => {
    const lenient = await cli('task', 'check', join(FIXTURES, '02-fields-map.yaml'));
    expect(lenient.code).toBe(0);
    const strict = await cli('task', 'check', join(FIXTURES, '02-fields-map.yaml'), '--strict-task');
    expect(strict.code).toBe(1);
    expect(strict.text).toMatch(/\(--strict-task\):\n {2}resources\.0\(contact\)\.fields: Invalid input: expected array/);
    expect((await cli('task', 'check', join(HARNESS_ROOT, 'tasks', 'projects-change.task.yaml'), '--strict-task')).code).toBe(0);
  });

  it('--target makes a free-text task a brownfield change of that directory; --output a greenfield build', async () => {
    const md = file('add-search.md', '# Add search\n\nGET /v1/items accepts ?q= and filters by name.\n');
    const r = await cli('task', 'check', md, '--target', tmp.dir, '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text)).toMatchObject({ task: { kind: 'brownfield', id: 'add-search', target: tmp.dir, title: 'Add search' } });
    const o = await cli('task', 'check', md, '--output', 'out/new-api', '--json');
    expect(JSON.parse(o.text)).toMatchObject({ task: { kind: 'greenfield', output: join(process.cwd(), 'out', 'new-api') } });
  });

  it('usage errors exit 2', async () => {
    expect((await cli('task')).code).toBe(2);
    expect((await cli('task', 'lint', 'x.yaml')).code).toBe(2);
    expect((await cli('task', 'check')).code).toBe(2);
    expect((await cli('task', 'check', join(tmp.dir, 'missing.yaml'))).code).toBe(2);
    expect((await cli('task', 'check', join(FIXTURES, '12-markdown.md'), '--bogus', 'v')).text).toMatch(/unknown option --bogus/);
    const both = await cli('task', 'check', join(FIXTURES, '12-markdown.md'), '--target', tmp.dir, '--output', 'x');
    expect(both).toMatchObject({ code: 2, text: expect.stringMatching(/mutually exclusive/) });
    expect((await cli('task', 'check', join(FIXTURES, '12-markdown.md'), '--target', join(tmp.dir, 'nope'))).text).toMatch(/--target is not a directory/);
  });

  it('run: accepts the task flags and rejects contradictory ones before any work', async () => {
    expect(USAGE).toMatch(/--strict-task/);
    expect(USAGE).toMatch(/task check <task-file>/);
    const both = await cli('run', join(FIXTURES, '12-markdown.md'), '--driver', 'scripted', '--target', tmp.dir, '--output', 'x');
    expect(both).toMatchObject({ code: 2, text: expect.stringMatching(/mutually exclusive/) });
  });
});
