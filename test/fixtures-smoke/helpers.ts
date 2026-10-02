/**
 * Helpers for the fixture smoke tests: temp copies inside the repo (so node_modules
 * resolve from the harness root), and child vitest / tsc runs with a clean env.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { providerVocabulary } from '../../src/core/cli.ts';
import { safeEnv } from '../../src/core/exec.ts';

export const ROOT = HARNESS_ROOT;

/** Provider terms as the harness derives them from plugins/drivers (never hard-coded outside drivers). */
export function providerTerms(): string[] {
  const terms = providerVocabulary(ROOT).terms;
  if (terms.length === 0) throw new Error('no provider vocabulary: plugins/drivers is empty?');
  return terms;
}

/** Provider terms found in `text` (case-insensitive). */
export function providerHits(text: string): string[] {
  const lower = text.toLowerCase();
  return providerTerms().filter((t) => lower.includes(t));
}

export function repoTmp(label: string): { dir: string; cleanup: () => void } {
  const dir = join(ROOT, '.harness', 'tmp', `fixtures-smoke-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function copyInto(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes('node_modules') });
}

/** Env for a nested runner: credentials stripped (safeEnv), no leaked state from the parent vitest. */
function childEnv(): NodeJS.ProcessEnv {
  const env = safeEnv({ NO_COLOR: '1', FORCE_COLOR: '0' });
  for (const k of Object.keys(env)) {
    if (/^(__)?VITEST/i.test(k) || k === 'TEST' || k === 'NODE_ENV') delete env[k];
  }
  return env;
}

export function run(binName: string, args: string[], cwd: string): { code: number | null; output: string } {
  const res = spawnSync(join(ROOT, 'node_modules', '.bin', binName), args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 110_000,
  });
  return { code: res.status, output: `${res.stdout}\n${res.stderr}` };
}

export function tsc(apiRoot: string): { code: number | null; output: string } {
  return run('tsc', ['--noEmit', '-p', join(apiRoot, 'tsconfig.json')], apiRoot);
}

const VitestReportSchema = z.object({
  numTotalTests: z.number(),
  numFailedTests: z.number(),
  numPassedTests: z.number(),
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string(),
      assertionResults: z.array(z.object({ status: z.string() })),
    }),
  ),
});
export type VitestSummary = z.infer<typeof VitestReportSchema> & { output: string };

/** Run vitest in `apiRoot` (optionally on some files) and return the parsed JSON report. */
export function vitest(apiRoot: string, files: string[] = []): VitestSummary {
  const tmp = repoTmp('vitest-report');
  try {
    const out = join(tmp.dir, 'report.json');
    const res = run('vitest', ['run', '--root', apiRoot, '--reporter=json', `--outputFile=${out}`, ...files], apiRoot);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      throw new Error(`vitest wrote no report in ${apiRoot}:\n${res.output}`);
    }
    return { ...VitestReportSchema.parse(json), output: res.output };
  } finally {
    tmp.cleanup();
  }
}

/** Every file under `dir` (POSIX, relative to `dir`), skipping node_modules. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules') continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  visit(dir);
  return out.sort();
}
