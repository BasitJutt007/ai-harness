import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import {
  buildTestMap, failureOffsets, importSpecifiers, isAssertionFailure, isConstantExpression, isTestFile, isTestSupport, locatedRed, resolveSpecifier, staticTestCases,
} from '../../src/core/testmap.ts';
import type { CaseResolver } from '../../src/core/testmap.ts';
import * as pluginApi from '../../src/core/plugin-api.ts';
import * as red from '../../plugins/lib/red.ts';
import ts from 'typescript';
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
    // test support code (test/helpers.ts) is followed but never covered
    expect(map.coverage['test/users.test.ts']).toEqual([
      'src/app.ts', 'src/lib/problem.ts', 'src/routes/users.ts', 'src/schemas/user.ts', 'src/store/index.ts',
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
    expect(map.testsFor('test/helpers.ts')).toEqual([]);
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

describe('one definition of a test file', () => {
  it('runnable = *.test|spec.(c|m)?ts anywhere; test support = any other file under test/', () => {
    for (const f of ['test/a.test.ts', 'test/deep/b.spec.mts', 'src/c.test.cts', 'd.spec.ts']) {
      expect(isTestFile(f), f).toBe(true);
      expect(isTestSupport(f), f).toBe(false);
    }
    for (const f of ['test/helpers.ts', 'test/fixtures/users.ts', 'test/users.ts']) {
      expect(isTestFile(f), f).toBe(false);
      expect(isTestSupport(f), f).toBe(true);
    }
    expect(isTestFile('src/users.ts') || isTestSupport('src/users.ts')).toBe(false);
  });

  it('the plugin API and plugins/lib/red.ts use the core definition (no second copy)', () => {
    expect(pluginApi.isTestFile).toBe(isTestFile);
    expect(pluginApi.isTestSupport).toBe(isTestSupport);
    expect(red.isTestFile).toBe(isTestFile);
    expect(red.isTestSupport).toBe(isTestSupport);
    // test support is writable without a red, like tests; neither is governed source
    expect(red.isGovernedSource('test/helpers.ts')).toBe(false);
    expect(red.isGovernedSource('test/users.ts')).toBe(false);
    expect(red.isGovernedSource('src/users.ts')).toBe(true);
    expect(red.suggestedTest('src/routes/users.ts')).toBe('test/users.test.ts');
  });
});

describe('staticTestCases', () => {
  /** Resolver over a fixed file set: src/** and test/helpers.ts (which imports src/app.ts) reach src/. */
  const resolver = (from: string): CaseResolver => ({
    resolve: (spec) => resolveSpecifier(from, spec, new Set(['src/users.ts', 'src/app.ts', 'test/helpers.ts', 'test/data.ts'])),
    reachesSource: (t) => t.startsWith('src/') || t === 'test/helpers.ts',
  });
  const cases = (content: string) => staticTestCases('test/u.test.ts', content, resolver('test/u.test.ts'));
  const brief = (content: string) => cases(content).map((c) => [c.name, c.exercisesSource, c.constantOnly]);

  it('keys cases by describe nesting (as test-preservation does), incl. .each/.only/aliases and dynamic titles', () => {
    const src = [
      "import { describe, it, test } from 'vitest';",
      "describe('users', () => {",
      "  describe.each([1, 2])('page %i', () => { it('lists', () => {}); });",
      "  it.only('a', () => {});",
      "  xit('b', () => {});",
      "  test.each([[1]])('row %s ok', () => {});",
      '  it(`tpl`, () => {});',
      '  it(name, () => {});',
      "  it.todo('later');",
      '});',
    ].join('\n');
    const cs = cases(src);
    expect(cs.map((c) => c.name)).toEqual([
      'users > page %i > lists', 'users > a', 'users > b', 'users > row %s ok', 'users > tpl', 'users > <dynamic>', 'users > later',
    ]);
    const m = (i: number) => cs[i]?.match;
    expect(m(1)).toEqual({ exact: 'users > a' });
    const pattern = (i: number): RegExp => {
      const x = m(i);
      if (x === undefined || !('pattern' in x)) throw new Error('expected a pattern');
      return x.pattern;
    };
    expect(pattern(0).test('users > page 2 > lists')).toBe(true);
    expect(pattern(3).test('users > row 1 ok')).toBe(true);
    expect(pattern(3).test('users > a')).toBe(false);
    expect(pattern(5).test('users > anything')).toBe(true);
    expect(cs[6]?.bodyHash).toBeUndefined();
  });

  it('bodyHash ignores comments and whitespace, and changes when the body changes', () => {
    const a = cases("it('x', () => { expect(f()).toBe(1); });")[0]?.bodyHash;
    const b = cases("it('x', () => {\n  // why\n  expect( f() )\n    .toBe(1); /* end */\n});")[0]?.bodyHash;
    const c = cases("it('x', () => { expect(f()).toBe(2); });")[0]?.bodyHash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    // whitespace INSIDE literals is content, not formatting
    const lit = (body: string) => cases(`it('x', () => { ${body} });`)[0]?.bodyHash;
    expect(lit("expect(f()).toBe('a b');")).not.toBe(lit("expect(f()).toBe('ab');"));
    expect(lit('expect(f()).toMatch(/a b/);')).not.toBe(lit('expect(f()).toMatch(/ab/);'));
    expect(lit('expect(f()).toBe(`${x} b`);')).not.toBe(lit('expect(f()).toBe(`${x}b`);'));
    expect(lit('expect(-f()).toBe(1);')).not.toBe(lit('expect(!f()).toBe(1);'));
  });

  it('exercisesSource: bindings imported from src/ (directly, via helpers or file-level declarations, or in hooks)', () => {
    expect(brief([
      "import { findUser } from '../src/users.ts';",
      "import * as users from '../src/users.ts';",
      "import createApp from '../src/app.ts';",
      "import { h } from './helpers.ts';",
      "import { rows } from './data.ts';",
      'const app = createApp();',
      'async function create() { return app; }',
      "it('named', () => { expect(findUser(1)).toBe(1); });",
      "it('namespace', () => { expect(users.count).toBe(0); });",
      "it('through a const', () => { expect(app.ok).toBe(true); });",
      "it('through a helper fn', async () => { expect(await create()).toBeDefined(); });",
      "it('through test/helpers.ts', () => { expect(h()).toBe(1); });",
      "it('data only', () => { expect(rows.length).toBe(1); });",
      "it('dynamic import', async () => { const m = await import('../src/users.ts'); expect(m.x).toBe(1); });",
      "it('property named like a binding', () => { const o = { findUser: 1 }; expect(o.findUser).toBe(1); });",
      "it('shadowed', () => { const findUser = 2; expect(findUser).toBe(2); });",
    ].join('\n'))).toEqual([
      ['named', true, false],
      ['namespace', true, false],
      ['through a const', true, false],
      ['through a helper fn', true, false],
      ['through test/helpers.ts', true, false],
      ['data only', false, false],
      ['dynamic import', true, false],
      ['property named like a binding', false, false],
      ['shadowed', false, false],
    ]);
  });

  it('side-effect imports, type-only imports and vi.mock()ed modules do not count; beforeEach/beforeAll do', () => {
    expect(brief([
      "import '../src/users.ts';",
      "import type { User } from '../src/users.ts';",
      "it('side effect', () => { const u: User | null = null; expect(u).toBe(1); });",
    ].join('\n'))).toEqual([['side effect', false, false]]);
    expect(brief([
      "import { vi } from 'vitest';",
      "import { findUser } from '../src/users.ts';",
      "vi.mock('../src/users.ts', () => ({ findUser: () => 1 }));",
      "it('mocked', () => { expect(findUser()).toBe(2); });",
    ].join('\n'))).toEqual([['mocked', false, false]]);
    expect(brief([
      "import { reset } from '../src/users.ts';",
      'let n = 0;',
      'beforeEach(() => { n = reset(); });',
      "describe('s', () => { beforeAll(() => { void reset; }); it('inner', () => { expect(n).toBe(1); }); });",
      "it('outer', () => { expect(n).toBe(1); });",
    ].join('\n'))).toEqual([['s > inner', true, false], ['outer', true, false]]);
  });

  // Was: "assert() does not count" ('assert only' -> [false, true]). An audit showed that rejected real
  // assertions on the app (vitest's assert, node:assert, assert(cond), imported helpers); any assertion
  // API now counts, and constant-only / source-free assertions are still rejected (see the table below).
  it('constantOnly: no assertion, or only constant subjects (expect.assertions does not count); helpers are followed; exercisesSource needs an assertion on source', () => {
    expect(brief([
      "import { findUser } from '../src/users.ts';",
      'function check(id: number) { expect(findUser(id)).toBe(1); }',
      "it('true/false', () => { void findUser; expect(true).toBe(false); });",
      "it('numbers', () => { findUser(1); expect(1).toBe(2); expect.soft('a').toBe('b'); });",
      "it('literals', () => { findUser(1); expect([1, { a: null }]).toEqual(undefined); expect(`t`).toBe(-1); });",
      "it('no assertion', () => { findUser(1); });",
      "it('assert only', () => { assert.equal(findUser(1), 1); expect.assertions(1); });",
      "it('via helper', () => { check(1); });",
      "it('mixed', () => { expect(true).toBe(true); expect(findUser(1)).toBe(2); });",
    ].join('\n'))).toEqual([
      // Calling or naming src code is not enough: an assertion subject must use its value.
      ['true/false', false, true],
      ['numbers', false, true],
      ['literals', false, true],
      ['no assertion', false, true],
      ['assert only', true, false],
      ['via helper', true, false],
      ['mixed', true, false],
    ]);
  });

  it('isConstantExpression', () => {
    const expr = (code: string): ts.Expression => {
      const st = ts.createSourceFile('x.ts', `(${code});`, ts.ScriptTarget.Latest, true).statements[0];
      if (st === undefined || !ts.isExpressionStatement(st)) throw new Error('no expression');
      return st.expression;
    };
    for (const c of ['1', '"a"', 'true', 'null', 'undefined', '`x`', '[1, [2]]', '{ a: 1, b: "c" }', '-1', '1 + 2', 'void 0', '1 as const']) {
      expect(isConstantExpression(expr(c)), c).toBe(true);
    }
    for (const c of ['x', '`${x}`', '[x]', '{ x }', '{ [k]: 1 }', 'f()', 'a.b', '[...xs]']) {
      expect(isConstantExpression(expr(c)), c).toBe(false);
    }
  });
});

describe('staticTestCases: idioms seen in a real gpt-5.4-mini run', () => {
  const resolver = (from: string): CaseResolver => ({
    resolve: (spec) => resolveSpecifier(from, spec, new Set(['src/users.ts', 'src/app.ts', 'test/helpers.ts', 'test/data.ts'])),
    reachesSource: (t) => t.startsWith('src/') || t === 'test/helpers.ts',
  });
  const cases = (content: string) => staticTestCases('test/u.test.ts', content, resolver('test/u.test.ts'));
  const brief = (content: string) => cases(content).map((c) => [c.name, c.exercisesSource, c.constantOnly]);

  // Verbatim shape of the real test that was wrongly rejected ("red rejected: ... do not assert on anything imported from src/").
  const REAL = [
    "import request from 'supertest';",
    "import { beforeEach, describe, expect, it } from 'vitest';",
    "import { createApp } from '../src/app.ts';",
    "function userPath(id: string): string { return `/v1/users/${id}`; }",
    "describe('users API', () => {",
    '  let app = createApp();',
    '  beforeEach(() => { app = createApp(); });',
    "  it('creates and validates', async () => {",
    "    const created = await request(app).post('/v1/users').send({ email: 'a@example.com', name: 'Ada' }).expect(201);",
    '    expect(created.headers.location).toBe(userPath(created.body.id));',
    "    await request(app).post('/v1/users').send({}).expect(422);",
    '  });',
    "  it('only chained supertest assertions', async () => {",
    "    await request(app).get('/v1/users').expect(200);",
    '  });',
    '});',
  ].join('\n');

  it('a describe-scoped app reassigned in beforeEach and supertest .expect() chains count as asserting on src/', () => {
    expect(brief(REAL)).toEqual([
      ['users API > creates and validates', true, false],
      ['users API > only chained supertest assertions', true, false],
    ]);
  });

  it('still rejects constant-only and source-free cases', () => {
    const src = [
      "import { describe, expect, it } from 'vitest';",
      "import { createApp } from '../src/app.ts';",
      "describe('s', () => {",
      '  let app = createApp();',
      "  it('constant', () => { void app; expect(true).toBe(false); });",
      "  it('typeof only', () => { expect(typeof app).toBe('nonsense'); });",
      "  it('unrelated chain', async () => { const x = { expect: (n: number) => n }; x.expect(1); expect(1).toBe(2); });",
      '});',
    ].join('\n');
    expect(brief(src)).toEqual([
      ['s > constant', false, true],
      ['s > typeof only', false, false],
      ['s > unrelated chain', false, false],
    ]);
  });

  it('a case-local variable never leaks into other cases through the suite scope', () => {
    const src = [
      "import { describe, expect, it } from 'vitest';",
      "import { createApp } from '../src/app.ts';",
      "describe('s', () => {",
      "  it('a', () => { const local = createApp(); expect(local).toBeDefined(); });",
      "  it('b', () => { const local = 1; expect(local).toBe(2); });",
      '});',
    ].join('\n');
    expect(brief(src)).toEqual([['s > a', true, false], ['s > b', false, false]]);
  });
});

describe('red counting: any assertion API on source counts; constants and bare throws do not', () => {
  const files = new Set(['src/users.ts', 'test/helpers.ts', 'test/expect-helpers.ts']);
  const resolver: CaseResolver = {
    resolve: (spec) => resolveSpecifier('test/u.test.ts', spec, files),
    // test/expect-helpers.ts is a pure assertion helper (imports only vitest); test/helpers.ts imports src.
    reachesSource: (t) => t.startsWith('src/') || t === 'test/helpers.ts',
  };
  const HEAD = [
    "import { assert as vassert, expect, it } from 'vitest';",
    "import assert from 'node:assert/strict';",
    "import { strict as nodeStrict } from 'node:assert';",
    "import request from 'supertest';",
    "import { countUsers, createApp, seed } from '../src/users.ts';",
    "import { expectCount } from './expect-helpers.ts';",
  ];
  const brief = (body: string): [boolean, boolean] => {
    const c = staticTestCases('test/u.test.ts', [...HEAD, `it('c', async () => { ${body} });`].join('\n'), resolver)[0];
    return [c?.exercisesSource ?? false, c?.constantOnly ?? true];
  };

  const counts: Array<[string, string]> = [
    ['vitest expect', 'expect(countUsers()).toBe(1);'],
    ["vitest's chai assert", 'vassert.equal(countUsers(), 1);'],
    ['node:assert/strict', 'assert.equal(countUsers(), 1);'],
    ['assert(cond)', 'assert(countUsers() === 1);'],
    ['node:assert strict as', 'nodeStrict.deepEqual({ n: countUsers() }, { n: 1 });'],
    ['an imported assertion helper', 'const n = countUsers(); expectCount(n, 1);'],
    ['an awaited helper on an app response', "const res = await request(createApp()).get('/users'); await expectCount(res.status, 200);"],
    ['supertest .expect', "await request(createApp()).get('/users').expect(200);"],
  ];
  it.each(counts)('counts statically: %s', (_name, body) => {
    expect(brief(body)).toEqual([true, false]);
  });

  const rejected: Array<[string, string, [boolean, boolean]]> = [
    ['constant expect', 'void countUsers; expect(1).toBe(2);', [false, true]],
    ['assert.fail without a source reference', "countUsers(); assert.fail('red');", [false, true]],
    ['constant assert', 'assert.equal(1, 2);', [false, true]],
    ['assert(false)', 'assert(false);', [false, true]],
    ['throw only', "countUsers(); throw new Error('red');", [false, true]],
    ['a helper on constants', 'expectCount(1, 2);', [false, true]],
    // Calling the code under test for its effect is exercising it, not asserting on it.
    ['a source call for effect', 'seed(countUsers());', [false, true]],
  ];
  it.each(rejected)('rejected statically: %s', (_name, body, want) => {
    expect(brief(body)).toEqual(want);
  });

  it('isAssertionFailure: assertion errors of any library, not crashes or hand-thrown errors', () => {
    for (const m of [
      'AssertionError: expected +0 to be 1 // Object.is equality\n    at /x/test/u.test.ts:6:24',
      'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 1\n',
      'Error: expect(received).toBe(expected) // Object.is equality',
      'JestAssertionError: expect(received).toBe(expected)',
    ]) expect(isAssertionFailure(m), m).toBe(true);
    for (const m of ['TypeError: Cannot read properties of undefined', 'Error: red', 'Error: expected 201 "Created", got 200 "OK"', '']) {
      expect(isAssertionFailure(m), m).toBe(false);
    }
  });

  it('failureOffsets: frames of this file only (absolute paths or file:// URLs), innermost first', () => {
    const content = 'line one\nline two\nline three\n';
    const msg = [
      'AssertionError: x',
      '    at check (/tmp/api/test/u.test.ts:3:6)',
      '    at /tmp/api/test/helpers.ts:1:1',
      '    at file:///tmp/api/test/u.test.ts:2:1',
      '    at file:///tmp/node_modules/vitest/dist/run.js:10:5',
    ].join('\n');
    expect(failureOffsets(msg, 'test/u.test.ts', content)).toEqual([content.indexOf('line three') + 5, content.indexOf('line two')]);
  });

  /** Cases whose failures are judged by a synthetic runner message pointing at a line (1-based) of the file. */
  const SRC = [
    "import { expect, it } from 'vitest';", // 1
    "import assert from 'node:assert/strict';", // 2
    "import { countUsers, listUsers } from '../src/users.ts';", // 3
    'function constantCheck(): void {', // 4
    '  expect(1).toBe(2);', // 5
    '}', // 6
    "it('mixed', () => {", // 7
    '  expect(countUsers()).toBe(0);', // 8
    '  expect(1).toBe(2);', // 9
    '});', // 10
    "it('node assert', () => {", // 11
    '  assert.equal(countUsers(), 1);', // 12
    '});', // 13
    "it('throw after a real assertion', () => {", // 14
    '  expect(countUsers()).toBe(0);', // 15
    "  throw new Error('red');", // 16
    '});', // 17
    "it('loop over source', () => {", // 18
    '  for (const u of listUsers()) expect(u).toBe(1);', // 19
    '});', // 20
    "it('constant helper', () => {", // 21
    '  expect(countUsers()).toBe(0);', // 22
    '  constantCheck();', // 23
    '});', // 24
  ].join('\n');
  const statics = staticTestCases('test/u.test.ts', SRC, resolver);
  const at = (line: number, name = 'AssertionError: boom', extra: number[] = []): string =>
    [name, ...[line, ...extra].map((l) => `    at /abs/api/test/u.test.ts:${l}:5`), '    at file:///abs/node_modules/vitest/dist/run.js:1:1'].join('\n');
  const verdict = (name: string, message: string) => {
    const s = statics.find((c) => c.name === name);
    if (s === undefined) throw new Error(`no case ${name}`);
    return locatedRed(s, [message], 'test/u.test.ts', SRC);
  };

  it('judges the statement that failed: a constant assertion after a real one does not count', () => {
    const mixed = statics.find((c) => c.name === 'mixed');
    expect([mixed?.exercisesSource, mixed?.constantOnly]).toEqual([true, false]); // statically it would count
    expect(verdict('mixed', at(9))).toEqual({ exercisesSource: false, constantOnly: true });
    expect(verdict('mixed', at(8))).toEqual({ exercisesSource: true, constantOnly: false });
  });

  it('an assertion error of any library on source counts; a bare throw or a constant helper does not', () => {
    expect(verdict('node assert', at(12, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:'))).toEqual({ exercisesSource: true, constantOnly: false });
    expect(verdict('throw after a real assertion', at(16, 'Error: red'))).toEqual({ exercisesSource: false, constantOnly: true });
    // The innermost frame is in the same-file helper: a constant assertion, whatever the case calls it from.
    expect(verdict('constant helper', at(5, 'AssertionError: boom', [23]))).toEqual({ exercisesSource: false, constantOnly: true });
    // Guarded by a loop over source values: the assertion depends on source.
    expect(verdict('loop over source', at(19))).toEqual({ exercisesSource: true, constantOnly: false });
  });

  it('a crash counts only where the case also qualifies statically; no frame in the case leaves the static verdict', () => {
    expect(verdict('node assert', at(12, 'TypeError: x is undefined'))).toEqual({ exercisesSource: true, constantOnly: false });
    expect(verdict('throw after a real assertion', at(16, 'TypeError: nope'))).toEqual({ exercisesSource: false, constantOnly: true });
    expect(verdict('mixed', at(12))).toBeNull(); // the frame is in another case
    expect(verdict('mixed', 'AssertionError: no stack')).toBeNull();
  });
});
