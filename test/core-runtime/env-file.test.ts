/**
 * Provider keys from the owner's env file (temp files only: no test reads ~/.sf-harness). Each rule
 * has its twin: an allowed name is set, any other name is not; an unset variable is set, a set one is
 * never overridden (even when empty); a private file loads quietly, one other users can read loads
 * with a warning; the explicit file wins and is the only one read; no value is ever reported.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerVocabulary } from '../../src/core/cli.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { allowedEnvName, envFileCandidates, envFileLines, loadEnvFile, parseEnvLine } from '../../src/core/env-file.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envfile-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const allowed = allowedEnvName(['ALPHA_API_KEY', 'BETA_API_KEY']);

function file(name: string, text: string, mode = 0o600): string {
  const f = join(dir, name);
  writeFileSync(f, text);
  chmodSync(f, mode);
  return f;
}

describe('which file', () => {
  it('SF_HARNESS_ENV_FILE when set (only it); else env.development, then .env under the state home', () => {
    expect(envFileCandidates({ SF_HARNESS_ENV_FILE: '/x/keys' })).toEqual(['/x/keys']);
    expect(envFileCandidates({ SF_HARNESS_HOME: '/h' })).toEqual(['/h/env.development', '/h/.env']);
  });

  it('the first existing candidate is the only one read', () => {
    const second = file('second', 'ALPHA_API_KEY=from-second\n');
    const first = file('first', 'BETA_API_KEY=from-first\n');
    const env: NodeJS.ProcessEnv = {};
    const r = loadEnvFile({ allowed, env, candidates: [join(dir, 'missing'), first, second] });
    expect(r.file).toBe(first);
    expect(env).toEqual({ BETA_API_KEY: 'from-first' });
  });

  it('none exists: nothing is set, and doctor says where it looked', () => {
    const r = loadEnvFile({ allowed, env: {}, candidates: [join(dir, 'a'), join(dir, 'b')] });
    expect(r.file).toBeNull();
    expect(envFileLines(r)[0]).toBe(`envfile   none (looked for ${join(dir, 'a')}, ${join(dir, 'b')})`);
  });
});

describe('what it sets', () => {
  it('allowed names (credential variables, HARNESS_*) are set; anything else is ignored', () => {
    const f = file('keys', ['# comment', 'export ALPHA_API_KEY="sk-alpha-value"', "HARNESS_SANDBOX='auto'", 'DATABASE_URL=postgres://u:p@h/db', 'not a line', 'BETA_API_KEY=beta # trailing comment', ''].join('\n'));
    const env: NodeJS.ProcessEnv = {};
    const r = loadEnvFile({ allowed, env, candidates: [f] });
    expect(env).toEqual({ ALPHA_API_KEY: 'sk-alpha-value', HARNESS_SANDBOX: 'auto', BETA_API_KEY: 'beta' });
    expect(r.loaded).toEqual(['ALPHA_API_KEY', 'HARNESS_SANDBOX', 'BETA_API_KEY']);
    expect(r.ignored).toBe(2);
  });

  it('a variable already set is never overridden, even when empty (its twin, unset, is set)', () => {
    const f = file('keys', 'ALPHA_API_KEY=from-file\nBETA_API_KEY=from-file\n');
    const env: NodeJS.ProcessEnv = { ALPHA_API_KEY: 'from-shell', BETA_API_KEY: '' };
    const r = loadEnvFile({ allowed, env, candidates: [f] });
    expect(env).toEqual({ ALPHA_API_KEY: 'from-shell', BETA_API_KEY: '' });
    expect(r.kept).toEqual(['ALPHA_API_KEY', 'BETA_API_KEY']);
    expect(r.loaded).toEqual([]);
  });

  it('no value is ever in the result or the doctor lines', () => {
    const f = file('keys', 'ALPHA_API_KEY=super-secret-value-123\n');
    const r = loadEnvFile({ allowed, env: {}, candidates: [f] });
    const shown = JSON.stringify(r) + envFileLines(r).join('\n');
    expect(shown).not.toContain('super-secret-value-123');
    expect(envFileLines(r)[0]).toBe(`envfile   ${f}: supplied ALPHA_API_KEY`);
  });
});

describe('file permissions', () => {
  it('a file other users can read loads, with a warning naming the fix (no value)', () => {
    const f = file('keys', 'ALPHA_API_KEY=v\n', 0o644);
    const env: NodeJS.ProcessEnv = {};
    const r = loadEnvFile({ allowed, env, candidates: [f] });
    expect(env['ALPHA_API_KEY']).toBe('v');
    expect(r.warnings).toEqual([`${f} can be read by other users (mode 644): restrict it with chmod 600 ${f}`]);
  });

  it('twin: a private file (600) loads without a warning', () => {
    const f = file('keys', 'ALPHA_API_KEY=v\n', 0o600);
    expect(loadEnvFile({ allowed, env: {}, candidates: [f] }).warnings).toEqual([]);
  });

  it('a directory in its place is not loaded', () => {
    const d = join(dir, 'adir');
    mkdirSync(d);
    expect(loadEnvFile({ allowed, env: {}, candidates: [d] }).warnings[0]).toMatch(/not a regular file/);
  });
});

describe('the allowed names come from the drivers (the core names no provider)', () => {
  it('the CLI allows exactly the credential variables the driver plugins read, plus HARNESS_*', () => {
    const creds = providerVocabulary(HARNESS_ROOT).credentialVars;
    expect(creds.length).toBeGreaterThanOrEqual(2);
    const ok = allowedEnvName(creds);
    for (const c of creds) expect(ok(c)).toBe(true);
    expect(ok('HARNESS_ITEMS_ROOT')).toBe(true);
    expect(ok('GITHUB_TOKEN')).toBe(false);
    expect(ok('PATH')).toBe(false);
  });

  it('parses quoted, exported and commented lines', () => {
    expect(parseEnvLine('export A_B="x y"')).toEqual(['A_B', 'x y']);
    expect(parseEnvLine("A='q'")).toEqual(['A', 'q']);
    expect(parseEnvLine('A=v # note')).toEqual(['A', 'v']);
    expect(parseEnvLine('# A=v')).toBeNull();
    expect(parseEnvLine('=v')).toBeNull();
  });
});
