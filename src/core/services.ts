/**
 * Deterministic services the core offers plugins (tools, hooks, gates).
 * runTests is the ONLY source of test observations ("observed red").
 *
 * With a TargetProfile (every run has one, see target.ts) tests run with the API's own runner and
 * every classification (source roots, test dirs, import resolution) follows the API's layout; it is
 * also made the active layout of the pure predicates plugins use. Without one: the harness's vitest
 * and the active layout (the template's src/ + test/ unless a run set another).
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runChecks } from './checks.ts';
import { readInitial } from './initial.ts';
import { activeLayout, linkDependencies, setActiveLayout } from './target.ts';
import type { TargetLayout, TargetProfile } from './target.ts';
import { runTargetTests } from './testing.ts';
import { buildTestMap } from './testmap.ts';
import type { CoreServices, Exec, LogStore, RegistryView, RunState, TaskKind, Workspace } from './types.ts';

export function createServices(opts: {
  ws: Workspace;
  registry: RegistryView;
  state: RunState;
  logs: LogStore;
  exec: Exec;
  harnessRoot: string;
  /** Task kind of the run (handed to checks as CheckContext.taskKind). */
  taskKind?: TaskKind;
  /** Commit the run started from (handed to checks as CheckContext.base, with the worktree root). */
  baseSha?: string;
  /** Evidence dir of the run: holds the run-start content blobs (initial.ts) runTestsReverted needs. */
  runDir?: string;
  /** The API's profile (layout, runner): computed by the run at preflight. */
  profile?: TargetProfile;
}): CoreServices {
  const { ws, registry, state, logs, exec, harnessRoot, profile } = opts;
  if (profile !== undefined) setActiveLayout(profile);
  const layout = (): TargetLayout => profile ?? activeLayout();
  const runner = profile?.runner;
  const base = opts.baseSha !== undefined && opts.baseSha !== ''
    ? { repoRoot: ws.repoRoot, rootRel: ws.rootRel, sha: opts.baseSha }
    : undefined;
  return {
    async runTests(files, o) {
      const report = await runTargetTests({
        root: ws.root,
        ...(files !== undefined && files.length > 0 ? { files } : {}),
        exec,
        harnessRoot,
        logs,
        turn: state.turn,
        ...(runner !== undefined ? { runner } : {}),
        layout: layout(),
        ...(o?.isolateFailures === true ? { isolateFailures: true } : {}),
      });
      // The run's own observations only: the isolated re-runs behind report.diagnosis yield none.
      state.tests.push(...report.observations);
      return report;
    },
    async runChecks(o) {
      return runChecks({
        root: o?.root ?? ws.root,
        checks: registry.checks.map((r) => r.plugin),
        exec,
        harnessRoot,
        logs,
        ...(profile !== undefined ? { layout: profile } : {}),
        ...(opts.taskKind !== undefined ? { taskKind: opts.taskKind } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(o?.categories !== undefined ? { categories: o.categories } : {}),
        ...(o?.rules !== undefined ? { rules: o.rules } : {}),
      });
    },
    async testMap() {
      return buildTestMap(ws, layout());
    },
    async runTestsReverted(files, revert) {
      const overrides = new Map<string, string | null>();
      for (const rel of revert) {
        const hash = state.initialHashes.get(rel);
        if (hash === undefined) {
          overrides.set(rel, null);
          continue;
        }
        const content = opts.runDir === undefined ? null : await readInitial(opts.runDir, hash);
        if (content === null) throw new Error(`run-start content of ${rel} is not available`);
        overrides.set(rel, content);
      }
      // A scratch copy under the harness's own tmp dir that mirrors the worktree's layout from its top
      // (<copy>/<rootRel>), with the same node_modules links at every level and the ancestors' package.json /
      // tsconfig files, so packages and configs resolve exactly as for the worktree; the confined runner can only read it.
      const top = join(harnessRoot, '.harness', 'tmp', `revert-${process.pid}-${randomBytes(4).toString('hex')}`);
      const copy = ws.rootRel === '.' ? top : join(top, ws.rootRel);
      try {
        for (const rel of await ws.list(['**/*'])) {
          if (overrides.has(rel)) continue;
          const content = await ws.read(rel);
          if (content !== null) await put(copy, rel, content);
        }
        for (const [rel, content] of overrides) if (content !== null) await put(copy, rel, content);
        await mkdir(copy, { recursive: true });
        copyAncestorConfigs(ws.repoRoot, ws.rootRel, top);
        linkDependencies(ws.repoRoot, ws.rootRel, top);
        return await runTargetTests({ root: copy, files, exec, harnessRoot, logs, turn: state.turn, ...(runner !== undefined ? { runner } : {}), layout: layout() });
      } finally {
        await rm(top, { recursive: true, force: true });
      }
    },
  };
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** package.json and tsconfig*.json of every directory above the API root (a base config the API's own extends). */
function copyAncestorConfigs(repoRoot: string, rootRel: string, destTop: string): void {
  if (rootRel === '.') return;
  const parts = rootRel.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const level = parts.slice(0, i).join('/');
    const src = join(repoRoot, level);
    let names: string[] = [];
    try {
      names = readdirSync(src);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name !== 'package.json' && !/^tsconfig.*\.json$/.test(name)) continue;
      const dest = join(destTop, level, name);
      if (!existsSync(dest)) copyFileSync(join(src, name), dest);
    }
  }
}
