/**
 * Deterministic services the core offers plugins (tools, hooks, gates).
 * runTests is the ONLY source of test observations ("observed red").
 */
import { runChecks } from './checks.ts';
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
  };
}
