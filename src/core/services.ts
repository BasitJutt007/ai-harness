/**
 * Deterministic services the core offers plugins (tools, hooks, gates).
 * runTests is the ONLY source of test observations ("observed red").
 */
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runChecks } from './checks.ts';
import { readInitial } from './initial.ts';
import { runVitest } from './testing.ts';
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
}): CoreServices {
  const { ws, registry, state, logs, exec, harnessRoot } = opts;
  const base = opts.baseSha !== undefined && opts.baseSha !== ''
    ? { repoRoot: ws.repoRoot, rootRel: ws.rootRel, sha: opts.baseSha }
    : undefined;
  return {
    async runTests(files) {
      const report = await runVitest({
        root: ws.root,
        ...(files !== undefined && files.length > 0 ? { files } : {}),
        exec,
        harnessRoot,
        logs,
        turn: state.turn,
      });
      state.tests.push(...report.observations);
      return report;
    },
    async runChecks(o) {
      return runChecks({
        root: ws.root,
        checks: registry.checks.map((r) => r.plugin),
        exec,
        harnessRoot,
        logs,
        ...(opts.taskKind !== undefined ? { taskKind: opts.taskKind } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(o?.categories !== undefined ? { categories: o.categories } : {}),
        ...(o?.rules !== undefined ? { rules: o.rules } : {}),
      });
    },
    async testMap() {
      return buildTestMap(ws);
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
      // A scratch copy under the harness's own tmp dir (node_modules resolves as for the worktree); the
      // confined runner can only read it.
      const copy = join(harnessRoot, '.harness', 'tmp', `revert-${process.pid}-${randomBytes(4).toString('hex')}`);
      try {
        for (const rel of await ws.list(['**/*'])) {
          if (overrides.has(rel)) continue;
          const content = await ws.read(rel);
          if (content !== null) await put(copy, rel, content);
        }
        for (const [rel, content] of overrides) if (content !== null) await put(copy, rel, content);
        for (const nm of [join(ws.root, 'node_modules'), join(ws.repoRoot, 'node_modules')]) {
          if (existsSync(nm)) {
            symlinkSync(nm, join(copy, 'node_modules'), 'dir');
            break;
          }
        }
        return await runVitest({ root: copy, files, exec, harnessRoot, logs, turn: state.turn });
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
    },
  };
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}
