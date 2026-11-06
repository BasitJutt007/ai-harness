/**
 * What the session's model is told. The standards list in its system prompt is exactly what the gate
 * runs: in place (a web layout) express and nestjs get web-build too (inPlaceStacks), and the prompt
 * says so; the twins (a react-vite session, and file mode's selection for the same repository) list
 * what their gate runs, without web-build.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { checksForRun, runChecks, selectChecks } from '../../src/core/checks.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { computeTargetProfile } from '../../src/core/target.ts';
import type { CheckPlugin, LogStore, PluginRecord, RegistryView } from '../../src/core/types.ts';
import { realRegistry, registryWithGates, runScripted, text, webRepo, type WebRepo } from './helpers.ts';

/** The rule ids a session system prompt lists under "Standards the gates check". */
function listedRules(system: string): string[] {
  const block = system.split('Standards the gates check')[1] ?? '';
  return [...block.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1] ?? '').sort();
}

/** The real checks, each recording its id when the gate runs it (and finding nothing, at once). */
async function recordingChecks(ran: Set<string>): Promise<Array<PluginRecord<CheckPlugin>>> {
  const real = await realRegistry();
  return real.checks.map((r) => ({
    ...r,
    plugin: {
      ...r.plugin,
      run: async () => {
        ran.add(r.plugin.id);
        return [];
      },
    },
  }));
}

const EXPRESS = {
  'package.json': `${JSON.stringify({ name: 'tiny-api', private: true, type: 'module', scripts: { test: 'vitest run' }, dependencies: { express: '^5.0.0' }, devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' } }, null, 2)}\n`,
  'src/app.ts': "export const port = 3000;\n",
};
const NESTJS = {
  'package.json': `${JSON.stringify({ name: 'tiny-api', private: true, type: 'module', scripts: { test: 'vitest run' }, dependencies: { '@nestjs/core': '^11.0.0', '@nestjs/common': '^11.0.0' }, devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' } }, null, 2)}\n`,
  'src/app.ts': "export const port = 3000;\n",
};

let repos: WebRepo[] = [];
afterEach(() => {
  for (const r of repos) r.cleanup();
  repos = [];
});

/** A session in `r` that says hello, then runs /gates: what its prompt lists, and what the gate ran. */
async function promptAndGate(r: WebRepo): Promise<{ stack: unknown; listed: string[]; ran: string[] }> {
  const ran = new Set<string>();
  const registry: RegistryView = { ...(await registryWithGates()), checks: await recordingChecks(ran) };
  const s = await runScripted(r, [text('hi')], ['hello', '/gates'], { registry });
  expect(s.result.code).toBe(0);
  return { stack: (s.runJson['target'] as { stack?: unknown } | undefined)?.stack, listed: listedRules(s.driver.requests[0]?.system ?? ''), ran: [...ran].sort() };
}

describe('the session prompt lists exactly the checks the gate runs', () => {
  it('in place, express and nestjs: web-build runs at the gate, and the prompt names it', async () => {
    for (const [stack, files] of [['express', EXPRESS], ['nestjs', NESTJS]] as const) {
      const r = webRepo({ extra: files });
      repos.push(r);
      const got = await promptAndGate(r);
      expect(got.stack, stack).toBe(stack);
      expect(got.ran, stack).toContain('web-build');
      expect(got.listed, stack).toEqual(got.ran);
    }
  });

  it('twin: a react-vite session lists what its gate runs, and web-build is neither', async () => {
    const r = webRepo();
    repos.push(r);
    const got = await promptAndGate(r);
    expect(got.stack).toBe('react-vite');
    expect(got.ran.length).toBeGreaterThan(0);
    expect(got.ran).not.toContain('web-build');
    expect(got.listed).toEqual(got.ran);
  });

  it('twin: file mode\'s selection for the same express repository (run.ts: no in-place flag) is its gate\'s, without web-build', async () => {
    const r = webRepo({ extra: EXPRESS });
    repos.push(r);
    const profile = await computeTargetProfile({ apiRoot: r.repo, repoRoot: r.repo, harnessRoot: HARNESS_ROOT });
    expect(profile.stack).toBe('express');
    expect(profile.codeKinds).toBeUndefined();
    const ran = new Set<string>();
    const checks = (await recordingChecks(ran)).map((c) => c.plugin);
    const logs: LogStore = { write: async (name) => join(r.base, `${name}.log`) };
    await runChecks({ root: r.repo, checks, exec: coreExec, harnessRoot: HARNESS_ROOT, logs, stack: profile.stack, layout: profile });
    const fileModePrompt = selectChecks(checks, undefined, undefined, profile.stack).map((c) => c.id).sort();
    expect(fileModePrompt).toEqual([...ran].sort());
    expect(fileModePrompt).not.toContain('web-build');
    expect(checksForRun(checks, { stack: profile.stack, layout: profile }).map((c) => c.id).sort()).toEqual(fileModePrompt);
  });
});
