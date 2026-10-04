/**
 * `harness agnostic` compares what GOVERNS two runs, not only plugin file hashes: the active plugin
 * manifest (a disabled hook changes it), the governing config hash, the src/core hash, and both
 * verdicts. Exit 0 only with zero governing difference AND both runs DONE; a field an older
 * run.json lacks is a difference (UNPROVEN), never "equal".
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/core/cli.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { governanceRecord, type Governance } from '../../src/core/governance.ts';
import { loadRegistry, pluginFingerprint } from '../../src/core/registry.ts';
import type { HarnessConfig, RegistryView } from '../../src/core/types.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('agnostic');
let config: HarnessConfig;
let reg: RegistryView;
let gov: Governance;
let n = 0;

beforeAll(async () => {
  config = loadConfig(HARNESS_ROOT);
  reg = await loadRegistry(config, HARNESS_ROOT);
  gov = governanceRecord(reg, config, HARNESS_ROOT, 'auto');
});
afterAll(() => tmp.cleanup());

/** A run directory holding a run.json with the given governance and verdict. */
function runDir(governance: Governance | undefined, verdict: string | undefined, extra: Record<string, unknown> = {}): string {
  const dir = join(tmp.dir, `run-${n++}`);
  mkdirSync(dir, { recursive: true });
  const record = {
    driver: 'scripted',
    model: 'm',
    task: { id: 't', sha256: 'a'.repeat(64) },
    pluginFingerprint: pluginFingerprint(reg, { config, harnessRoot: HARNESS_ROOT }),
    ...(governance !== undefined ? { governance } : {}),
    ...(verdict !== undefined ? { verdict, ok: verdict === 'DONE', status: verdict === 'DONE' ? 'done' : 'stalled' } : {}),
    ...extra,
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(record));
  return dir;
}

async function agnostic(a: string, b: string): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(['agnostic', a, b], (l) => lines.push(l));
  return { code, text: lines.join('\n') };
}

describe('harness agnostic: governance', () => {
  it('records the active manifest (no drivers), the governing config and every src/core file', () => {
    expect(gov.manifest.some((e) => e.kind === 'hook' && e.name === 'secret-guard')).toBe(true);
    expect(gov.manifest.every((e) => (e.kind as string) !== 'driver')).toBe(true);
    expect(gov.config).toMatchObject({ disabled: [], sandbox: 'auto', limits: config.limits });
    expect(gov.config).not.toHaveProperty('runsDir');
    expect(Object.keys(gov.core.files)).toContain('src/core/governance.ts');
    expect(gov.configSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('identical governance and both runs DONE: zero diff, exit 0', async () => {
    const r = await agnostic(runDir(gov, 'DONE'), runDir(gov, 'DONE', { driver: 'other', model: 'other-model' }));
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('zero governing diff');
    expect(r.text).toMatch(/^A .* verdict DONE$/m);
    expect(r.text).toContain('agnostic: PROVEN');
  });

  it('a config that disables a hook: the manifest and the config hash differ, exit 1', async () => {
    const disabled = { ...config, disabled: ['secret-guard'] };
    const g2 = governanceRecord(await loadRegistry(disabled, HARNESS_ROOT), disabled, HARNESS_ROOT, 'auto');
    const r = await agnostic(runDir(gov, 'DONE'), runDir(g2, 'DONE'));
    expect(r.code).toBe(1);
    expect(r.text).toContain('active only in A: hook:secret-guard (plugins/hooks/secret-guard.ts)');
    expect(r.text).toMatch(/config hash differs: \w+ vs \w+ \(disabled: \[\] vs \["secret-guard"\]\)/);
    expect(r.text).toContain('agnostic: NOT PROVEN: 2 governing difference(s)');
  });

  it('a changed core file: the core hash differs and names the file, exit 1', async () => {
    const root = join(tmp.dir, 'harness-copy');
    cpSync(join(HARNESS_ROOT, 'src', 'core'), join(root, 'src', 'core'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'gates.ts'), '// patched\n', { flag: 'a' });
    const g2 = governanceRecord(reg, config, root, 'auto');
    const r = await agnostic(runDir(gov, 'DONE'), runDir(g2, 'DONE'));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/core hash differs: \w+ vs \w+ \(src\/core\/gates\.ts\)/);
  });

  it('a sandbox mode change is a config difference', async () => {
    const g2 = governanceRecord(reg, config, HARNESS_ROOT, 'off');
    const r = await agnostic(runDir(gov, 'DONE'), runDir(g2, 'DONE'));
    expect(r.code).toBe(1);
    expect(r.text).toContain('sandbox: "auto" vs "off"');
  });

  it('zero governing diff but a run NOT DONE: exit 1 with the reason', async () => {
    const r = await agnostic(runDir(gov, 'DONE'), runDir(gov, 'NOT DONE (final gates not green)'));
    expect(r.code).toBe(1);
    expect(r.text).toContain('zero governing diff');
    expect(r.text).toContain('agnostic: NOT PROVEN: run B is not DONE (NOT DONE (final gates not green))');
  });

  it('an older run.json without governance or verdict: "not recorded" differences (UNPROVEN), never equal, exit 1', async () => {
    const r = await agnostic(runDir(undefined, undefined), runDir(gov, 'DONE'));
    expect(r.code).toBe(1);
    expect(r.text).toContain('active plugin manifest: not recorded in run A (older run.json): UNPROVEN');
    expect(r.text).toContain('core hash: not recorded in run A (older run.json): UNPROVEN');
    expect(r.text).toMatch(/run A is not DONE \(not recorded/);
  });
});
