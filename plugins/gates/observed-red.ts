/**
 * observed-red: the run observed at least one valid red, and every governed file
 * the run changed (vs the initial snapshot)
 *   - was let through by the observed-red hook (so nothing changed it behind the
 *     write tools' back, e.g. test code writing source files), and
 *   - is covered by a test with a red that counts for it (an assertion failure, or
 *     a missing-module red for a file that did not exist at run start).
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { TestMap } from '../../src/core/plugin-api.ts';
import { hasValidRed, isGovernedSource, sha256, unlockedSources } from '../lib/red.ts';

export default defineGate({
  name: 'observed-red',
  description: 'At least one observed red, and every changed source file was unlocked by an observed red of a covering test.',
  phases: ['finish', 'ship'],
  async run(ctx) {
    const reds = ctx.state.tests.filter((o) => o.validRed);
    const redFiles = [...new Set(reds.map((o) => o.file))];
    if (reds.length === 0) {
      return {
        status: 'fail',
        summary: 'no observed red in this run',
        details: ['Write a test for the behaviour, run it with run_tests and see it fail before changing source.'],
      };
    }
    let changed: string[];
    let map: TestMap;
    try {
      const files = await ctx.workspace.list(['**/*.ts', '**/*.mts', '**/*.cts']);
      changed = [];
      for (const f of files.filter(isGovernedSource).sort()) {
        const content = await ctx.workspace.read(f);
        if (content !== null && sha256(content) !== ctx.state.initialHashes.get(f)) changed.push(f);
      }
      map = await ctx.services.testMap();
    } catch (e) {
      return { status: 'unproven', summary: `could not inspect changes: ${e instanceof Error ? e.message : String(e)}` };
    }
    const unlocked = unlockedSources(ctx.state);
    const problems: string[] = [];
    for (const f of changed) {
      if (!unlocked.has(f)) {
        problems.push(`${f}: changed without passing the observed-red hook (not written by a write tool, e.g. modified by test code)`);
        continue;
      }
      const tests = map.testsFor(f);
      if (!tests.some((t) => hasValidRed(ctx.state, t, f))) {
        problems.push(`${f}: ${tests.length ? `covering tests never observed red (${tests.join(', ')})` : 'no covering test'}`);
      }
    }
    if (problems.length > 0) {
      return { status: 'fail', summary: `${problems.length} of ${changed.length} changed source files lack an observed-red test`, details: problems };
    }
    return {
      status: 'pass',
      summary: `${reds.length} red observations (${redFiles.length} test files); ${changed.length} changed source files covered`,
    };
  },
});
