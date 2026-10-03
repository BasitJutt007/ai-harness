/**
 * Helpers for the extensibility suite: temp dirs inside the repo (node_modules resolve),
 * a drop-in plugin dir whose lib/ mirrors the real plugins/lib, a src/core fingerprint,
 * and a minimal RunContext for running a dropped-in tool.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { newRunState } from '../../src/core/run-store.ts';
import type { Exec, HarnessConfig, LogStore, RegistryView, RunContext, Task } from '../../src/core/types.ts';
import { createWorkspace } from '../../src/core/workspace.ts';

export const EXAMPLES = join(HARNESS_ROOT, 'examples', 'plugins');
export const ORM_FIXTURE = join(HARNESS_ROOT, 'test', 'fixtures', 'orm');
export const SAMPLE_API = join(HARNESS_ROOT, 'samples', 'existing-api');

/** A unique directory under .harness/tmp (gitignored, inside the repo so node_modules resolve). */
export function repoTmp(label: string): { dir: string; cleanup: () => void } {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `extensibility-${label}-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A plugin directory laid out like plugins/: <dir>/lib/*.ts re-export the real plugins/lib
 * modules, so an example copied to <dir>/<kind>/ resolves '../lib/x.ts' exactly as it would
 * inside plugins/<kind>/.
 */
export function dropInDir(dir: string): string {
  const pdir = join(dir, 'plugins');
  mkdirSync(join(pdir, 'lib'), { recursive: true });
  for (const lib of ['plugin-helpers.ts', 'contract.ts']) {
    const target = join(HARNESS_ROOT, 'plugins', 'lib', lib);
    writeFileSync(join(pdir, 'lib', lib), `export * from ${JSON.stringify(target)};\n`);
  }
  return pdir;
}

/**
 * A mirror of the live plugin directories under `<dir>/live-<i>/`, every file symlinked to
 * its original, MINUS the files in `exclude` (absolute paths). `<dir>/src` → the real src
 * and each mirror's lib/ → the real lib, so '../../src/core/…' and '../lib/…' resolve exactly
 * as they do from plugins/<kind>/. Lets a test start from "the live plugins, without the
 * ones I am about to drop in", whatever else someone has added to plugins/.
 */
export function mirrorPluginDirs(dir: string, config: HarnessConfig, exclude: ReadonlySet<string>): string[] {
  const src = join(dir, 'src');
  if (!existsSync(src)) symlinkSync(join(HARNESS_ROOT, 'src'), src, 'dir');
  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      const abs = join(from, e.name);
      if (e.name === 'lib' && e.isDirectory()) symlinkSync(abs, join(to, e.name), 'dir');
      else if (e.isDirectory()) copy(abs, join(to, e.name));
      else if (!exclude.has(abs)) symlinkSync(abs, join(to, e.name), 'file');
    }
  };
  return config.pluginDirs.map((d, i) => {
    const from = isAbsolute(d) ? d : join(HARNESS_ROOT, d);
    const to = join(dir, `live-${String(i)}`);
    if (existsSync(from) && statSync(from).isDirectory()) copy(from, to);
    else mkdirSync(to, { recursive: true });
    return to;
  });
}

/** Copy examples/plugins/<rel> to <pluginDir>/<rel> (the grader's "drop a file in"). */
export function dropIn(pluginDir: string, rel: string): string {
  const dest = join(pluginDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(EXAMPLES, rel), dest);
  return dest;
}

/** sha256 over every file under src/core (path + bytes, sorted). */
export function coreFingerprint(): string {
  const h = createHash('sha256');
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) h.update(`${rel}${e.name}\0`).update(readFileSync(join(dir, e.name)));
    }
  };
  walk(join(HARNESS_ROOT, 'src', 'core'), 'src/core/');
  return h.digest('hex');
}

export function memoryLogs(): LogStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    write(name: string, content: string): Promise<string> {
      files.set(name, content);
      return Promise.resolve(`(memory)/${basename(name)}`);
    },
  };
}

/** exec with git isolated from the user's global/system config (no signing, no hooks). */
export const isolatedExec: Exec = (cmd, args, opts) =>
  exec(cmd, args, { ...opts, env: { ...process.env, ...opts.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await isolatedExec('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export const BROWNFIELD: Task = {
  kind: 'brownfield', id: 'ext-test', title: 'Extensibility test', behaviours: [],
  limits: { maxTurns: 5, maxOutputTokens: 1000 }, target: 'api', change: 'x',
  scope: { allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] }, allowBreaking: false,
};

/** A RunContext over <repoRoot>/<rootRel> with no services (tools that need them fail loudly). */
export function makeCtx(opts: { repoRoot: string; rootRel: string; baseSha: string; registry?: RegistryView }): RunContext {
  const fail = (): Promise<never> => Promise.reject(new Error('not available in this test'));
  return {
    run: {
      id: 'ext-test-scripted-20261002-120000', driver: 'scripted', model: 'none', startedAt: new Date().toISOString(),
      harnessRoot: HARNESS_ROOT, runDir: join(opts.repoRoot, 'no-run-dir'), branch: 'harness/ext-test', baseBranch: 'main', baseSha: opts.baseSha,
    },
    task: BROWNFIELD,
    workspace: createWorkspace(opts.repoRoot, opts.rootRel),
    state: newRunState(),
    logs: memoryLogs(),
    mode: { jit: true, compactReturns: true, compactHistory: true },
    config: loadConfig(),
    exec: isolatedExec,
    services: { runTests: fail, runChecks: fail, testMap: fail, runTestsReverted: fail },
    registry: opts.registry ?? { drivers: [], tools: [], hooks: [], gates: [], checks: [], errors: [] },
    emit: () => undefined,
  };
}

/** 1-based line numbers of the lines containing `marker` in a fixture file. */
export function markerLines(file: string, marker: string): number[] {
  return readFileSync(file, 'utf8').split('\n').flatMap((l, i) => (l.includes(marker) ? [i + 1] : []));
}
