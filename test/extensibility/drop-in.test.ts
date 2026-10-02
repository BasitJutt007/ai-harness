/**
 * Grading dimension 4, programmatically: each extension is ONE file dropped into a
 * plugin directory. The registry discovers it, tools reach the model's tool list,
 * checks join the standards report and the system prompt's rules index, a disabled
 * entry removes them, and nothing under src/core changes.
 *
 * "base" is the live plugins/ dir (whatever is in it, including plugins a grader dropped in
 * before running the suite) minus any file that already registers one of the examples'
 * names; "extended" is base plus the three examples. Assertions are relative to base, so
 * extra plugins never turn this suite red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatReport, runChecks } from '../../src/core/checks.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { systemPrompt } from '../../src/core/prompt.ts';
import { loadRegistry, pluginFingerprint, pluginName, toolSpecs } from '../../src/core/registry.ts';
import type { CheckPlugin, HarnessConfig, RegistryView } from '../../src/core/types.ts';
import { BROWNFIELD, coreFingerprint, dropIn, dropInDir, memoryLogs, mirrorPluginDirs, ORM_FIXTURE, repoTmp, SAMPLE_API } from './_helpers.ts';

const tmp = repoTmp('drop-in');
let pdir = '';
let base: RegistryView;
let extended: RegistryView;
let config: HarnessConfig;

const DROPPED = ['tools/openapi_diff.ts', 'checks/orm-explicit-columns.ts', 'checks/no-console.ts'];
const EXAMPLE_CHECKS: ReadonlySet<string> = new Set(['orm-explicit-columns', 'no-console']);

/** Every record a registry holds, keyed `kind:name` (the registry's duplicate key). */
function records(reg: RegistryView): { key: string; file: string }[] {
  return [...reg.drivers, ...reg.tools, ...reg.hooks, ...reg.gates, ...reg.checks]
    .map((r) => ({ key: `${r.plugin.kind}:${pluginName(r.plugin)}`, file: r.file }));
}

beforeAll(async () => {
  const real = loadConfig(HARNESS_ROOT);
  pdir = dropInDir(tmp.dir);
  for (const rel of DROPPED) dropIn(pdir, rel);
  const examples = new Set(records(await loadRegistry({ ...real, pluginDirs: [pdir] }, HARNESS_ROOT)).map((r) => r.key));
  // A live file that already registers an example's name (e.g. the example was copied into
  // plugins/ before the suite ran) is left out of base, so the drop-in is not a duplicate.
  const taken = records(await loadRegistry(real, HARNESS_ROOT)).filter((r) => examples.has(r.key));
  const liveDirs = mirrorPluginDirs(tmp.dir, real, new Set(taken.map((r) => join(HARNESS_ROOT, r.file))));
  base = await loadRegistry({ ...real, pluginDirs: liveDirs }, HARNESS_ROOT);
  config = { ...real, pluginDirs: [...liveDirs, pdir] };
  extended = await loadRegistry(config, HARNESS_ROOT);
});

afterAll(() => tmp.cleanup());

function checksOf(reg: RegistryView): CheckPlugin[] {
  return reg.checks.map((r) => r.plugin);
}

describe('registry discovery of dropped-in files', () => {
  it('loads every example without errors and without touching the built-ins', () => {
    expect(extended.errors).toEqual(base.errors);
    // base really is the live plugin set (contains, never equals: extra plugins are fine)
    expect(records(base).map((r) => r.key)).toEqual(expect.arrayContaining(['tool:read_file', 'hook:observed-red', 'gate:tests-green', 'check:zod-boundary', 'driver:scripted']));
    expect(extended.tools.length).toBe(base.tools.length + 1);
    expect(extended.checks.length).toBe(base.checks.length + 2);
    expect(extended.hooks.map((h) => h.plugin.name)).toEqual(base.hooks.map((h) => h.plugin.name));
    expect(extended.gates.map((g) => g.plugin.name)).toEqual(base.gates.map((g) => g.plugin.name));
  });

  it('registers the tool and both checks with their declared kind, category and file', () => {
    const tool = extended.tools.find((t) => t.plugin.name === 'openapi_diff');
    expect(tool?.plugin.effect).toBe('exec');
    expect(tool?.file.endsWith('plugins/tools/openapi_diff.ts')).toBe(true);
    const orm = extended.checks.find((c) => c.plugin.id === 'orm-explicit-columns');
    const lint = extended.checks.find((c) => c.plugin.id === 'no-console');
    expect(orm?.plugin.category).toBe('orm');
    expect(lint?.plugin.category).toBe('lint');
    expect(orm?.plugin.unit).toBe('queries');
    expect(lint?.plugin.unit).toBe('files');
  });

  it('fingerprints the new files, so run.json and `harness agnostic` see the extension', () => {
    const fp = pluginFingerprint(extended);
    for (const rel of DROPPED) expect(Object.keys(fp).some((f) => f.endsWith(`plugins/${rel}`))).toBe(true);
    expect(Object.keys(fp).length).toBe(Object.keys(pluginFingerprint(base)).length + DROPPED.length);
  });

  it('a "disabled" entry in harness.config.json removes a plugin (by name or kind:name)', async () => {
    const reg = await loadRegistry({ ...config, disabled: ['openapi_diff', 'check:no-console'] }, HARNESS_ROOT);
    expect(reg.errors).toEqual(base.errors);
    expect(reg.tools.some((t) => t.plugin.name === 'openapi_diff')).toBe(false);
    expect(reg.checks.some((c) => c.plugin.id === 'no-console')).toBe(false);
    expect(reg.checks.some((c) => c.plugin.id === 'orm-explicit-columns')).toBe(true);
  });
});

describe('a dropped-in tool reaches the next run', () => {
  it('appears in the neutral tool list for both task kinds, with a JSON Schema input', () => {
    for (const kind of ['greenfield', 'brownfield'] as const) {
      const spec = toolSpecs(extended.tools, kind).find((t) => t.name === 'openapi_diff');
      expect(spec?.description).toMatch(/openapi\.json/);
      expect(spec?.inputSchema['type']).toBe('object');
      expect(Object.keys((spec?.inputSchema['properties'] ?? {}) as object).sort()).toEqual(['against', 'spec']);
      expect(toolSpecs(base.tools, kind).some((t) => t.name === 'openapi_diff')).toBe(false);
    }
  });
});

describe('dropped-in checks join the standards report and the rules index', () => {
  it('the system prompt lists the new rules (descriptions come from the registry)', () => {
    const prompt = systemPrompt({ task: BROWNFIELD, checks: checksOf(extended), tools: toolSpecs(extended.tools, 'brownfield') });
    expect(prompt).toContain('- orm-explicit-columns: Every Prisma or Drizzle query on users');
    expect(prompt).toContain('- no-console: No console.*');
    expect(systemPrompt({ task: BROWNFIELD, checks: checksOf(base), tools: [] })).not.toContain('no-console');
  });

  it('runChecks on the ORM fixture prints each rule with its own FAIL line and file:line:col locations', async () => {
    const checks = checksOf(extended).filter((c) => EXAMPLE_CHECKS.has(c.id)); // not any other orm/lint rule someone added
    const report = await runChecks({ root: ORM_FIXTURE, checks, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    const lines = report.text.split('\n');
    expect(lines).toContainEqual(expect.stringMatching(/^orm-explicit-columns {2}FAIL {2}src\/db\/drizzle-users\.ts +3\/8 queries$/));
    expect(lines).toContainEqual(expect.stringMatching(/^orm-explicit-columns {2}FAIL {2}src\/db\/prisma-users\.ts +3\/6 queries$/));
    expect(lines).toContainEqual(expect.stringMatching(/^no-console +FAIL {2}src\/routes\/debug\.ts +0\/1 files$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}src\/routes\/debug\.ts:3:3 {2}console\.log/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}src\/db\/prisma-users\.ts:7:10 {2}prisma user\.findMany/));
    // discovery order = path order: checks/no-console.ts before checks/orm-explicit-columns.ts
    expect(report.rules.map((r) => [r.rule, r.category, r.status])).toEqual([
      ['no-console', 'lint', 'fail'],
      ['orm-explicit-columns', 'orm', 'fail'],
    ]);
    expect(report.verdict.status).toBe('fail');
    // compact (what check_standards returns to the model) keeps the failing lines with locations
    expect(report.compact).toMatch(/src\/db\/drizzle-users\.ts:7:10/);
  });

  it('on an API without ORM usage the ORM rule is n/a and the verdict is unaffected', async () => {
    const checks = checksOf(extended).filter((c) => EXAMPLE_CHECKS.has(c.id));
    const report = await runChecks({ root: SAMPLE_API, checks, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    expect(report.text).toMatch(/^orm-explicit-columns {2}n\/a {3}\(none\) +0\/0 queries$/m);
    expect(report.text).toMatch(/^orm-explicit-columns {2}n\/a +0\/0 queries$/m);
    expect(report.text).toMatch(/^no-console +pass {2}src\/app\.ts +1\/1 files$/m);
    expect(report.verdict).toEqual({ status: 'pass', percent: 100 });
  });

  it('formatReport renders a dropped-in rule without any core knowledge of it', () => {
    const check = extended.checks.find((c) => c.plugin.id === 'no-console')?.plugin;
    expect(check).toBeDefined();
    if (check === undefined) return;
    const out = formatReport(
      [{ rule: 'no-console', file: 'src/a.ts', status: 'fail', units: { passed: 0, total: 1 }, violations: [{ location: 'src/a.ts:2:1', message: 'console.log(...)' }] }],
      [check],
      '/api',
    );
    expect(out.text.split('\n').slice(0, 2)).toEqual([
      'no-console        FAIL  src/a.ts                         0/1 files',
      '    src/a.ts:2:1  console.log(...)',
    ]);
    expect(out.rules).toEqual([{ rule: 'no-console', category: 'lint', unit: 'files', status: 'fail', passed: 0, total: 1, files: 1 }]);
  });
});

describe('the core engine is untouched', () => {
  it('src/core/** has the same sha256 before and after discovering, prompting and checking', async () => {
    const before = coreFingerprint();
    const reg = await loadRegistry(config, HARNESS_ROOT);
    systemPrompt({ task: BROWNFIELD, checks: checksOf(reg), tools: toolSpecs(reg.tools, 'brownfield') });
    await runChecks({ root: ORM_FIXTURE, checks: checksOf(reg).filter((c) => c.category !== 'standards'), exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    expect(coreFingerprint()).toBe(before);
  });

  it('example plugins import only ../lib/* and packages, never core internals', () => {
    for (const rel of DROPPED) {
      const text = readFileSync(join(pdir, rel), 'utf8');
      const specs = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const s of specs) expect(s.startsWith('../lib/') || !s.startsWith('.')).toBe(true);
    }
  });
});
