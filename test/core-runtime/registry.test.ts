import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { loadRegistry, pluginFingerprint, toolSpecs } from '../../src/core/registry.ts';
import type { HarnessConfig, RegistryView } from '../../src/core/types.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('registry');
const API = pathToFileURL(join(HARNESS_ROOT, 'src/core/plugin-api.ts')).href;
const pdir = join(tmp.dir, 'plugins');

function put(rel: string, body: string): void {
  const file = join(pdir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}

const header = `import { z } from 'zod';\nimport { defineTool, defineHook, defineGate, defineCheck, defineDriver } from '${API}';\n`;

beforeAll(() => {
  put(
    'tools/echo.ts',
    `${header}export default defineTool({ name: 'echo', description: 'Echo text.', effect: 'read',
      input: z.object({ text: z.string(), times: z.coerce.number().int().default(1) }),
      async run(input) { return { ok: true, summary: input.text }; } });\n`,
  );
  put(
    'tools/brown_only.ts',
    `${header}export default defineTool({ name: 'brown_only', description: 'Only brownfield.', effect: 'exec',
      availableIn: ['brownfield'], input: z.object({}), async run() { return { ok: true, summary: '' }; } });\n`,
  );
  put(
    'hooks/multi.ts',
    `${header}export default [
      defineHook({ name: 'h1', description: 'd', events: ['pre_tool'], async run() { return { decision: 'pass' }; } }),
      defineGate({ name: 'g1', description: 'd', phases: ['finish'], async run() { return { status: 'pass', summary: 'ok' }; } }),
    ];\n`,
  );
  put(
    'checks/c1.ts',
    `${header}export default defineCheck({ id: 'c1', category: 'standards', description: 'd', unit: 'routes', doc: 'doc',
      async run() { return []; } });\n`,
  );
  put(
    'drivers/fake.ts',
    `${header}export default defineDriver({ name: 'fake', description: 'd', create() { throw new Error('no'); } });\n`,
  );
  put('tools/zz_dup.ts', `${header}export default defineTool({ name: 'echo', description: 'Dup.', effect: 'read', input: z.object({}), async run() { return { ok: true, summary: '' }; } });\n`);
  put('tools/broken.ts', `${header}throw new Error('kaboom at import');\nexport default 1;\n`);
  put('tools/badshape.ts', `export default { kind: 'tool', name: 'bad_shape', description: 'x', effect: 'read', input: {}, run: 5 };\n`);
  put('tools/nodefault.ts', `export const x = 1;\n`);
  put('tools/disabled_one.ts', `${header}export default defineTool({ name: 'disabled_one', description: 'Off.', effect: 'read', input: z.object({}), async run() { return { ok: true, summary: '' }; } });\n`);
  put('tools/_private.ts', `throw new Error('must not be imported');\n`);
  put('tools/echo.test.ts', `throw new Error('must not be imported');\n`);
  put('lib/helper.ts', `throw new Error('must not be imported');\n`);
  put('tools/lib/deep.ts', `throw new Error('must not be imported');\n`);
  put('tools/types.d.ts', `declare const x: number;\n`);
  put('tools/readme.md', `not a plugin`);
});
afterAll(() => tmp.cleanup());

function config(): HarnessConfig {
  return { ...loadConfig(), pluginDirs: [pdir], disabled: ['disabled_one'] };
}

describe('registry', () => {
  let reg: RegistryView;
  beforeAll(async () => {
    reg = await loadRegistry(config(), HARNESS_ROOT);
  });

  it('discovers plugins of every kind, including array exports', () => {
    expect(reg.tools.map((t) => t.plugin.name)).toEqual(['brown_only', 'echo']);
    expect(reg.hooks.map((h) => h.plugin.name)).toEqual(['h1']);
    expect(reg.gates.map((g) => g.plugin.name)).toEqual(['g1']);
    expect(reg.checks.map((c) => c.plugin.id)).toEqual(['c1']);
    expect(reg.drivers.map((d) => d.plugin.name)).toEqual(['fake']);
  });

  it('records harness-relative paths and sha256', () => {
    const echo = reg.tools.find((t) => t.plugin.name === 'echo');
    expect(echo?.file).toMatch(/^\.harness\/tmp\/.+\/plugins\/tools\/echo\.ts$/);
    expect(echo?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips lib/, _files, .test.ts, .d.ts and honours disabled', () => {
    const all = JSON.stringify(reg);
    expect(all).not.toContain('_private');
    expect(all).not.toContain('helper.ts');
    expect(all).not.toContain('deep.ts');
    expect(all).not.toContain('echo.test.ts');
    expect(all).not.toContain('disabled_one');
  });

  it('reports duplicates, broken imports and bad shapes as errors', () => {
    const byFile = (s: string): string | undefined => reg.errors.find((e) => e.file.endsWith(s))?.error;
    expect(byFile('tools/zz_dup.ts')).toMatch(/duplicate tool "echo"/);
    expect(byFile('tools/broken.ts')).toMatch(/kaboom/);
    expect(byFile('tools/badshape.ts')).toMatch(/invalid tool plugin.*(input|run)/);
    expect(byFile('tools/nodefault.ts')).toMatch(/no default export/);
    expect(reg.errors).toHaveLength(4);
  });

  it('toolSpecs emit plain JSON Schema without $schema, filtered by task kind', () => {
    const green = toolSpecs(reg.tools, 'greenfield');
    expect(green.map((s) => s.name)).toEqual(['echo']);
    const echo = green[0];
    expect(echo?.inputSchema.$schema).toBeUndefined();
    expect(echo?.inputSchema.type).toBe('object');
    expect(echo?.inputSchema.required).toEqual(['text']); // io: 'input' → defaulted field optional
    expect(JSON.parse(JSON.stringify(echo?.inputSchema))).toEqual(echo?.inputSchema);
    expect(toolSpecs(reg.tools, 'brownfield').map((s) => s.name)).toEqual(['brown_only', 'echo']);
  });

  it('pluginFingerprint covers tools/hooks/gates/checks but not drivers', () => {
    const fp = pluginFingerprint(reg);
    const files = Object.keys(fp);
    expect(files.some((f) => f.endsWith('tools/echo.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('hooks/multi.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('checks/c1.ts'))).toBe(true);
    expect(files.some((f) => f.includes('drivers/'))).toBe(false);
  });

  it('pluginFingerprint with the config also covers shared helpers (lib/, _files), never drivers, tests or non-code', () => {
    const fp = pluginFingerprint(reg, { config: config(), harnessRoot: HARNESS_ROOT });
    const files = Object.keys(fp);
    expect(files).toEqual([...files].sort());
    for (const f of ['lib/helper.ts', 'tools/lib/deep.ts', 'tools/_private.ts', 'tools/echo.ts', 'checks/c1.ts']) {
      expect(files.some((x) => x.endsWith(`plugins/${f}`)), f).toBe(true);
    }
    for (const f of ['drivers/fake.ts', 'tools/echo.test.ts', 'tools/types.d.ts', 'tools/readme.md']) {
      expect(files.some((x) => x.endsWith(`plugins/${f}`)), f).toBe(false);
    }
    for (const v of Object.values(fp)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    // without the config: exactly the loaded tool/hook/gate/check files (the registry view alone)
    expect(Object.keys(pluginFingerprint(reg)).every((f) => files.includes(f))).toBe(true);
  });

  it('pluginFingerprint excludes a driver plugin wherever it lives, and a helper edit changes the fingerprint', async () => {
    const dir2 = join(tmp.dir, 'plugins2');
    const put2 = (rel: string, body: string): void => {
      mkdirSync(join(dir2, rel, '..'), { recursive: true });
      writeFileSync(join(dir2, rel), body);
    };
    put2('extra/side-driver.ts', `${header}export default defineDriver({ name: 'side', description: 'd', create() { throw new Error('no'); } });\n`);
    put2('extra/lib/shared.ts', 'export const v = 1;\n');
    put2('drivers/_wire.ts', 'export const w = 1;\n');
    const cfg: HarnessConfig = { ...loadConfig(), pluginDirs: [dir2], disabled: [] };
    const reg2 = await loadRegistry(cfg, HARNESS_ROOT);
    expect(reg2.drivers.map((d) => d.plugin.name)).toEqual(['side']);
    const before = pluginFingerprint(reg2, { config: cfg, harnessRoot: HARNESS_ROOT });
    const keys = Object.keys(before);
    expect(keys.some((f) => f.endsWith('extra/lib/shared.ts'))).toBe(true);
    expect(keys.some((f) => f.endsWith('side-driver.ts'))).toBe(false);
    expect(keys.some((f) => f.includes('/drivers/'))).toBe(false);
    put2('extra/lib/shared.ts', 'export const v = 2;\n');
    const after = pluginFingerprint(reg2, { config: cfg, harnessRoot: HARNESS_ROOT });
    const key = keys.find((f) => f.endsWith('extra/lib/shared.ts')) ?? '';
    expect(after[key]).not.toBe(before[key]);
  });

  it('a missing plugin dir is simply empty', async () => {
    const r = await loadRegistry({ ...config(), pluginDirs: ['does-not-exist-xyz'] }, HARNESS_ROOT);
    expect(r.tools).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
