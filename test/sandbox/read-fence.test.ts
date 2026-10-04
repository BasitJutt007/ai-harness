/**
 * The read side of isolation, against the real mechanism: confined code reads its own tree, every
 * node_modules on the way up (a symlinked one under both spellings), the harness runtime files and the
 * node install, and nothing else of the operator's machine: not the harness's .git, runs/ or sources,
 * not a sibling checkout. The in-process type check (tsc-strict), which follows the agent's tsconfig and
 * imports, reads through the same allow-list: its compiler host is the fence.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tscStrict from '../../plugins/checks/tsc-strict.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import { typescriptLibDir } from '../../src/core/ts-fence.ts';
import { typecheckOf } from '../../src/core/typecheck.ts';
import type { LogStore } from '../../src/core/types.ts';
import { layout, type Layout } from './helpers.ts';

const mechanism = detectMechanism();
const blocked = process.platform === 'darwin' ? 'EPERM' : 'ENOENT';
/** The outside "secret": an unfenced type check quotes it in a type error. */
const CANARY = 'sk_live_CANARY_TSC_LEAK';
let l: Layout;

function memoryLogs(): LogStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    write: (name: string, content: string) => {
      entries.set(name, content);
      return Promise.resolve(`(memory)/${name}`);
    },
  };
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

beforeAll(() => {
  l = layout('fence');
  // A package store outside the API, linked in as the API's node_modules (what createWorktree and
  // snapshotBase do with the target repo's node_modules).
  writeAll(join(l.dir, 'shared-nm'), {
    'canary-pkg/package.json': JSON.stringify({ name: 'canary-pkg', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
    'canary-pkg/index.js': "module.exports = { value: 'resolved-through-symlink' };\n",
    'canary-pkg/index.d.ts': 'export declare const value: string;\n',
  });
  symlinkSync(join(l.dir, 'shared-nm'), join(l.api, 'node_modules'), 'dir');
  // A workspace package: node_modules/@ws/lib links to the repo's packages/lib (outside node_modules).
  writeAll(join(l.dir, 'packages', 'lib'), {
    'package.json': JSON.stringify({ name: '@ws/lib', version: '1.0.0', main: 'index.js' }),
    'index.js': "module.exports = { name: 'workspace-lib' };\n",
  });
  mkdirSync(join(l.dir, 'shared-nm', '@ws'), { recursive: true });
  symlinkSync(join(l.dir, 'packages', 'lib'), join(l.dir, 'shared-nm', '@ws', 'lib'), 'dir');
  // A "secret" next to the API: unconfined, tsc would quote it in a type error (as an import, a global
  // declared by a `files` entry, or by the `files` of an extended config).
  writeAll(join(l.dir, 'outside-secret'), {
    'config.ts': `export const token = '${CANARY}' as const;\n`,
    'ambient.d.ts': `declare const leakedToken: '${CANARY}';\n`,
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true }, files: ['./ambient.d.ts'] }),
  });
});
afterAll(() => l.cleanup());

const READ = `
const fs = require('node:fs');
const r = {};
for (const [k, p] of Object.entries(JSON.parse(process.argv[1]))) {
  try { const s = fs.statSync(p); if (s.isDirectory()) fs.readdirSync(p); else fs.readFileSync(p); r[k] = 'ok'; } catch (e) { r[k] = e.code || String(e); }
}
try { r.pkg = require('canary-pkg').value; } catch (e) { r.pkg = e.code || String(e); }
try { r.workspace = require('@ws/lib').name; } catch (e) { r.workspace = e.code || String(e); }
process.stdout.write(JSON.stringify(r));
`;

describe.runIf(mechanism !== 'none')(`read fence under ${mechanism}`, () => {
  it('reads: own tree, symlinked node_modules and workspace links (require resolves), harness runtime files (probe, contract, node:test reporter); never harness .git/runs/sources or a sibling checkout', async () => {
    const tmp = join(l.runTmp, 'fence-read');
    mkdirSync(tmp, { recursive: true });
    const targets = {
      ownFile: join(l.api, 'package.json'),
      linkedNm: join(l.api, 'node_modules', 'canary-pkg', 'index.js'),
      linkedNmReal: join(l.dir, 'shared-nm', 'canary-pkg', 'index.js'),
      harnessNm: join(HARNESS_ROOT, 'node_modules', 'zod', 'package.json'),
      probeRuntime: join(HARNESS_ROOT, 'plugins', 'lib', 'probe-runtime.ts'),
      nodeTestReporter: join(HARNESS_ROOT, 'src', 'core', 'node-test-reporter.mjs'),
      harnessGit: join(HARNESS_ROOT, '.git'),
      harnessRuns: join(HARNESS_ROOT, 'runs'),
      harnessSource: join(HARNESS_ROOT, 'src', 'core', 'exec.ts'),
      harnessListing: HARNESS_ROOT,
      siblingCheckout: join(l.original, 'keep.txt'),
      outsideSecret: join(l.dir, 'outside-secret', 'config.ts'),
    };
    const r = await exec(process.execPath, ['-e', READ, JSON.stringify(targets)], { cwd: l.api, sandbox: { writable: [tmp], network: 'none' } });
    expect(r.sandbox).toBe(mechanism);
    expect(JSON.parse(r.stdout)).toEqual({
      ownFile: 'ok',
      linkedNm: 'ok',
      linkedNmReal: 'ok',
      harnessNm: 'ok',
      probeRuntime: 'ok',
      nodeTestReporter: 'ok',
      harnessGit: blocked,
      harnessRuns: blocked,
      harnessSource: blocked,
      harnessListing: blocked,
      siblingCheckout: blocked,
      outsideSecret: blocked,
      pkg: 'resolved-through-symlink',
      workspace: 'workspace-lib',
    });
  });

});

/**
 * tsc-strict type-checks in-process (src/core/typecheck.ts), so no OS mechanism wraps it: its compiler host
 * is the fence (src/core/ts-fence.ts), and this holds whatever the platform. Each API below names the
 * outside "secret" another way; an unfenced program quotes it in a type error (test/sandbox/ts-fence.test.ts
 * proves each vector leaks without the fence).
 */
describe('in-process fence: tsc-strict reads only the API, its node_modules and the TypeScript libs', () => {
  const COMPILER = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] };
  const outside = (): string => join(l.dir, 'outside-secret');

  async function tscStrictOver(name: string, files: Record<string, string>) {
    const api = join(l.dir, name);
    writeAll(api, { 'package.json': JSON.stringify({ name, type: 'module', private: true }), ...files });
    symlinkSync(join(l.dir, 'shared-nm'), join(api, 'node_modules'), 'dir');
    const logs = memoryLogs();
    const ctx = await createCheckContext({ root: api, exec, harnessRoot: HARNESS_ROOT, logs });
    const findings = await tscStrict.run(ctx);
    const tc = typecheckOf(ctx);
    const loaded = tc.primary().getSourceFiles().map((sf) => sf.fileName);
    // Everything that could reach the model or the run log: findings (messages, skip reasons) and logs.
    const text = `${JSON.stringify(findings)}\n${[...logs.entries.values()].join('\n')}`;
    return { api, findings, tc, loaded, text, project: findings.find((f) => f.file === '(project)') };
  }

  it('relative import and tsconfig `paths`: not resolved (TS2307), never read; the API, its symlinked node_modules and the libs resolve', async () => {
    const r = await tscStrictOver('tsc-api', {
      'tsconfig.json': JSON.stringify({
        // incremental: a program the harness builds must never write build info into the API
        compilerOptions: { ...COMPILER, incremental: true, paths: { 'secret-alias': ['../outside-secret/config.ts'] } },
        include: ['src/**/*.ts'],
      }),
      'src/ok.ts': "import { value } from 'canary-pkg';\nimport { join } from 'node:path';\nexport const v: string = join(value, 'x');\n",
      'src/leak.ts': "import { token } from '../../outside-secret/config.js';\nexport const n: 'probe' = token;\n",
      'src/alias.ts': "import { token } from 'secret-alias';\nexport const n: 'probe' = token;\n",
    });
    expect(r.text).not.toContain(CANARY);
    expect(r.findings.find((f) => f.file === 'src/leak.ts')?.violations.map((v) => v.message.split(':')[0])).toEqual(['TS2307']);
    expect(r.findings.find((f) => f.file === 'src/alias.ts')?.violations.map((v) => v.message.split(':')[0])).toEqual(['TS2307']);
    // canary-pkg (symlinked node_modules), node:path (@types/node up the tree) and lib.es2022 all resolved
    expect(r.findings.find((f) => f.file === 'src/ok.ts')).toBeUndefined();
    expect(r.project).toMatchObject({ status: 'fail', violations: [] });
    expect(r.loaded.some((f) => f.endsWith('/canary-pkg/index.d.ts'))).toBe(true);
    expect(r.loaded.some((f) => f.includes('/@types/node/'))).toBe(true);
    expect(r.loaded.some((f) => f.startsWith(typescriptLibDir()) && f.endsWith('lib.es2022.d.ts'))).toBe(true);
    // The fence was asked and refused: the outside tree was never read.
    expect(r.loaded.filter((f) => f.startsWith(outside()))).toEqual([]);
    expect(r.tc.fence.refused().some((p) => p.startsWith(outside()))).toBe(true);
    expect(existsSync(join(r.api, 'tsconfig.tsbuildinfo'))).toBe(false);
  }, 120_000);

  it('`extends` outside the API: not read; the configuration is unusable (UNPROVEN), never a crash', async () => {
    const r = await tscStrictOver('tsc-api-extends', {
      'tsconfig.json': JSON.stringify({ extends: '../outside-secret/tsconfig.base.json', compilerOptions: COMPILER }),
      'src/use.ts': "export const n: 'probe' = leakedToken;\n",
    });
    expect(r.text).not.toContain(CANARY);
    expect(r.project?.status).toBe('skip');
    expect(r.project?.skipReason).toContain('unusable TypeScript configuration: tsconfig.json');
    expect(r.project?.skipReason).toContain("outside the API's tree");
    expect(r.tc.fence.refused()).toContain(join(outside(), 'tsconfig.base.json'));
    expect(r.loaded.filter((f) => f.startsWith(outside()))).toEqual([]);
  }, 120_000);

  it('a `files` entry outside the API: not read; UNPROVEN, nothing quoted', async () => {
    const r = await tscStrictOver('tsc-api-files', {
      'tsconfig.json': JSON.stringify({ compilerOptions: COMPILER, files: ['../outside-secret/ambient.d.ts', 'src/use.ts'] }),
      'src/use.ts': "export const n: 'probe' = leakedToken;\n",
    });
    expect(r.text).not.toContain(CANARY);
    expect(r.project?.status).toBe('skip');
    expect(r.project?.skipReason).toMatch(/TS6053 File '.*outside-secret\/ambient\.d\.ts' not found/);
    expect(r.tc.fence.refused()).toContain(join(outside(), 'ambient.d.ts'));
    expect(r.loaded.filter((f) => f.startsWith(outside()))).toEqual([]);
  }, 120_000);
});
