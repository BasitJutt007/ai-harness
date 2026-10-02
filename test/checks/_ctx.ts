/**
 * Test helper: a CheckContext for a fixture API, built with the core's own
 * createCheckContext (same file lists and forced-strict program as `harness check`).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import type { CheckContext, CheckFinding, CheckPlugin, LogStore } from '../../src/core/plugin-api.ts';

export const FIXTURES = join(HARNESS_ROOT, 'test', 'fixtures', 'apis');

export function memoryLogs(): LogStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    write(name: string, content: string): Promise<string> {
      entries.set(name, content);
      return Promise.resolve(`(memory)/${name}`);
    },
  };
}

export function contextFor(root: string): Promise<CheckContext> {
  return createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
}

const contexts = new Map<string, Promise<CheckContext>>();
const results = new Map<string, Promise<CheckFinding[]>>();

/** Cached per fixture (one program per fixture per test file). */
export function fixtureContext(name: string): Promise<CheckContext> {
  let ctx = contexts.get(name);
  if (ctx === undefined) {
    ctx = contextFor(join(FIXTURES, name));
    contexts.set(name, ctx);
  }
  return ctx;
}

/** Cached findings of one check on one fixture. */
export function runCheck(check: CheckPlugin, fixture: string): Promise<CheckFinding[]> {
  const key = `${check.id}|${fixture}`;
  let r = results.get(key);
  if (r === undefined) {
    r = fixtureContext(fixture).then((ctx) => check.run(ctx));
    results.set(key, r);
  }
  return r;
}

/** 1-based line of the first line in a fixture file containing `needle`. */
export function lineOf(fixture: string, file: string, needle: string): number {
  const lines = readFileSync(join(FIXTURES, fixture, file), 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`"${needle}" not found in ${fixture}/${file}`);
  return i + 1;
}

export function violationLines(findings: CheckFinding[], file: string): number[] {
  return findings
    .flatMap((f) => f.violations)
    .filter((v) => v.location.startsWith(`${file}:`))
    .map((v) => Number(v.location.split(':')[1]));
}

export function totals(findings: CheckFinding[]): { passed: number; total: number } {
  return findings.reduce((a, f) => ({ passed: a.passed + f.units.passed, total: a.total + f.units.total }), { passed: 0, total: 0 });
}

/** 1-based line of the first line containing `needle` after the first line containing `anchor`. */
export function lineOfAfter(fixture: string, file: string, anchor: string, needle: string): number {
  const start = lineOf(fixture, file, anchor);
  const lines = readFileSync(join(FIXTURES, fixture, file), 'utf8').split('\n');
  const i = lines.findIndex((l, idx) => idx >= start - 1 && l.includes(needle));
  if (i < 0) throw new Error(`"${needle}" not found after "${anchor}" in ${fixture}/${file}`);
  return i + 1;
}

/**
 * A throwaway API inside the repo (so node_modules resolve), with the good fixture's
 * package.json/tsconfig.json and (optionally) its src/lib. Returns the absolute root.
 */
export async function tempApi(files: Record<string, string>, opts: { withLib?: boolean } = {}): Promise<string> {
  const root = join(HARNESS_ROOT, '.harness', 'tmp', `checks-${process.pid}-${randomBytes(5).toString('hex')}`);
  await mkdir(join(root, 'src'), { recursive: true });
  const good = join(FIXTURES, 'good');
  await cp(join(good, 'package.json'), join(root, 'package.json'));
  await cp(join(good, 'tsconfig.json'), join(root, 'tsconfig.json'));
  if (opts.withLib === true) await cp(join(good, 'src', 'lib'), join(root, 'src', 'lib'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content, 'utf8');
  }
  return root;
}

export async function removeTempApi(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
