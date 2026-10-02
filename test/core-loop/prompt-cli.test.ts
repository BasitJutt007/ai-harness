import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agnosticDiff, main, parseArgs, providerVocabulary, scanForLeaks } from '../../src/core/cli.ts';
import { compactTree, fieldLine, frontLoad, systemPrompt, taskBrief } from '../../src/core/prompt.ts';
import type { BrownfieldTask, CheckPlugin, ToolSpec } from '../../src/core/types.ts';
import { GREENFIELD } from './fakes.ts';

/** Temp dirs this file creates under .harness/tmp; removed after the run. */
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const checks: CheckPlugin[] = ['zod-boundary', 'problem-json', 'tsc-strict', 'rest-conventions'].map((id) => ({
  kind: 'check',
  id,
  category: 'standards',
  description: `${id} rule description that is reasonably descriptive and about one line long`,
  unit: 'units',
  doc: `FULL DOC OF ${id} `.repeat(50),
  run: async () => [],
}));

const tools: ToolSpec[] = ['list_files', 'read_file', 'outline', 'search_code', 'write_file', 'run_tests', 'test_map', 'fetch_standard', 'finish'].map(
  (name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }),
);

const BROWNFIELD: BrownfieldTask = {
  kind: 'brownfield',
  id: 'projects-change',
  title: 'Add archived flag',
  target: 'samples/existing-api',
  change: 'Add an optional archived boolean to projects.',
  behaviours: ['PATCH can archive a project.'],
  scope: { allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] },
  allowBreaking: false,
  limits: { maxTurns: 10, maxOutputTokens: 1000 },
};

describe('systemPrompt', () => {
  const sp = systemPrompt({ task: GREENFIELD, checks, tools });

  it('is small and lists one index line per rule without the rule text', () => {
    expect(sp.length).toBeLessThanOrEqual(2600);
    for (const c of checks) expect(sp).toContain(`- ${c.id}: ${c.description}`);
    expect(sp).not.toContain('FULL DOC OF');
  });

  it('is provider neutral and states the governance contract', () => {
    const lower = sp.toLowerCase();
    const terms = providerVocabulary(process.cwd()).terms;
    for (const t of terms) expect(lower).not.toContain(t);
    expect(sp).not.toMatch(/<\/[a-z_]+>/i);
    expect(sp).toMatch(/Express 5, Zod 4, Vitest/);
    expect(sp).toMatch(/gates/);
    expect(sp).toMatch(/plan -> write test -> run_tests \(red\)/);
    expect(sp).toContain('fetch_standard <rule>');
    expect(sp).toContain('Do not re-read files you just wrote');
  });

  it('a new rule plugin appears automatically', () => {
    const extra: CheckPlugin = { ...checks[0], id: 'no-console', category: 'lint', description: 'no console.log in src' } as CheckPlugin;
    expect(systemPrompt({ task: GREENFIELD, checks: [...checks, extra], tools })).toContain('- no-console: no console.log in src');
  });
});

describe('taskBrief', () => {
  it('renders a greenfield task compactly', () => {
    const b = taskBrief(GREENFIELD, { tree: 'src/: app.ts' });
    expect(b).toContain('email: email, required, unique');
    expect(b).toContain('name: string, required, min 1, max 100');
    expect(b).toContain('role: enum [admin|member], default member');
    expect(b).toContain('operations: list, get, create, update, delete');
    expect(b).toContain('Base path: /v1');
    expect(b).toContain('- Creating a user whose email already exists returns 409.');
    expect(b).toMatch(/src\/lib.*problem.*errors.*pagination.*idempotency/s);
    expect(b).toContain('createApp() from src/app.ts');
    expect(b.endsWith('Files:\nsrc/: app.ts')).toBe(true);
  });

  it('renders a brownfield task with scope, contract lock and test map', () => {
    const b = taskBrief(BROWNFIELD, { tree: 'src/: app.ts', testMap: 'test/p.test.ts -> src/p.ts' });
    expect(b).toContain('Add an optional archived boolean to projects.');
    expect(b).toContain('Scope: allow src/**/*.ts, test/**/*.ts; deny (none)');
    expect(b).toMatch(/contract lock/);
    expect(b).toContain('test/p.test.ts -> src/p.ts');
  });

  it('fieldLine covers readOnly and description', () => {
    expect(fieldLine({ name: 'sku', type: 'string', required: false, unique: false, readOnly: true, description: 'stock unit' })).toBe(
      'sku: string, read-only (stock unit)',
    );
  });
});

describe('compactTree', () => {
  it('groups by directory and caps lines', () => {
    expect(compactTree(['src/app.ts', 'src/lib/a.ts', 'src/lib/b.ts', 'package.json'])).toBe(
      './: package.json\nsrc/: app.ts\nsrc/lib/: a.ts, b.ts',
    );
    const many = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, '0')}/f.ts`);
    const t = compactTree(many, 60).split('\n');
    expect(t).toHaveLength(60);
    expect(t[59]).toMatch(/41 more directories/);
  });
});

describe('frontLoad (baseline only)', () => {
  it('front-loads files and every doc (tool schemas already travel in every request\'s tools array)', async () => {
    const files: Record<string, string> = { 'src/app.ts': 'export const app = 1;', 'package.json': '{}' };
    const ws = {
      repoRoot: '/r', root: '/r', rootRel: '.',
      resolve: (p: string) => p, rel: (p: string) => p,
      read: async (p: string) => files[p] ?? null,
      write: async () => undefined, exists: async () => true,
      list: async () => Object.keys(files),
    };
    const fl = await frontLoad({ ws, checks, tools });
    expect(fl).toContain('=== src/app.ts ===\nexport const app = 1;');
    expect(fl).toContain('FULL DOC OF tsc-strict');
    expect(fl).not.toContain('=== tool: read_file ===');
    expect(fl.length).toBeGreaterThan(systemPrompt({ task: GREENFIELD, checks, tools }).length * 2);
  });
});

describe('cli', () => {
  it('parses flags, repeats and booleans', () => {
    const p = parseArgs(['tasks/x.yaml', '--driver', 'fake', '--driver-opt', 'a=1', '--driver-opt=b=2', '--baseline', '--max-turns', '5']);
    if ('error' in p) throw new Error(p.error);
    expect(p.positionals).toEqual(['tasks/x.yaml']);
    expect(p.flags.get('driver-opt')).toEqual(['a=1', 'b=2']);
    expect(p.bools.has('baseline')).toBe(true);
    expect(parseArgs(['--driver'])).toEqual({ error: '--driver needs a value' });
  });

  it('usage and unknown commands exit 2; help exits 0', async () => {
    const lines: string[] = [];
    expect(await main([], (l) => lines.push(l))).toBe(2);
    expect(lines.join('\n')).toMatch(/usage: harness/);
    expect(await main(['bogus'], () => undefined)).toBe(2);
    expect(await main(['help'], () => undefined)).toBe(0);
    expect(await main(['run', 'x.yaml'], () => undefined)).toBe(2);
    expect(await main(['check'], () => undefined)).toBe(2);
  });

  it('agnostic diff: zero diff vs differences', () => {
    const a = { task: { sha256: 'aaa' }, pluginFingerprint: { 'plugins/tools/a.ts': '1', 'plugins/hooks/b.ts': '2' } };
    expect(agnosticDiff(a, { ...a, driver: 'other' })).toEqual([]);
    const b = { task: { sha256: 'bbb' }, pluginFingerprint: { 'plugins/tools/a.ts': '9', 'plugins/gates/c.ts': '3' } };
    expect(agnosticDiff(a, b)).toEqual([
      'task sha differs: aaa vs bbb',
      'only in B: plugins/gates/c.ts',
      'only in A: plugins/hooks/b.ts',
      'changed: plugins/tools/a.ts (1 vs 9)',
    ]);
  });

  it('learns provider vocabulary from driver plugins and scans for leaks', () => {
    const root = join(process.cwd(), '.harness', 'tmp', `core-loop-doctor-${process.pid}-${Date.now()}`);
    tmpDirs.push(root);
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    mkdirSync(join(root, 'plugins', 'drivers'), { recursive: true });
    mkdirSync(join(root, 'plugins', 'tools'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'x.ts'), "import { z } from 'zod';\n");
    writeFileSync(
      join(root, 'plugins', 'drivers', 'acme.ts'),
      "import Acme from '@acmeco-ai/sdk';\nimport { z } from 'zod';\nexport const DEFAULT_MODEL = 'zephyr-9';\nconst k = env['ACMECO_API_KEY'];\n",
    );
    writeFileSync(join(root, 'plugins', 'drivers', 'offline.ts'), "import { z } from 'zod';\n");
    writeFileSync(join(root, 'plugins', 'tools', 'leaky.ts'), 'const a = 1;\n// uses Zephyr-9 for speed\n');
    const v = providerVocabulary(root);
    expect(v.terms).toEqual(['acme', 'acmeco', 'zephyr-']);
    expect(v.credentialVars).toEqual(['ACMECO_API_KEY']);
    expect(scanForLeaks(root, v.terms)).toEqual(['plugins/tools/leaky.ts:2: [zephyr-] // uses Zephyr-9 for speed']);
  });

  it('the leak scan covers every file under every plugin dir except driver plugins and drivers/', () => {
    const root = join(process.cwd(), '.harness', 'tmp', `core-loop-doctor2-${process.pid}-${Date.now()}`);
    tmpDirs.push(root);
    const put = (rel: string, body: string): void => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    put('src/core/x.ts', 'export {};\n');
    put('tasks/t.task.yaml', 'id: t\n');
    put('plugins/drivers/acme.ts', "const k = env['ACMECO_API_KEY'];\n");
    put('plugins/drivers/_wire.ts', '// acmeco wire format\n');
    put('plugins/brand-new/thing.ts', '// calls acmeco directly\n');
    put('plugins/lib/deep/helper.mjs', 'export const x = "acmeco";\n');
    put('plugins/notes.md', 'Uses ACMECO.\n');
    put('plugins/tools/side-driver.ts', "// a driver plugin outside drivers/: acmeco\nconst z = env['ZETACO_API_KEY'];\n");
    put('more-plugins/drivers/inner.ts', '// acmeco\n');
    put('more-plugins/checks/c.ts', '// acmeco\n');
    const hits = scanForLeaks(root, ['acmeco'], { pluginDirs: ['plugins', 'more-plugins'], driverFiles: ['plugins/tools/side-driver.ts'] });
    expect(hits.map((h) => h.split(':')[0])).toEqual([
      'more-plugins/checks/c.ts',
      'plugins/brand-new/thing.ts',
      'plugins/lib/deep/helper.mjs',
      'plugins/notes.md',
    ]);
    // the default scans plugins/ only, and a driver plugin outside drivers/ is scanned unless the registry says it is one
    expect(scanForLeaks(root, ['acmeco']).map((h) => h.split(':')[0])).toContain('plugins/tools/side-driver.ts');
    // a driver plugin outside drivers/ also teaches the vocabulary
    expect(providerVocabulary(root).credentialVars).toEqual(['ACMECO_API_KEY']);
    expect(providerVocabulary(root, ['plugins/tools/side-driver.ts']).credentialVars).toEqual(['ACMECO_API_KEY', 'ZETACO_API_KEY']);
  });
});
