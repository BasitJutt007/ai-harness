/**
 * Graders drop plugins in as they write them: kebab-case tool names, .js/.mjs/.mts
 * files, checks without unit/doc, hooks/gates/tools without a description.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatReport } from '../../src/core/checks.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { isPluginFile, loadRegistry, toolSpecs, validatePlugin } from '../../src/core/registry.ts';
import type { RegistryView } from '../../src/core/types.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('registry-lenient');
const API = pathToFileURL(join(HARNESS_ROOT, 'src/core/plugin-api.ts')).href;
const pdir = join(tmp.dir, 'plugins');

function put(rel: string, body: string): void {
  const file = join(pdir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}

const tsHeader = `import { z } from 'zod';\nimport { defineTool, defineHook, defineGate, defineCheck } from '${API}';\n`;
const jsHeader = `import { z } from 'zod';\n`;

beforeAll(() => {
  put('tools/openapi-diff.ts', `${tsHeader}export default defineTool({ name: 'openapi-diff', effect: 'read',
    input: z.object({}), async run() { return { ok: true, summary: 'no diff' }; } });\n`);
  put('tools/js-tool.js', `${jsHeader}export default { kind: 'tool', name: 'jsTool', description: 'from js', effect: 'read',
    input: z.object({}), async run() { return { ok: true, summary: '' }; } };\n`);
  put('tools/mjs_tool.mjs', `${jsHeader}export default { kind: 'tool', name: 'mjs_tool', description: 'from mjs', effect: 'read',
    input: z.object({}), async run() { return { ok: true, summary: '' }; } };\n`);
  put('checks/orm-explicit-columns.mts', `${tsHeader}export default defineCheck({ id: 'orm-explicit-columns', category: 'orm',
    async run() { return [{ rule: 'orm-explicit-columns', file: 'src/db.ts', status: 'pass', units: { passed: 2, total: 2 }, violations: [] }]; } });\n`);
  put('hooks/quiet.ts', `${tsHeader}export default [
    defineHook({ name: 'quiet', events: ['pre_tool'], async run() { return { decision: 'pass' }; } }),
    defineGate({ name: 'quiet-gate', phases: ['finish'], async run() { return { status: 'pass', summary: 'ok' }; } }),
  ];\n`);
  // never loaded
  put('tools/types.d.mts', `export declare const x: number;\n`);
  put('tools/thing.test.js', `throw new Error('must not be imported');\n`);
  put('tools/thing.spec.mjs', `throw new Error('must not be imported');\n`);
  put('tools/_draft.mjs', `throw new Error('must not be imported');\n`);
  put('tools/lib/util.js', `throw new Error('must not be imported');\n`);
  put('tools/notes.json', `{}`);
});
afterAll(() => tmp.cleanup());

describe('registry leniency for drop-in plugins', () => {
  let reg: RegistryView;
  beforeAll(async () => {
    reg = await loadRegistry({ ...loadConfig(), pluginDirs: [pdir], disabled: [] }, HARNESS_ROOT);
  });

  it('loads kebab/camel tool names and .ts/.mts/.js/.mjs files without load errors', () => {
    expect(reg.errors).toEqual([]);
    expect(reg.tools.map((t) => t.plugin.name).sort()).toEqual(['jsTool', 'mjs_tool', 'openapi-diff']);
    expect(reg.checks.map((c) => c.plugin.id)).toEqual(['orm-explicit-columns']);
    expect(reg.hooks.map((h) => h.plugin.name)).toEqual(['quiet']);
    expect(reg.gates.map((g) => g.plugin.name)).toEqual(['quiet-gate']);
  });

  it('a tool without a description is offered with its name as the description', () => {
    const spec = toolSpecs(reg.tools, 'greenfield').find((s) => s.name === 'openapi-diff');
    expect(spec?.description).toBe('openapi-diff');
  });

  it('a check without unit/doc reports in "units" and long rule ids stay aligned', () => {
    const checks = reg.checks.map((c) => c.plugin);
    const findings = [{ rule: 'orm-explicit-columns', file: 'src/db.ts', status: 'pass' as const, units: { passed: 2, total: 2 }, violations: [] }];
    const r = formatReport(findings, checks, '/api');
    expect(r.rules[0]?.unit).toBe('units');
    const lines = r.text.split('\n');
    const row = lines[0] ?? '';
    const verdict = lines.find((l) => l.startsWith('verdict')) ?? '';
    // rule column = max(18, longest id + 2) = 22: status column starts at the same offset everywhere
    expect(row.indexOf('pass')).toBe('orm-explicit-columns'.length + 2);
    expect(verdict.indexOf('100%')).toBe('orm-explicit-columns'.length + 2);
    expect(row).toContain('2/2 units');
  });

  it('tool name validation: letters, digits, _ and -, starting with a letter, max 64', () => {
    const tool = (name: string): unknown => ({ kind: 'tool', name, effect: 'read', input: { safeParse: () => ({}) }, run: () => undefined });
    for (const ok of ['openapi-diff', 'readFile', 'a', `a${'b'.repeat(63)}`]) expect('plugin' in validatePlugin(tool(ok))).toBe(true);
    for (const bad of ['-x', '1x', 'a b', 'a.b', `a${'b'.repeat(64)}`, '']) expect('error' in validatePlugin(tool(bad))).toBe(true);
  });

  it('isPluginFile accepts ts/mts/js/mjs and skips declarations, tests and _files', () => {
    for (const f of ['a.ts', 'a.mts', 'a.js', 'a.mjs', 'openapi-diff.ts']) expect(isPluginFile(f)).toBe(true);
    for (const f of ['a.d.ts', 'a.d.mts', 'a.test.ts', 'a.test.js', 'a.spec.mjs', '_a.ts', 'a.json', 'a.cjs', 'a.tsx']) {
      expect(isPluginFile(f)).toBe(false);
    }
  });
});
