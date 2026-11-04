/**
 * vite-build (react-vite; standards): the production build the team deploys (`vite build`) succeeds on
 * the changed tree, before merge: where the build only runs in a deploy workflow, a broken build is
 * otherwise found after the merge.
 *
 * The build runs the repository's vite.config (code), so it runs confined: no network, output to a temp
 * directory, nothing written into the target. UNPROVEN: no Vite in the repository, or a build that times out.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding } from '../../src/core/plugin-api.ts';

const RULE = 'vite-build';
const PROJECT = '(project)';

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const vite = join(ctx.root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: "the repository's Vite is not installed (node_modules/vite)" }];
  const tmp = mkdtempSync(join(tmpdir(), 'vite-build-'));
  try {
    const out = join(tmp, 'dist');
    // --configLoader runner: load vite.config without bundling it into node_modules/.vite-temp (a write
    // outside the temp dir, which the sandbox refuses); Vite 6.1+.
    const r = await ctx.exec(process.execPath, [vite, 'build', '--configLoader', 'runner', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: ctx.root,
      timeoutMs: 900_000,
      env: { TMPDIR: tmp, CI: '1' },
      sandbox: { writable: [tmp], network: 'none' },
    });
    await ctx.logs.write('vite-build.txt', `$ vite build --outDir <tmp>  (exit ${String(r.code)})\n${r.stdout.trim()}\n${r.stderr.trim()}`);
    if (r.timedOut) return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'vite build timed out' }];
    if (r.code === 0) return [{ rule: RULE, file: PROJECT, status: 'pass', units: { passed: 1, total: 1 }, violations: [] }];
    const lines = (r.stderr || r.stdout).trim().split('\n').filter((l) => l.trim().length > 0).slice(-8);
    return [{ rule: RULE, file: PROJECT, status: 'fail', units: { passed: 0, total: 1 }, violations: lines.map((l) => ({ location: `${PROJECT}:0:0`, message: l.trim() })) }];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default defineCheck({
  id: RULE,
  stacks: ['react-vite'],
  category: 'standards',
  description: 'The production build (vite build) succeeds on the changed tree.',
  unit: 'builds',
  doc: 'vite-build: `vite build` succeeds on the changed tree (output to a temp directory). Fix what it reports in your files.',
  run,
});
