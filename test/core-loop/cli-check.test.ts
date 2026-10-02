/**
 * `harness check --api <dir>` works on any directory, absolute or relative, without a run;
 * one with no node_modules above it is checked as a temporary copy under .harness/tmp.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSelectionError, hasNodeModules, main, USAGE } from '../../src/core/cli.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import type { CheckPlugin } from '../../src/core/types.ts';

const outside = mkdtempSync(join(tmpdir(), 'harness-check-'));
const api = join(outside, 'existing-api');

beforeAll(() => {
  cpSync(join(HARNESS_ROOT, 'samples', 'existing-api'), api, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
});
afterAll(() => rmSync(outside, { recursive: true, force: true }));

function mirrors(): string[] {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp');
  return existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith('check-existing-api-')) : [];
}

describe('harness check --api on any directory', () => {
  it('an absolute directory outside the harness with no node_modules: checked via a copy that is removed', async () => {
    expect(hasNodeModules(api)).toBe(false);
    const before = mirrors();
    const lines: string[] = [];
    const code = await main(['check', '--api', api, '--rule', 'tsc-strict', '--rule', 'rest-conventions'], (l) => lines.push(l));
    const text = lines.join('\n');
    expect(text).toMatch(/note: no node_modules/);
    expect(text).toMatch(/tsc-strict\s+pass\s+0 errors/);
    expect(text).toMatch(/rest-conventions\s+pass\s+4\/4 routes/);
    expect(text).not.toContain('Cannot find type definition');
    expect(code).toBe(0);
    expect(mirrors()).toEqual(before);
  }, 120_000);

  it('a relative directory works the same, and --json reports the directory that was asked for', async () => {
    const lines: string[] = [];
    const code = await main(['check', '--api', relative(process.cwd(), api), '--rule', 'tsc-strict', '--json'], (l) => lines.push(l));
    const json: unknown = JSON.parse(lines.filter((l) => !l.startsWith('note:')).join('\n'));
    expect(json).toMatchObject({ root: api, verdict: { status: 'pass', percent: 100 } });
    expect(code).toBe(0);
  }, 120_000);

  it('a directory inside the harness is checked in place (dependencies resolve from the harness)', () => {
    expect(hasNodeModules(join(HARNESS_ROOT, 'samples', 'existing-api'))).toBe(true);
  });

  it('a missing directory is a usage error', async () => {
    const lines: string[] = [];
    expect(await main(['check', '--api', join(outside, 'nope')], (l) => lines.push(l))).toBe(2);
    expect(lines.join('\n')).toMatch(/not a directory/);
  });

  it('an unknown --rule id is a usage error (exit 2) that lists the registered rule ids', async () => {
    const lines: string[] = [];
    expect(await main(['check', '--api', api, '--rule', 'no-such-rule'], (l) => lines.push(l))).toBe(2);
    const text = lines.join('\n');
    expect(text).toContain('unknown rule "no-such-rule"');
    for (const id of ['problem-json', 'rest-conventions', 'tsc-strict', 'zod-boundary']) expect(text).toContain(id);
    expect(text).not.toMatch(/verdict/);
  });

  it('a --category no registered check has is a usage error (exit 2)', async () => {
    const lines: string[] = [];
    expect(await main(['check', '--api', api, '--category', 'nope'], (l) => lines.push(l))).toBe(2);
    expect(lines.join('\n')).toMatch(/no registered check has category "nope"[\s\S]*rule ids: .*zod-boundary/);
  });

  it('checkSelectionError: valid selections pass; a rule/category combination with nothing in common is an error', () => {
    const mk = (id: string, category: string): CheckPlugin => ({ kind: 'check', id, category, run: async () => [] });
    const checks = [mk('zod-boundary', 'standards'), mk('no-console', 'lint')];
    expect(checkSelectionError(checks, [], [])).toBeNull();
    expect(checkSelectionError(checks, ['no-console'], ['lint'])).toBeNull();
    expect(checkSelectionError(checks, ['x', 'y'], [])).toBe('unknown rules "x", "y". Registered rule ids: zod-boundary, no-console');
    expect(checkSelectionError(checks, ['no-console'], ['standards'])).toMatch(/select no check in common.*no-console \[lint\]/);
    expect(checkSelectionError([], ['a'], [])).toBe('unknown rule "a". Registered rule ids: (none)');
  });

  it('usage documents --repo and the evidence-dir env overrides', () => {
    expect(USAGE).toContain('--repo <dir>');
    expect(USAGE).toContain('HARNESS_RUNS_DIR');
    expect(USAGE).toContain('HARNESS_TOKENS_DIR');
    expect(USAGE).toMatch(/check --api <dir>[\s\S]*absolute or relative/);
  });

  it('plugins listing widens the name column for long names', async () => {
    const lines: string[] = [];
    await main(['plugins'], (l) => lines.push(l));
    const rows = lines.filter((l) => l.startsWith('  ') && l.includes('plugins/'));
    expect(rows.length).toBeGreaterThan(0);
    // every row's file column starts at the same offset
    const offsets = new Set(rows.map((r) => r.indexOf('plugins/')));
    expect(offsets.size).toBe(1);
  });
});
