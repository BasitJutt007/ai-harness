import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import { buildTestMap, importSpecifiers, resolveSpecifier } from '../../src/core/testmap.ts';
import type { Workspace } from '../../src/core/types.ts';

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = join(HARNESS_ROOT, '.harness', 'tmp', `core-quality-testmap-${randomBytes(4).toString('hex')}`);

/** Minimal Workspace over a directory (the real one lives in workspace.ts; only list/read are used). */
function fakeWorkspace(dir: string): Workspace {
  const abs = (rel: string): string => join(dir, rel);
  return {
    repoRoot: dir,
    root: dir,
    rootRel: '.',
    resolve: abs,
    rel: (p) => p,
    read: async (rel) => readFile(abs(rel), 'utf8').catch(() => null),
    write: async (rel, content) => {
      await mkdir(dirname(abs(rel)), { recursive: true });
      await writeFile(abs(rel), content);
    },
    exists: async (rel) => stat(abs(rel)).then(() => true, () => false),
    list: async (patterns) => (await glob(patterns, { cwd: dir, ignore: ['**/node_modules/**', '**/.git/**'] })).sort(),
  };
}

const files: Record<string, string> = {
  'src/app.ts': "import { usersRouter } from './routes/users.js';\nimport { problem } from './lib/problem.ts';\nexport const app = [usersRouter, problem];\n",
  'src/routes/users.ts': "import { store } from '../store';\nexport * from '../schemas/user.js';\nexport const usersRouter = store;\n",
  'src/store/index.ts': "import type { X } from 'zod';\nexport const store = 1;\n",
  'src/schemas/user.ts': 'export const UserSchema = 1;\n',
  'src/lib/problem.ts': 'export const problem = 1;\n',
  'src/orphan.ts': 'export const orphan = 1;\n',
  'src/widgets.ts': 'export const w = 1;\n',
  'test/helpers.ts': "export { app } from '../src/app.js';\n",
  'test/users.test.ts': "import { app } from './helpers.js';\nimport { it } from 'vitest';\nit('x', () => { void app; });\n",
  'test/orders.test.ts': "import { it, vi } from 'vitest';\nvi.mock('../src/lib/problem.js');\nit('x', async () => { await import('../src/orders.js'); });\n",
  'test/widgets.test.ts': "import { it } from 'vitest';\nit('no imports', () => {});\n",
  'test/gadgets.test.ts': "import { it } from 'vitest';\nit('no imports', () => {});\n",
  'scripts/seed.ts': "import { UserSchema } from '../src/schemas/user.js';\nexport const seed = UserSchema;\n",
  'test/seed.test.ts': "import { seed } from '../scripts/seed.js';\nimport { it } from 'vitest';\nit('s', () => { void seed; });\n",
};

beforeAll(async () => {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildTestMap', () => {
  it('computes transitive coverage over all non-test .ts files, incl. not-yet-existing targets', async () => {
    const map = await buildTestMap(fakeWorkspace(root));
    expect(Object.keys(map.coverage).sort()).toEqual([
      'test/gadgets.test.ts', 'test/orders.test.ts', 'test/seed.test.ts', 'test/users.test.ts', 'test/widgets.test.ts',
    ]);
    expect(map.coverage['test/users.test.ts']).toEqual([
      'src/app.ts', 'src/lib/problem.ts', 'src/routes/users.ts', 'src/schemas/user.ts', 'src/store/index.ts', 'test/helpers.ts',
    ]);
    // governed files outside src/ are part of the closure (and so are their imports)
    expect(map.coverage['test/seed.test.ts']).toEqual(['scripts/seed.ts', 'src/schemas/user.ts']);
    // dynamic import of a file that does not exist yet + vi.mock literal
    expect(map.coverage['test/orders.test.ts']).toEqual(['src/lib/problem.ts', 'src/orders.ts']);
    expect(map.coverage['test/widgets.test.ts']).toEqual([]);
  });

  it('testsFor: closure first, basename fallback only for sources that do not exist yet', async () => {
    const map = await buildTestMap(fakeWorkspace(root));
    expect(map.testsFor('src/orders.ts')).toEqual(['test/orders.test.ts']);
    expect(map.testsFor('src/orders.js')).toEqual(['test/orders.test.ts']);
    expect(map.testsFor('src/lib/problem.ts')).toEqual(['test/orders.test.ts', 'test/users.test.ts']);
    expect(map.testsFor('src/store/index.ts')).toEqual(['test/users.test.ts']);
    // src/widgets.ts exists and nothing imports it: no name-based guess
    expect(map.testsFor('src/widgets.ts')).toEqual([]);
    // src/gadgets.ts does not exist yet: the same-named test is the best attribution
    expect(map.testsFor('src/gadgets.ts')).toEqual(['test/gadgets.test.ts']);
    expect(map.testsFor('src/orphan.ts')).toEqual([]);
    expect(map.testsFor('scripts/seed.ts')).toEqual(['test/seed.test.ts']);
    expect(map.testsFor('test/helpers.ts')).toEqual(['test/users.test.ts']);
  });
});

describe('import parsing and resolution', () => {
  it('finds static, re-export, dynamic and vi.mock specifiers', () => {
    const specs = importSpecifiers('test/a.test.ts', [
      "import a from './a.js';",
      "import type { B } from '../src/b.js';",
      "export { c } from './c';",
      "const d = await import('./d.js');",
      "vi.mock('./e.js', () => ({}));",
      "const f = await vi.importActual('./f.js');",
      "const g = await import(name);",
      "foo('./not-an-import.js');",
    ].join('\n'));
    expect(specs).toEqual(['./a.js', '../src/b.js', './c', './d.js', './e.js', './f.js']);
  });

  it('resolves .js → .ts, extensionless → .ts or /index.ts, and keeps missing targets', () => {
    const existing = new Set(['src/x/index.ts', 'src/y.ts']);
    expect(resolveSpecifier('src/a.ts', './y.js', existing)).toBe('src/y.ts');
    expect(resolveSpecifier('src/a.ts', './x', existing)).toBe('src/x/index.ts');
    expect(resolveSpecifier('src/a.ts', './y', existing)).toBe('src/y.ts');
    expect(resolveSpecifier('src/a.ts', './new', existing)).toBe('src/new.ts');
    expect(resolveSpecifier('test/a.test.ts', '../src/new.js', existing)).toBe('src/new.ts');
    expect(resolveSpecifier('src/a.ts', 'zod', existing)).toBeNull();
    expect(resolveSpecifier('src/a.ts', '../../outside.js', existing)).toBeNull();
  });
});
