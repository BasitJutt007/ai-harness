/**
 * test-preservation: tests that existed at run start are APPEND-ONLY. Every attempt below to
 * neutralise an existing assertion while keeping its title must be blocked; growing the suite
 * (appending statements, new cases, new describe blocks) must stay allowed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookVerdict, RunContext, Task, ToolCallInfo } from '../../src/core/plugin-api.ts';
import testPreservation, { testBlocks, weakenedCases } from '../../plugins/hooks/test-preservation.ts';
import editFile from '../../plugins/tools/edit_file.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import { brownfieldTask, callInfo, greenfieldTask, HARNESS_ROOT, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const FILE = 'test/users.test.ts';
const EXISTING = [
  "import { beforeEach, describe, expect, it, vi } from 'vitest';",
  "import { createUser, resetUsers } from '../src/users.ts';",
  '',
  'beforeEach(() => {',
  '  resetUsers();',
  '});',
  '',
  "describe('users', () => {",
  "  it('creates a user', () => {",
  "    const u = createUser('ann');",
  "    expect(u.name).toBe('ann');",
  '    expect(u.id).toMatch(/^u_/);',
  '  });',
  '',
  "  it('rejects an empty name', () => {",
  "    expect(() => createUser('')).toThrow('name');",
  '  });',
  '',
  "  it('is short', () => expect(createUser('b').name).toHaveLength(1));",
  '});',
  '',
].join('\n');

const sub = (from: string, to: string): string => {
  if (!EXISTING.includes(from)) throw new Error(`fixture does not contain: ${from}`);
  return EXISTING.replace(from, to);
};

async function harness(opts: { task?: Task; content?: string; exec?: Parameters<typeof makeHarness>[0]['exec'] } = {}) {
  const h = await makeHarness({ label: 'preserve', task: opts.task ?? brownfieldTask(), files: { [FILE]: EXISTING }, exec: opts.exec });
  dirs.push(h.dir);
  h.ctx.state.initialHashes.set(FILE, sha(EXISTING));
  return h;
}

const write = (content: string, p = FILE): ToolCallInfo => callInfo(writeFile, { path: p, content });
const pre = (call: ToolCallInfo, ctx: RunContext): Promise<HookVerdict> => testPreservation.run({ event: 'pre_tool', call }, ctx);
const reasonOf = (v: HookVerdict): string => (v.decision === 'block' ? v.reason : '');

describe('test-preservation: existing cases cannot be neutralised while keeping their titles', () => {
  const attacks: Array<[string, string]> = [
    ['gutted body', sub("    const u = createUser('ann');\n    expect(u.name).toBe('ann');\n    expect(u.id).toMatch(/^u_/);", '    expect(true).toBe(true);')],
    ['early return', sub("  it('creates a user', () => {\n", "  it('creates a user', () => {\n    return;\n")],
    ['if (false) wrapper', sub("    expect(() => createUser('')).toThrow('name');", "    if (false) {\n      expect(() => createUser('')).toThrow('name');\n    }")],
    ['modified expect', sub("expect(u.name).toBe('ann');", 'expect(u.name).toBeDefined();')],
    ['deleted expect', sub('    expect(u.id).toMatch(/^u_/);\n', '')],
    ['reordered statements', sub("    expect(u.name).toBe('ann');\n    expect(u.id).toMatch(/^u_/);", "    expect(u.id).toMatch(/^u_/);\n    expect(u.name).toBe('ann');")],
    ['statement inserted before the originals', sub("    const u = createUser('ann');", "    vi.restoreAllMocks();\n    const u = createUser('ann');")],
    ['expression body replaced', sub("expect(createUser('b').name).toHaveLength(1)", 'expect(1).toBe(1)')],
    ['new vi.mock of the code under test', sub("import { createUser, resetUsers } from '../src/users.ts';", "import { createUser, resetUsers } from '../src/users.ts';\nvi.mock('../src/users.ts');")],
    ['vi.mock hidden in a new case (vitest hoists it)', sub('});\n', "  it('new', () => {\n    vi.mock('../src/users.ts', () => ({ createUser: () => ({ name: 'ann', id: 'u_1' }) }));\n  });\n});\n")],
    ['new top-level vi.spyOn', `${EXISTING}import * as users from '../src/users.ts';\nvi.spyOn(users, 'createUser');\n`],
    ['new vi.doMock at collection time', sub("describe('users', () => {", "describe('users', () => {\n  vi.doMock('../src/users.ts');")],
    ['beforeEach gutted', sub('  resetUsers();\n', '')],
    ['beforeEach short-circuited', sub('beforeEach(() => {\n', 'beforeEach(() => {\n  return;\n')],
    ['new top-level beforeEach', `${EXISTING}beforeEach(() => { vi.restoreAllMocks(); });\n`],
    ['new beforeAll inside an existing describe', sub("describe('users', () => {", "describe('users', () => {\n  beforeAll(() => {});")],
    ['disabled through an options object', sub("it('rejects an empty name', () => {", "it('rejects an empty name', { skip: true }, () => {")],
    ['call changed (timeout added)', sub("expect(createUser('b').name).toHaveLength(1));", "expect(createUser('b').name).toHaveLength(1), 1);")],
    ['a statement appended to the existing beforeEach (it runs before every existing case)', sub('  resetUsers();\n', '  resetUsers();\n  vi.restoreAllMocks();\n')],
    // Second review round (10): a function declaration appended to a case is hoisted above its original statements.
    ['a hoisted function appended to an existing case shadows expect', sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/);\n    function expect(_v: unknown) { return { toBe() {}, toMatch() {} }; }\n")],
    ['a hoisted var appended to an existing case', sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/);\n    var u = { name: 'ann', id: 'u_1' };\n")],
    // Second review round (11): new code outside the cases that changes what they run against.
    ['a top-level expect.extend overriding built-in matchers', `${EXISTING}expect.extend({ toBe: () => ({ pass: true, message: () => '' }) });\n`],
    ['a new side-effect import of a neutralising helper', sub("import { createUser, resetUsers } from '../src/users.ts';", "import { createUser, resetUsers } from '../src/users.ts';\nimport './neutralise.ts';")],
    ['a new import of a test helper (its vi.mock reaches this file)', sub("import { createUser, resetUsers } from '../src/users.ts';", "import { createUser, resetUsers } from '../src/users.ts';\nimport { mocked } from './mocks.ts';")],
    ['expect.extend inside a new describe', `${EXISTING}describe('new', () => {\n  expect.extend({ toBe: () => ({ pass: true, message: () => '' }) });\n  it('x', () => { expect(createUser('x').name).toBe('x'); });\n});\n`],
    ['a new beforeAll in a new describe mutating globalThis', `${EXISTING}describe('new', () => {\n  beforeAll(() => { (globalThis as Record<string, unknown>).fetch = () => null; });\n  it('x', () => { expect(createUser('x').name).toBe('x'); });\n});\n`],
    ['an Object.prototype patch in a new case', `${EXISTING}it('new', () => { Object.defineProperty(Object.prototype, 'id', { value: 'u_1' }); });\n`],
    ['a new top-level declaration shadowing a name existing code uses', sub("describe('users', () => {", "const createUser = (name: string) => ({ name, id: 'u_' + name });\ndescribe('users', () => {")],
    ['a new top-level call', `${EXISTING}resetUsers();\n`],
    ['an existing import removed', sub("import { createUser, resetUsers } from '../src/users.ts';", "import { createUser } from '../src/users.ts';")],
    ['a spy appended to an existing case (it outlives the case)', sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/);\n    vi.spyOn(Math, 'random').mockReturnValue(0);\n")],
    ['an appended assignment to shared state', sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/);\n    (createUser as unknown as { calls: number }).calls = 0;\n")],
  ];

  for (const [name, content] of attacks) {
    it(`blocks: ${name}`, async () => {
      const h = await harness();
      const v = await pre(write(content), h.ctx);
      expect(v.decision, name).toBe('block');
      expect(reasonOf(v)).toContain('test-preservation');
    });
  }

  it('judges edit_file by the edited result', async () => {
    const h = await harness();
    const edit = callInfo(editFile, { path: FILE, find: "expect(u.name).toBe('ann');", replace: 'expect(u.name).toBeTruthy();' });
    expect(reasonOf(await pre(edit, h.ctx))).toContain('"users > creates a user"');
  });

  it('the block message names the case, file:line and what is allowed', async () => {
    const h = await harness();
    const reason = reasonOf(await pre(write(sub("expect(u.name).toBe('ann');", 'expect(u.name).toBeDefined();')), h.ctx));
    expect(reason).toContain(`${FILE}:11`);
    expect(reason).toContain('existing test "users > creates a user"');
    expect(reason).toContain('append new statements at the end of the case, or add a new test case');
    expect(reason).toContain("`expect(u.name).toBe('ann');`");
    const hook = reasonOf(await pre(write(sub('  resetUsers();\n', '')), h.ctx));
    expect(hook).toContain('existing top-level beforeEach');
    expect(hook).toContain('the beforeEach is locked; put new setup in a new describe block together with the new cases');
  });

  it('compares against the run-start content, so a chain of edits cannot walk an assertion away', async () => {
    const h = await harness();
    // Step 1 (allowed): append a statement. The tool then writes it.
    const step1 = sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/);\n    expect(u.id.length).toBeGreaterThan(2);\n");
    expect((await pre(write(step1), h.ctx)).decision).toBe('pass');
    await h.ws.write(FILE, step1);
    // Step 2: drop an ORIGINAL assertion from the already-edited file.
    const step2 = step1.replace("    expect(u.name).toBe('ann');\n", '');
    expect(reasonOf(await pre(write(step2), h.ctx))).toContain('"users > creates a user"');
    // The agent's own appended statement stays freely editable.
    const step3 = step1.replace('toBeGreaterThan(2)', 'toBeGreaterThan(3)');
    expect((await pre(write(step3), h.ctx)).decision).toBe('pass');
  });
});

describe('test-preservation: the suite may grow', () => {
  const allowed: Array<[string, string]> = [
    ['unchanged', EXISTING],
    ['a new expect appended at the end of a case', sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/);\n    expect(u.id).not.toBe('');\n")],
    ['an expression body turned into a block with an appended statement', sub("it('is short', () => expect(createUser('b').name).toHaveLength(1));", "it('is short', () => {\n    expect(createUser('b').name).toHaveLength(1);\n    expect(createUser('cc').name).toHaveLength(2);\n  });")],
    ['a new case in the existing describe', sub("\n  it('is short'", "\n  it('trims the name', () => {\n    expect(createUser(' c ').name).toBe('c');\n  });\n\n  it('is short'")],
    ['a new describe with its own hook, a local it assigns, and a vi.fn inside a case', `${EXISTING}\ndescribe('users: lookups', () => {\n  let last = '';\n  beforeEach(() => { resetUsers(); last = 'reset'; });\n  it('mocks', () => {\n    const fn = vi.fn();\n    expect(fn).not.toHaveBeenCalled();\n    expect(last).toBe('reset');\n  });\n});\n`],
    ['a new import of source code and a new helper with a new name', sub("import { createUser, resetUsers } from '../src/users.ts';", "import { createUser, resetUsers } from '../src/users.ts';\nimport { findUser } from '../src/find.ts';\nfunction made(name: string) { return findUser(createUser(name).id); }")],
    ['a vitest import gaining a binding', sub("import { beforeEach, describe, expect, it, vi } from 'vitest';", "import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';")],
    ['whitespace and comment edits only', sub("    const u = createUser('ann');\n    expect(u.name).toBe('ann');", "    // the name is kept verbatim\n    const u = createUser( 'ann' );\n\n    expect(u.name)\n      .toBe('ann'); /* checked */")],
    ['a dropped optional semicolon', sub("    expect(u.id).toMatch(/^u_/);\n", "    expect(u.id).toMatch(/^u_/)\n")],
  ];
  for (const [name, content] of allowed) {
    it(`allows: ${name}`, async () => {
      const h = await harness();
      const v = await pre(write(content), h.ctx);
      expect(reasonOf(v), name).toBe('');
      expect(v.decision).toBe('pass');
    });
  }

  it('leaves test files the agent created during the run alone', async () => {
    const h = await harness();
    await h.ws.write('test/mine.test.ts', "it('x', () => { expect(1).toBe(2); });\n");
    expect((await pre(write("it('x', () => {});\n", 'test/mine.test.ts'), h.ctx)).decision).toBe('pass');
  });

  it('allows the shipped brownfield fixture (projects-change.json extends test/projects.test.ts)', async () => {
    const base = readFileSync(path.join(HARNESS_ROOT, 'samples/existing-api/test/projects.test.ts'), 'utf8');
    const script = readFileSync(path.join(HARNESS_ROOT, 'fixtures/scripted/projects-change.json'), 'utf8');
    expect(script).toContain('"contentFile": "projects-change/test/projects.test.ts"');
    const after = readFileSync(path.join(HARNESS_ROOT, 'fixtures/scripted/projects-change/test/projects.test.ts'), 'utf8');
    expect(weakenedCases('test/projects.test.ts', base, after)).toEqual([]);
  });
});

describe('test-preservation: pre-existing test helpers are read-only', () => {
  const HELPER = 'test/helpers.ts';

  it('blocks rewriting a helper that existed at run start, allows a new helper file', async () => {
    const h = await harness();
    h.ctx.state.initialHashes.set(HELPER, sha('export const ok = true;\n'));
    const reason = reasonOf(await pre(write('export const ok = false;\n', HELPER), h.ctx));
    expect(reason).toContain(`test-preservation: ${HELPER} is test support code that existed before this run`);
    expect((await pre(write('export const fresh = 1;\n', 'test/new-helpers.ts'), h.ctx)).decision).toBe('pass');
  });

  it('allowBreaking lifts the lock', async () => {
    const h = await harness({ task: { ...brownfieldTask(), allowBreaking: true } });
    h.ctx.state.initialHashes.set(HELPER, sha('export const ok = true;\n'));
    expect((await pre(write('export const ok = false;\n', HELPER), h.ctx)).decision).toBe('pass');
  });
});

describe('test-preservation: allowBreaking relaxes bodies only', () => {
  const breaking = (): Task => ({ ...brownfieldTask(), allowBreaking: true });

  it('allows changing existing assertions and mocks, and says why', async () => {
    const h = await harness({ task: breaking() });
    expect((await pre(write(sub("expect(u.name).toBe('ann');", "expect(u.name).toBe('ANN');")), h.ctx)).decision).toBe('pass');
    expect((await pre(write(sub('    expect(u.id).toMatch(/^u_/);\n', '')), h.ctx)).decision).toBe('pass');
  });

  it('still blocks deleting, renaming or skipping an existing case', async () => {
    const h = await harness({ task: breaking() });
    for (const content of [
      sub("it('rejects an empty name'", "it('rejects a blank name'"),
      sub("it('rejects an empty name'", "it.skip('rejects an empty name'"),
      sub("  it('is short', () => expect(createUser('b').name).toHaveLength(1));\n", ''),
    ]) {
      const reason = reasonOf(await pre(write(content), h.ctx));
      expect(reason).toContain('test-preservation');
      expect(reason).toContain('allowBreaking');
    }
  });

  it('greenfield tasks never get the relaxation', async () => {
    const h = await harness({ task: greenfieldTask() });
    expect((await pre(write(sub("expect(u.name).toBe('ann');", "expect(u.name).toBe('ANN');")), h.ctx)).decision).toBe('block');
  });
});

describe('test-preservation: the run-start content is the authority', () => {
  it('uses the cached run-start copy after the file changed on disk', async () => {
    const h = await harness();
    const appended = `${EXISTING}// note\n`;
    expect((await pre(write(appended), h.ctx)).decision).toBe('pass'); // first sight: cached
    await h.ws.write(FILE, "it('gutted', () => {});\n"); // changed by other means (e.g. test code)
    const gutted = sub("    expect(u.name).toBe('ann');\n", '');
    expect(reasonOf(await pre(write(gutted), h.ctx))).toContain('"users > creates a user"');
  });

  it('recovers the run-start content from the base commit when the file was changed before the first write', async () => {
    const h = await harness();
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', h.dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('add', 'api');
    git('commit', '-q', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD').trim();
    const ctx: RunContext = { ...h.ctx, run: { ...h.ctx.run, baseSha } };
    writeFileSync(path.join(h.ws.root, FILE), "it('gutted', () => {});\n"); // out-of-band change, no write tool
    expect(reasonOf(await pre(write("it('gutted', () => {});\n"), ctx))).toContain('would be removed or renamed');
    expect((await pre(write(`${EXISTING}// restored\n`), ctx)).decision).toBe('pass');
  });

  it('fails closed when the run-start content cannot be recovered', async () => {
    const h = await harness();
    await h.ws.write(FILE, "it('gutted', () => {});\n");
    const reason = reasonOf(await pre(write(EXISTING), h.ctx));
    expect(reason).toContain('run-start content cannot be recovered');
  });
});

describe('testBlocks', () => {
  it('normalises comments and whitespace and keys hooks by their describe path', () => {
    const blocks = testBlocks(FILE, EXISTING);
    expect(blocks.map((b) => `${b.kind}:${b.key}`)).toEqual([
      'hook:beforeEach',
      'suite:users',
      'case:users > creates a user',
      'case:users > rejects an empty name',
      'case:users > is short',
    ]);
    const created = blocks.find((b) => b.key === 'users > creates a user');
    expect(created?.display.body).toEqual(["const u = createUser('ann');", "expect(u.name).toBe('ann');", 'expect(u.id).toMatch(/^u_/);']);
    expect(created?.body[1]).toBe("expect ( u . name ) . toBe ( 'ann' )");
    // Whitespace inside a string literal is content, not layout.
    const spaced = testBlocks(FILE, EXISTING.replace("toBe('ann')", "toBe('an n')")).find((b) => b.key === 'users > creates a user');
    expect(spaced?.body[1]).not.toBe(created?.body[1]);
  });
});
