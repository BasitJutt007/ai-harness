/**
 * The read side of isolation, against the real mechanism: confined code reads its own tree, every
 * node_modules on the way up (a symlinked one under both spellings), the harness runtime files and the
 * node install, and nothing else of the operator's machine: not the harness's .git, runs/ or sources,
 * not a sibling checkout. tsc, which follows the agent's tsconfig and imports, runs under the same fence.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tscStrict from '../../plugins/checks/tsc-strict.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import type { Exec, ExecOptions, LogStore } from '../../src/core/types.ts';
import { layout, type Layout } from './helpers.ts';

const mechanism = detectMechanism();
const blocked = process.platform === 'darwin' ? 'EPERM' : 'ENOENT';
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
  // A "secret" next to the API: unconfined, tsc would quote it in a type error.
  writeAll(join(l.dir, 'outside-secret'), { 'config.ts': "export const token = 'sk_live_CANARY_TSC_LEAK' as const;\n" });
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
  it('reads: own tree, symlinked node_modules and workspace links (require resolves), harness runtime; never harness .git/runs/sources or a sibling checkout', async () => {
    const tmp = join(l.runTmp, 'fence-read');
    mkdirSync(tmp, { recursive: true });
    const targets = {
      ownFile: join(l.api, 'package.json'),
      linkedNm: join(l.api, 'node_modules', 'canary-pkg', 'index.js'),
      linkedNmReal: join(l.dir, 'shared-nm', 'canary-pkg', 'index.js'),
      harnessNm: join(HARNESS_ROOT, 'node_modules', 'zod', 'package.json'),
      probeRuntime: join(HARNESS_ROOT, 'plugins', 'lib', 'probe-runtime.ts'),
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

  it('tsc-strict runs tsc confined: the API, its symlinked node_modules and the TypeScript libs resolve; a file outside the API does not', async () => {
    const api = join(l.dir, 'tsc-api');
    writeAll(api, {
      'package.json': JSON.stringify({ name: 'tsc-fence', type: 'module', private: true }),
      'tsconfig.json': JSON.stringify({
        // incremental: the build info must go to tsc's scratch dir (the API is read-only to it)
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, incremental: true, skipLibCheck: true, types: ['node'] },
        include: ['src/**/*.ts'],
      }),
      'src/ok.ts': "import { value } from 'canary-pkg';\nimport { join } from 'node:path';\nexport const v: string = join(value, 'x');\n",
      'src/leak.ts': "import { token } from '../../outside-secret/config.js';\nexport const n: number = token;\n",
    });
    symlinkSync(join(l.dir, 'shared-nm'), join(api, 'node_modules'), 'dir');
    const calls: ExecOptions[] = [];
    const spy: Exec = (cmd, args, opts) => {
      calls.push(opts);
      return exec(cmd, args, opts);
    };
    const logs = memoryLogs();
    const ctx = await createCheckContext({ root: api, exec: spy, harnessRoot: HARNESS_ROOT, logs });
    const findings = await tscStrict.run(ctx);
    const tscCall = calls.find((o) => o.timeoutMs === 180_000);
    expect(tscCall?.sandbox).toMatchObject({ network: 'none' });
    expect(tscCall?.sandbox?.writable).toHaveLength(1);
    const output = logs.entries.get('tsc-strict.txt') ?? '';
    expect(output).not.toContain('CANARY_TSC_LEAK');
    const leak = findings.find((f) => f.file === 'src/leak.ts');
    expect(leak?.violations.map((v) => v.message.split(':')[0])).toEqual(['TS2307']);
    // canary-pkg (symlinked node_modules), node:path (@types/node up the tree) and lib.es2022 all resolved,
    // and the incremental build info did not fail on the read-only API root
    expect(findings.find((f) => f.file === 'src/ok.ts')).toBeUndefined();
    expect(findings.find((f) => f.file === '(project)')?.violations).toEqual([]);
    expect(existsSync(join(api, 'tsconfig.tsbuildinfo'))).toBe(false);
  }, 120_000);
});
