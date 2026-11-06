/**
 * What the session's model is told. The standards list in its system prompt is exactly what the gate
 * runs: in place (a web layout) express and nestjs get web-build too (inPlaceStacks), and the prompt
 * says so; the twins (a react-vite session, and file mode's selection for the same repository) list
 * what their gate runs, without web-build. A writable session is told, in a few lines, what makes a
 * test prove something (it imports the source; it fails before the change; globals stubbed before the
 * import) and to prefer a Measure script where a sandbox confines one (where none does, propose_contract
 * refuses a script and the prompt says Measure: none); a read-only session (it cannot edit) is not.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { checksForRun, runChecks, selectChecks } from '../../src/core/checks.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { computeTargetProfile } from '../../src/core/target.ts';
import type { CheckPlugin, LogStore, PluginRecord, RegistryView } from '../../src/core/types.ts';
import { lastNumber } from '../../src/core/measure.ts';
import { toolInputSchema } from '../../src/core/registry.ts';
import { sessionSystemPrompt } from '../../src/session/prompt.ts';
import type { SessionDeps } from '../../src/session/session.ts';
import proposeContract from '../../plugins/tools/propose_contract.ts';
import { calls, proposal, realRegistry, registryWithGates, runScripted, text, webRepo, type WebRepo } from './helpers.ts';

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

describe('a writable session is told what makes a test prove something; a read-only one is not', () => {
  const base = { repo: 'tiny-web', branch: 'fix/x', stack: 'web' as const, runner: 'vitest', tools: [], checks: [], measureScripts: true };
  /** The guidance, one pattern per point (generic: nothing about any repository). */
  const GUIDANCE = [
    /covers a source file only by importing it .*test_map <file>.*reads the file's text or copies its logic proves nothing/,
    /passes before the change, it does not reproduce the problem: make it fail for the reason the contract names, then change the code/,
    /\(window, document, localStorage, import\.meta\.env\) before the module loads: stub, then import\(\) it/,
  ];
  /** The Measure line where a sandbox confines a Measure script the model writes, and where none does. */
  const PREFER = /^- Prefer a measureScript over Measure: none \(an item with Measure: none can ship but never close\)\.$/m;
  const NONE = /^- No sandbox confines a Measure script here, so propose_contract refuses one: propose with Measure: none \(no measureScript; that item can ship but never close\)\.$/m;

  it('the writable prompt carries it, in four short lines', () => {
    const p = sessionSystemPrompt({ ...base, writable: true, reason: '' });
    for (const g of [...GUIDANCE, PREFER]) expect(p).toMatch(g);
    // Sent with every request: four lines, under 700 characters in all.
    const lines = p.split('\n').filter((l) => [...GUIDANCE, PREFER].some((g) => g.test(l)));
    expect(lines).toHaveLength(4);
    expect(lines.join('\n').length).toBeLessThan(700);
    // Generic: no file, framework or repository of anyone's in it.
    expect(lines.join('\n')).not.toMatch(/src\/|\.tsx?\b|react|vite|express/i);
  });

  it('twin: the read-only prompt (it cannot edit) carries none of it, and still never says propose', () => {
    for (const measureScripts of [true, false]) {
      const p = sessionSystemPrompt({ ...base, measureScripts, writable: false, reason: 'the branch main is protected' });
      for (const g of [...GUIDANCE, PREFER, NONE]) expect(p).not.toMatch(g);
      expect(p).not.toMatch(/propos|measureScript|Measure: none/i);
    }
  });

  it('a Measure script is preferred only where one can run: where no sandbox confines it (or nobody said), the prompt says Measure: none', () => {
    const where = (measureScripts: boolean | undefined): string => sessionSystemPrompt({ ...base, measureScripts, writable: true, reason: '' });
    expect(where(true)).toMatch(PREFER);
    expect(where(true)).not.toMatch(NONE);
    for (const cannot of [false, undefined]) {
      expect(where(cannot), String(cannot)).toMatch(NONE);
      expect(where(cannot), String(cannot)).not.toMatch(PREFER);
      // The rest of the guidance is the same either way, and the line stays short.
      for (const g of GUIDANCE) expect(where(cannot)).toMatch(g);
      expect(where(cannot).split('\n').find((l) => NONE.test(l))?.length ?? 999).toBeLessThan(200);
    }
  });

  it('agrees with propose_contract: the prompt names its measureScript field and leaves the script\'s output to its description, a shape the harness reads', () => {
    const schema = toolInputSchema(proposeContract.input) as { properties?: Record<string, { description?: string }> };
    const said = schema.properties?.['measureScript']?.description ?? '';
    expect(Object.keys(schema.properties ?? {})).toContain('measureScript');
    expect(said).toMatch(/^Optional: .*prints one line \{"metric":"<name>","value":<number>\}/);
    expect(said).toMatch(/Omit it when no script can measure the metric \(the contract then says Measure: none\)/);
    // What the description asks the script to print is what the harness reads the number from (measure.ts).
    const shape = /\{"metric":"<name>","value":<number>\}/.exec(said)?.[0] ?? '';
    expect(lastNumber(shape.replace('<name>', 'greeting tests passing').replace('<number>', '3'))).toBe(3);
    // The prompt names the field and says nothing of the output, so it cannot drift from that description.
    for (const measureScripts of [true, false]) {
      const line = sessionSystemPrompt({ ...base, measureScripts, writable: true, reason: '' }).split('\n').find((l) => /measureScript/.test(l)) ?? '';
      expect(line, String(measureScripts)).toMatch(/\bmeasureScript\b/);
      expect(line, String(measureScripts)).not.toMatch(/print|number|value|\{|json/i);
    }
  });

  it('in real sessions: a writable checkout\'s requests carry it, a protected branch\'s (read-only) do not', async () => {
    const w = webRepo();
    const ro = webRepo({ branch: 'main' });
    repos.push(w, ro);
    const writable = await runScripted(w, [text('hi')], ['hello']);
    const readOnly = await runScripted(ro, [text('hi')], ['hello']);
    for (const g of [...GUIDANCE, PREFER]) {
      expect(writable.driver.requests[0]?.system).toMatch(g);
      expect(readOnly.driver.requests[0]?.system).not.toMatch(g);
    }
    expect(readOnly.driver.requests[0]?.system).not.toMatch(NONE);
    expect(readOnly.driver.requests[0]?.system).toMatch(/read-only/);
  });

  it('in real sessions the Measure line is what propose_contract then does: Measure: none exactly where a script is refused and the turn stops', async () => {
    const script = 'console.log(JSON.stringify({ metric: "greeting tests passing", value: 1 }));\n';
    const cases: Array<[string, Partial<SessionDeps>, Record<string, string>, boolean]> = [
      ['a sandbox confines it (sandbox-exec)', {}, {}, true],
      ['no sandbox works on this machine', { isolation: { mode: 'auto', mechanism: 'none', policy: 'test' } }, {}, false],
      ['the sandbox is turned off', {}, { HARNESS_SANDBOX: 'off' }, false],
    ];
    for (const [how, extra, env, runs] of cases) {
      const r = webRepo();
      repos.push(r);
      const s = await runScripted(r, [calls(['propose_contract', proposal({ measureScript: script })]), text('done')], ['fix the greeting'], { extra: { ...extra, env: { ...r.env, ...env } } });
      const system = s.driver.requests[0]?.system ?? '';
      expect(PREFER.test(system), how).toBe(runs);
      expect(NONE.test(system), how).toBe(!runs);
      // The advice and propose_contract's answer agree: a script is preferred iff it reaches the owner's box.
      expect(/the agent stopped: a Measure script you write runs only where the sandbox confines it/.test(s.out), how).toBe(!runs);
      expect(/PROPOSAL greeting-name/.test(s.out), how).toBe(runs);
    }
  });
});
