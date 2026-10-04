/**
 * The read fence of the TypeScript programs the harness builds in-process (src/core/ts-fence.ts): every
 * builder over agent-controlled code (the type check behind ctx.program() and tsc-strict, Contract Lock's
 * program and its tsconfig read) sees the API's tree, its node_modules (link and real spellings, workspace
 * links included) and the TypeScript libs, and nothing else. Each vector below names an outside "secret";
 * the control proves an unfenced program quotes it in a type error, so a fence regression cannot pass.
 */
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCompilerOptions, apiSourceFiles, createApiProgram } from '../../plugins/lib/contract.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { createTsFence, fenceRoots, typescriptLibDir } from '../../src/core/ts-fence.ts';
import { createTypecheck } from '../../src/core/typecheck.ts';
import type { LogStore } from '../../src/core/types.ts';

const CANARY = 'sk_live_CANARY_TS_FENCE';
const dir = join(HARNESS_ROOT, '.harness', 'tmp', `ts-fence-${process.pid}-${randomBytes(4).toString('hex')}`);
const outside = join(dir, 'outside');
const store = join(dir, 'store');
const COMPILER = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: [] };
const logs: LogStore = { write: (name) => Promise.resolve(`(memory)/${name}`) };

function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

beforeAll(() => {
  writeAll(outside, {
    'secret.ts': `export const token = '${CANARY}' as const;\n`,
    'ambient.d.ts': `declare const leakedToken: '${CANARY}';\n`,
    'types/leak/index.d.ts': `declare const leakedToken: '${CANARY}';\n`,
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true, allowUnreachableCode: true }, files: ['./ambient.d.ts'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { composite: true }, files: ['./ambient.d.ts'] }),
  });
  // A package store outside the API linked in as its node_modules, with a workspace package linked into it.
  writeAll(store, {
    'fence-pkg/package.json': JSON.stringify({ name: 'fence-pkg', version: '1.0.0', types: 'index.d.ts' }),
    'fence-pkg/index.d.ts': 'export declare const value: string;\n',
  });
  writeAll(join(dir, 'packages', 'wslib'), {
    'package.json': JSON.stringify({ name: '@ws/lib', version: '1.0.0', types: 'index.d.ts' }),
    'index.d.ts': 'export declare const libName: string;\n',
  });
  mkdirSync(join(store, '@ws'), { recursive: true });
  symlinkSync(join(dir, 'packages', 'wslib'), join(store, '@ws', 'lib'), 'dir');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let apis = 0;
/** An API next to `outside`, its node_modules a link to the shared store. */
function api(files: Record<string, string>, links: Record<string, string> = {}): string {
  const root = join(dir, `api-${++apis}`);
  writeAll(root, { 'package.json': JSON.stringify({ name: `api-${apis}`, type: 'module', private: true }), ...files });
  symlinkSync(store, join(root, 'node_modules'), 'dir');
  for (const [at, target] of Object.entries(links)) symlinkSync(target, join(root, at));
  return root;
}

const USE_GLOBAL = { 'src/use.ts': "export const n: 'probe' = leakedToken;\n" };
const INCLUDE_SRC = { include: ['src/**/*.ts'] };

/** Every way the agent's config or code can name a file outside the API's tree. */
const VECTORS: Array<{ name: string; files: Record<string, string>; links?: Record<string, string> }> = [
  { name: 'relative import', files: { 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, ...INCLUDE_SRC }), 'src/use.ts': "import { token } from '../../outside/secret.js';\nexport const n: 'probe' = token;\n" } },
  {
    name: 'tsconfig paths',
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER, paths: { 'secret-alias': ['../outside/secret.ts'] } }, ...INCLUDE_SRC }),
      'src/use.ts': "import { token } from 'secret-alias';\nexport const n: 'probe' = token;\n",
    },
  },
  { name: 'extends', files: { 'tsconfig.json': JSON.stringify({ extends: '../outside/tsconfig.base.json', compilerOptions: COMPILER }), ...USE_GLOBAL } },
  { name: 'files', files: { 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, files: ['../outside/ambient.d.ts', 'src/use.ts'] }), ...USE_GLOBAL } },
  { name: 'include', files: { 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, include: ['src/**/*.ts', '../outside/*.d.ts'] }), ...USE_GLOBAL } },
  { name: 'typeRoots', files: { 'tsconfig.json': JSON.stringify({ compilerOptions: { ...COMPILER, typeRoots: ['../outside/types'], types: ['leak'] }, ...INCLUDE_SRC }), ...USE_GLOBAL } },
  {
    name: 'triple-slash reference',
    files: { 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, ...INCLUDE_SRC }), 'src/use.ts': `/// <reference path="../../outside/ambient.d.ts" />\n${USE_GLOBAL['src/use.ts']}` },
  },
  {
    name: 'symlink inside the API',
    files: { 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, ...INCLUDE_SRC }), 'src/use.ts': "import { token } from './linked.js';\nexport const n: 'probe' = token;\n" },
    links: { 'src/linked.ts': join(outside, 'secret.ts') },
  },
];

function diagnosticsText(program: ts.Program): string {
  return [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...ts.getPreEmitDiagnostics(program)]
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join('\n');
}

/** Whether any file the program loaded holds the canary (wherever it was read from). */
function loadedCanary(program: ts.Program): boolean {
  return program.getSourceFiles().some((sf) => sf.text.includes(CANARY));
}

/** The program the harness used to build: ts.sys, no fence. */
function unfenced(root: string): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  const roots = new Set([...(parsed?.fileNames ?? []), join(root, 'src', 'use.ts')]);
  return ts.createProgram({ rootNames: [...roots], options: parsed?.options ?? {} });
}

describe.each(VECTORS)('a file outside the API named by $name', ({ files, links }) => {
  let root: string;
  beforeAll(() => {
    root = api(files, links);
  });

  it('control: an unfenced program reads it and quotes the secret in a type error', () => {
    const program = unfenced(root);
    expect(diagnosticsText(program)).toContain(CANARY);
  });

  it('the type check (tsc-strict, ctx.program()) never reads it; nothing it reports quotes it', async () => {
    const tc = createTypecheck(root);
    const result = tc.result();
    expect(JSON.stringify({ errors: result.errors, problems: result.problems, log: result.log })).not.toContain(CANARY);
    expect(loadedCanary(tc.primary())).toBe(false);
    expect(tc.fence.refused().some(leadsOutside)).toBe(true);
    // Either the code does not compile without it, or the configuration is unusable: never a pass.
    expect(result.errors.length > 0 || result.problems.length > 0).toBe(true);
    const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
    expect(loadedCanary(ctx.program())).toBe(false);
    expect(diagnosticsText(ctx.program())).not.toContain(CANARY);
  });

  it("Contract Lock's program and its tsconfig read never read it", async () => {
    const program = createApiProgram(root, await apiSourceFiles(root));
    expect(loadedCanary(program)).toBe(false);
    expect(diagnosticsText(program)).not.toContain(CANARY);
  });
});

/** A path in the outside tree, or one that leads there through a link. */
function leadsOutside(p: string): boolean {
  return p.startsWith(outside) || realpathSync(p).startsWith(realpathSync(outside));
}

describe('the fence itself', () => {
  let root: string;
  beforeAll(() => {
    root = api(
      {
        'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, ...INCLUDE_SRC }),
        'src/ok.ts': "import { value } from 'fence-pkg';\nimport { libName } from '@ws/lib';\nexport const v: string = `${value}${libName}`.trim();\n",
        'src/inner.ts': 'export const inner = 1;\n',
      },
      { 'src/inner-link.ts': 'inner.ts', 'out-link': outside },
    );
  });

  it('allows the API, its node_modules under both spellings (workspace links too) and the TypeScript libs; nothing else', () => {
    const f = createTsFence(root);
    expect(f.allows(join(root, 'src', 'ok.ts'))).toBe(true);
    expect(f.allows(join(root, 'src', 'inner-link.ts'))).toBe(true); // a link that stays inside
    expect(f.allows(join(root, 'node_modules', 'fence-pkg', 'index.d.ts'))).toBe(true);
    expect(f.allows(join(store, 'fence-pkg', 'index.d.ts'))).toBe(true);
    expect(f.allows(join(realpathSync(store), 'fence-pkg', 'index.d.ts'))).toBe(true);
    expect(f.allows(join(root, 'node_modules', '@ws', 'lib', 'index.d.ts'))).toBe(true);
    expect(f.allows(join(dir, 'packages', 'wslib', 'index.d.ts'))).toBe(true);
    expect(f.allows(join(typescriptLibDir(), 'lib.es2022.d.ts'))).toBe(true);
    for (const p of [join(outside, 'secret.ts'), join(root, 'out-link', 'secret.ts'), join(root, 'out-link'), dir, join(dir, 'packages'), HARNESS_ROOT, join(HARNESS_ROOT, 'src', 'core', 'exec.ts')]) {
      expect(f.allows(p), p).toBe(false);
    }
  });

  it('a refused path does not exist for the host: no read, no listing, no realpath; ancestors may only be tested for existence', () => {
    const f = createTsFence(root);
    const secret = join(outside, 'secret.ts');
    expect(f.host.fileExists(secret)).toBe(false);
    expect(f.host.readFile(secret)).toBeUndefined();
    expect(f.host.readFile(join(root, 'out-link', 'secret.ts'))).toBeUndefined();
    expect(f.host.directoryExists(outside)).toBe(false);
    expect(f.host.getDirectories(dir)).toEqual([]);
    expect(f.host.getDirectories(root)).not.toContain('out-link');
    expect(f.host.readDirectory(dir, ['.ts'], undefined, ['**/*'])).toEqual([]);
    expect(f.host.readDirectory(root, ['.ts', '.d.ts'], ['node_modules'], ['**/*', '../outside/**/*']).map((p) => relative(root, p)).sort()).toEqual(['src/inner-link.ts', 'src/inner.ts', 'src/ok.ts']);
    expect(f.host.realpath(join(root, 'out-link'))).toBe(join(root, 'out-link'));
    expect(f.refused()).toEqual(expect.arrayContaining([secret, join(root, 'out-link', 'secret.ts'), dir]));
    // An ancestor of the API may be tested for existence (the compiler probes them), and that is no refusal.
    const g = createTsFence(root);
    expect(g.host.directoryExists(dir)).toBe(true);
    expect(g.refused()).toEqual([]);
  });

  it('a program over the fence resolves the API, its linked packages and the libs, and never writes', () => {
    const f = createTsFence(root);
    const program = f.createProgram([join(root, 'src', 'ok.ts')], { ...ts.getDefaultCompilerOptions(), strict: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, types: [] });
    expect(diagnosticsText(program)).toBe('');
    const loaded = program.getSourceFiles().map((sf) => sf.fileName);
    expect(loaded.some((p) => p.endsWith('fence-pkg/index.d.ts'))).toBe(true);
    expect(loaded.some((p) => p.endsWith('wslib/index.d.ts'))).toBe(true);
    expect(() => f.compilerHost({}).writeFile('x.js', '', false)).toThrow(/never writes/);
  });

  it("Contract Lock's tsconfig read does not apply an `extends` outside the API", () => {
    const root2 = api({ 'tsconfig.json': JSON.stringify({ extends: '../outside/tsconfig.base.json', compilerOptions: COMPILER }), ...USE_GLOBAL });
    const open = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root2, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root2);
    expect(open.options.allowUnreachableCode).toBe(true); // control: the outside base sets it
    expect(apiCompilerOptions(root2).allowUnreachableCode).toBeUndefined();
    expect(apiCompilerOptions(root2)).toMatchObject({ strict: true, noEmit: true, module: ts.ModuleKind.NodeNext });
  });

  it("a project reference outside the API is not read: the configuration is unusable, never a crash", () => {
    const root2 = api({ 'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, ...INCLUDE_SRC, references: [{ path: '../outside' }] }), ...USE_GLOBAL });
    const result = createTypecheck(root2).result();
    expect(result.usable).toBe(false);
    expect(result.problems.join('\n')).toMatch(/outside\/tsconfig\.json: outside the API's tree/);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("in a run's worktree the whole worktree is readable (monorepo siblings), another run's worktree is not", () => {
    const parent = join(HARNESS_ROOT, loadConfig(HARNESS_ROOT).worktreeDir);
    const run = join(parent, `ts-fence-run-${randomBytes(4).toString('hex')}`);
    const other = join(parent, `ts-fence-run-${randomBytes(4).toString('hex')}`);
    try {
      writeAll(run, { 'packages/api/src/a.ts': 'export {};\n', 'packages/shared/b.ts': 'export {};\n' });
      writeAll(other, { 'x.ts': 'export {};\n' });
      const f = createTsFence(join(run, 'packages', 'api'));
      expect(f.allows(join(run, 'packages', 'shared', 'b.ts'))).toBe(true);
      expect(f.allows(join(other, 'x.ts'))).toBe(false);
      expect(fenceRoots(join(run, 'packages', 'api')).some((r) => r === parent || r === HARNESS_ROOT)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
