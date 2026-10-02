import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import plugin, { loadScript } from '../../plugins/drivers/scripted.ts';
import type { ModelRequest } from '../../src/core/plugin-api.ts';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scripted-driver-'));
  await mkdir(join(root, 'fixtures/scripted/files'), { recursive: true });
  await writeFile(join(root, 'fixtures/scripted/files/users.test.ts'), 'import { it } from "vitest";\nit("works", () => {});\n');
  await writeFile(
    join(root, 'fixtures/scripted/demo.json'),
    JSON.stringify({
      description: 'demo',
      turns: [
        { text: 'Planning.', calls: [{ name: 'plan', input: { steps: ['write test'] } }] },
        {
          calls: [
            { name: 'write_file', input: { path: 'test/users.test.ts' }, contentFile: 'files/users.test.ts' },
            { name: 'run_tests', input: {} },
          ],
        },
      ],
    }),
  );
  await writeFile(join(root, 'fixtures/scripted/bad.json'), JSON.stringify({ description: 'bad', turns: [{ calls: [{ input: {} }] }] }));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const req: ModelRequest = { system: 'sys', messages: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], tools: [], maxOutputTokens: 100 };

describe('scripted driver', () => {
  it('requires a script option', () => {
    expect(plugin.kind).toBe('driver');
    expect(() => plugin.create({ options: {}, env: {}, harnessRoot: root })).toThrow(/script=/);
  });

  it('rejects invalid scripts with a clear error', () => {
    expect(() => plugin.create({ options: { script: 'fixtures/scripted/bad.json' }, env: {}, harnessRoot: root })).toThrow(/invalid script.*name/);
    expect(() => plugin.create({ options: { script: 'fixtures/scripted/missing.json' }, env: {}, harnessRoot: root })).toThrow(/cannot read script/);
  });

  it('replays turns in order, resolving contentFile, then reports exhaustion', async () => {
    const driver = plugin.create({ options: { script: 'fixtures/scripted/demo.json' }, env: {}, harnessRoot: root });
    expect(driver.name).toBe('scripted');
    expect(driver.model).toBe('scripted:demo.json');
    expect(driver.tokenCounter).toBe('js-tiktoken o200k_base (scripted driver: estimate)');

    const t1 = await driver.complete(req);
    expect(t1.stop).toBe('tool_calls');
    expect(t1.parts).toEqual([
      { type: 'text', text: 'Planning.' },
      { type: 'tool_call', id: 'call_1_0', name: 'plan', input: { steps: ['write test'] } },
    ]);
    expect(t1.usage.inputTokens).toBe(await driver.countTokens(req));
    expect(t1.usage.inputTokens).toBeGreaterThan(0);

    const t2 = await driver.complete(req);
    expect(t2.parts).toEqual([
      { type: 'tool_call', id: 'call_2_0', name: 'write_file', input: { path: 'test/users.test.ts', content: 'import { it } from "vitest";\nit("works", () => {});\n' } },
      { type: 'tool_call', id: 'call_2_1', name: 'run_tests', input: {} },
    ]);

    const t3 = await driver.complete(req);
    expect(t3.stop).toBe('end_turn');
    expect(t3.parts).toEqual([{ type: 'text', text: 'script exhausted' }]);
    expect(t3.model).toBe('scripted:demo.json');
  });

  it('loadScript exposes the resolved script', () => {
    const s = loadScript(join(root, 'fixtures/scripted/demo.json'));
    expect(s.description).toBe('demo');
    expect(s.turns).toHaveLength(2);
  });
});
