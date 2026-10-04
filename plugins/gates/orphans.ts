/**
 * orphans: every TypeScript file the run CREATED (absent at run start) is part of the deliverable,
 * because ship commits everything under the API root:
 *   - a created test-support file (any non-runnable file under the test root) is imported, directly
 *     or through other files, by a runnable test;
 *   - a created source file is reachable through imports from a runnable test or from code that
 *     existed at run start (the app and its entry, whatever they are called).
 * Anything else is a leftover (a scratch helper, an abandoned module): finish fails and names it,
 * with the way out (delete_file). Reachability uses the harness's own import graph (testmap), plus
 * the API's tsconfig `paths` / `baseUrl` aliases resolved the way TypeScript resolves them; an alias
 * TypeScript cannot resolve makes a same-named created file UNPROVEN, never an orphan.
 */
import path from 'node:path';
import ts from 'typescript';
import { defineGate, fileCheckOptions, graphFiles, importGraph, importSpecifiers, isTestFile, isTestSupport } from '../../src/core/plugin-api.ts';
import { dependencyView } from '../lib/dependencies.ts';

/** The name an import of `p` ends with: its basename without extension (the folder name for an index file). */
function stem(p: string): string {
  const base = path.posix.basename(p).replace(/\.[cm]?[jt]s$/, '');
  return base === 'index' ? path.posix.basename(path.posix.dirname(p)) : base;
}

/** Every file reachable from `starts` (the starts included). */
function reach(starts: string[], edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set(starts);
  const queue = [...starts];
  for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
    for (const t of edges.get(f) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return seen;
}

export default defineGate({
  name: 'orphans',
  description: 'Every file the run created is used: test helpers by a test, source by a test or by code that existed at run start.',
  phases: ['finish', 'ship'],
  async run(ctx) {
    const root = ctx.workspace.root;
    let files: string[];
    const edges = new Map<string, string[]>();
    const unresolved = new Set<string>();
    try {
      files = graphFiles(await ctx.workspace.list(['**/*.ts', '**/*.mts', '**/*.cts']));
      const texts = new Map<string, string>();
      for (const f of files) texts.set(f, (await ctx.workspace.read(f)) ?? '');
      for (const [f, targets] of (await importGraph(files, async (f) => texts.get(f) ?? null)).edges) edges.set(f, [...targets]);
      // Non-relative specifiers that name the API's own modules (tsconfig paths / baseUrl, package `#imports`).
      const deps = dependencyView(root);
      let options: ts.CompilerOptions | undefined;
      for (const [f, text] of texts) {
        for (const spec of importSpecifiers(f, text)) {
          if (spec.startsWith('.') || !(spec.startsWith('#') || deps.localAlias(spec))) continue;
          options ??= fileCheckOptions(root);
          const hit = ts.resolveModuleName(spec, path.join(root, f), options, ts.sys).resolvedModule?.resolvedFileName;
          const rel = hit === undefined ? null : path.relative(root, hit).split(path.sep).join('/');
          if (rel !== null && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split('/').includes('node_modules')) {
            edges.set(f, [...(edges.get(f) ?? []), rel]);
          } else {
            unresolved.add(stem(spec));
          }
        }
      }
    } catch (e) {
      return { status: 'unproven', summary: `could not build the import graph: ${e instanceof Error ? e.message : String(e)}` };
    }
    const created = files.filter((f) => !ctx.state.initialHashes.has(f) && !isTestFile(f));
    if (created.length === 0) return { status: 'pass', summary: 'no new non-test files' };
    const fromTests = reach(files.filter(isTestFile), edges);
    const fromExisting = reach(files.filter((f) => ctx.state.initialHashes.has(f) && !isTestFile(f)), edges);
    const orphans: string[] = [];
    const unsure: string[] = [];
    for (const f of created) {
      if (fromTests.has(f) || (!isTestSupport(f) && fromExisting.has(f))) continue;
      if (unresolved.has(stem(f))) unsure.push(f);
      else orphans.push(f);
    }
    if (orphans.length > 0) {
      return {
        status: 'fail',
        summary: `${orphans.length} file(s) this run created are not used by any test${orphans.some((f) => !isTestSupport(f)) ? ' or existing code' : ''}`,
        details: [
          ...orphans.map((f) =>
            isTestSupport(f)
              ? `${f}: created under the test root, but no test imports it (directly or through other helpers)`
              : `${f}: created, but neither a test nor code that existed at run start imports it`),
          `Ship commits every file: delete leftovers with delete_file { "path": "${orphans[0] ?? ''}" }, or import them from the test or code that needs them.`,
        ],
      };
    }
    if (unsure.length > 0) {
      return {
        status: 'unproven',
        summary: `${unsure.length} created file(s) may be imported through a path alias TypeScript could not resolve`,
        details: [
          ...unsure.map((f) => `${f}: no import reaches it`),
          'Import it with a relative specifier from the test or code that uses it, or delete_file it if it is a leftover.',
        ],
      };
    }
    return { status: 'pass', summary: `${created.length} created files, all imported by a test or by existing code` };
  },
});
