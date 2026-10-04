/**
 * dependency-policy: nothing can be installed during a run, so an import of a package the API
 * neither declares nor has installed is refused on the FIRST write that adds it (instead of
 * surfacing turns later as a failing test run or type check), with what is available.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import dependencyPolicy from '../../plugins/hooks/dependency-policy.ts';
import { isBare, packageOf } from '../../plugins/lib/dependencies.ts';
import appendFile from '../../plugins/tools/append_file.ts';
import editFile from '../../plugins/tools/edit_file.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import { defineTool } from '../../src/core/plugin-api.ts';
import type { HookVerdict, RunContext, ToolCallInfo } from '../../src/core/plugin-api.ts';
import { systemPrompt } from '../../src/core/prompt.ts';
import { greenfieldTask, callInfo, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

/** zod/express/vitest are installed for the harness (its node_modules is an ancestor of the temp API); not-installed-pkg is declared only. */
const PACKAGE = JSON.stringify({
  name: 'orders-api',
  dependencies: { express: '5.2.1', zod: '4.6.5', 'not-installed-pkg': '1.0.0' },
  devDependencies: { vitest: '5.0.3', supertest: '7.3.1', '@types/node': '26.6.4' },
});

async function harness(files: Record<string, string> = {}) {
  const h = await makeHarness({ label: 'deps', files: { 'package.json': PACKAGE, ...files } });
  dirs.push(h.dir);
  return h;
}

const run = (c: ToolCallInfo, ctx: RunContext): Promise<HookVerdict> => dependencyPolicy.run({ event: 'pre_tool', call: c }, ctx);
const reasonOf = (v: HookVerdict): string => (v.decision === 'block' ? v.reason : '');
const write = (p: string, content: string): ToolCallInfo => callInfo(writeFile, { path: p, content });

describe('dependency-policy: unknown packages are refused on the first write', () => {
  const random = (): string => `pkg-${randomUUID().slice(0, 8)}`;
  const blocked: Array<[string, string, string]> = [
    ['random package', 'src/a.ts', `import x from '${random()}';\nexport const a = x;\n`],
    ['random scoped package with a subpath', 'src/a.ts', `import { y } from '@${random()}/core/sub';\nexport const a = y;\n`],
    ['export-from', 'src/a.ts', `export * from '${random()}';\n`],
    ['dynamic import', 'src/a.ts', `export const load = () => import('${random()}');\n`],
    ['require', 'src/a.cts', `const m = require('${random()}');\nexport = m;\n`],
    ['import-equals', 'src/a.ts', `import m = require('${random()}');\nexport const a = m;\n`],
    ['vi.mock of a package in a test', 'test/a.test.ts', `import { vi } from 'vitest';\nvi.mock('${random()}');\n`],
    ['a test helper library that is not installed', 'test/a.test.ts', "import { expect } from 'chai-but-not-installed';\nexpect(1);\n"],
    ['declared but not installed', 'src/a.ts', "import n from 'not-installed-pkg';\nexport const a = n;\n"],
    ['not a Node builtin', 'src/a.ts', "import x from 'node:nonexistent';\nexport const a = x;\n"],
  ];
  for (const [name, file, content] of blocked) {
    it(`blocks: ${name}`, async () => {
      const h = await harness();
      const reason = reasonOf(await run(write(file, content), h.ctx));
      expect(reason, name).toContain('dependency-policy');
      expect(reason).toContain('dependencies cannot be added in this run');
      expect(reason).toMatch(/available: express, supertest, vitest, zod, node: builtins/);
    });
  }

  it('says when a package is installed (e.g. hoisted) but not declared by the API', async () => {
    const h = await harness();
    const reason = reasonOf(await run(write('src/a.ts', "import { glob } from 'tinyglobby';\nexport const g = glob;\n"), h.ctx));
    expect(reason).toContain('package tinyglobby is not declared in the API\'s package.json');
    const missing = reasonOf(await run(write('src/a.ts', "import l from 'left-pad-not-here';\nexport const g = l;\n"), h.ctx));
    expect(missing).toContain('package left-pad-not-here is not installed and dependencies cannot be added in this run');
  });

  it('judges edit_file and append_file by the post-image too', async () => {
    const h = await harness({ 'src/a.ts': "import { z } from 'zod';\nexport const a = z.string();\n" });
    const edit = callInfo(editFile, { path: 'src/a.ts', find: "import { z } from 'zod';", replace: "import { z } from 'zod';\nimport dayjs from 'dayjs-not-installed';" }, h.ctx.workspace);
    expect(reasonOf(await run(edit, h.ctx))).toContain('dayjs-not-installed');
    const append = callInfo(appendFile, { path: 'src/a.ts', append: "export { v4 } from 'uuid-not-installed';\n" }, h.ctx.workspace);
    expect(reasonOf(await run(append, h.ctx))).toContain('uuid-not-installed');
  });
});

describe('dependency-policy: what the API has is allowed', () => {
  it('declared + installed packages (and subpaths, type-only imports), Node builtins and relative imports pass', async () => {
    const h = await harness();
    const ok = [
      "import { z } from 'zod';\nimport express, { type Request } from 'express';\nimport type { Response } from 'express';\nexport const s = z.string();\nexport const app = express();\nexport type R = Request | Response;\n",
      "import * as zz from 'zod/v4';\nexport const s = zz.string();\n",
      "import { randomUUID } from 'node:crypto';\nimport fs from 'fs';\nimport { setTimeout as sleep } from 'node:timers/promises';\nexport const id = randomUUID();\nexport const r = fs.readFileSync;\nexport const w = sleep;\n",
      "import { a } from './a.ts';\nimport { b } from '../lib/b.js';\nexport * from './c.ts';\nexport const x = [a, b];\n",
      "import { thing } from 'orders-api/lib/thing';\nexport const t = thing;\n",
      "import type { Item } from '#internal/types';\nexport type I = Item;\n",
    ];
    for (const content of ok) expect((await run(write('src/x.ts', content), h.ctx)).decision, content).toBe('pass');
    const test = "import request from 'supertest';\nimport { describe, expect, it } from 'vitest';\nimport { app } from '../src/x.ts';\ndescribe('x', () => { it('y', async () => { expect((await request(app).get('/')).status).toBe(200); }); });\n";
    expect((await run(write('test/x.test.ts', test), h.ctx)).decision).toBe('pass');
  });

  it('tsconfig path aliases and baseUrl-relative imports are the API\'s own modules, not packages', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '~lib': ['src/lib/index.ts'] } } });
    const h = await harness({ 'tsconfig.json': tsconfig, 'src/lib/index.ts': 'export const l = 1;\n' });
    const content = "import { a } from '@/routes/a';\nimport { l } from '~lib';\nimport { m } from 'src/lib/index';\nexport const x = [a, l, m];\n";
    expect((await run(write('src/x.ts', content), h.ctx)).decision).toBe('pass');
    // A bare name that is neither an alias nor an existing baseUrl module is still a package.
    expect(reasonOf(await run(write('src/x.ts', "import { q } from 'srcx/nothing';\nexport const x = q;\n"), h.ctx))).toContain('package srcx is not installed');
  });

  it('specifiers the file already had are left alone; non-TypeScript files are not judged', async () => {
    const legacy = "import legacy from 'legacy-not-installed';\nexport const a = legacy;\nexport const b = 1;\n";
    const h = await harness({ 'src/legacy.ts': legacy });
    const edit = callInfo(editFile, { path: 'src/legacy.ts', find: 'b = 1', replace: 'b = 2' }, h.ctx.workspace);
    expect((await run(edit, h.ctx)).decision).toBe('pass');
    expect((await run(write('docs/x.md', "import x from 'whatever';\n"), h.ctx)).decision).toBe('pass');
  });

  it('a write tool without preview() is refused for TypeScript files (fail closed)', async () => {
    const h = await harness();
    const tool = defineTool({
      name: 'put_text', description: 'Write text.', input: z.object({ path: z.string(), text: z.string() }), effect: 'write',
      paths: (i) => [i.path], run: async () => ({ ok: true, summary: '' }),
    });
    expect(reasonOf(await run(callInfo(tool, { path: 'src/x.ts', text: "import { z } from 'zod';\n" }), h.ctx))).toContain('declares no preview()');
  });

  it('packageOf / isBare', () => {
    expect(['zod', 'zod/v4', '@scope/pkg', '@scope/pkg/sub/path', 'node:fs'].map(packageOf)).toEqual(['zod', 'zod', '@scope/pkg', '@scope/pkg', 'node:fs']);
    expect(['./a', '../a', '/abs', '#internal', 'C:/x', 'zod', '@a/b'].map(isBare)).toEqual([false, false, false, false, false, true, true]);
  });

  it('the system prompt says once that no packages can be installed', () => {
    expect(systemPrompt({ task: greenfieldTask(), checks: [], tools: [] })).toContain('no packages can be installed in this run');
  });
});
