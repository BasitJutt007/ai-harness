import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { bin, exec, safeEnv } from '../../src/core/exec.ts';
import { detectMechanism, sandboxMode } from '../../src/core/sandbox.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('config');
afterAll(() => tmp.cleanup());

describe('config', () => {
  it('HARNESS_ROOT is the repo root without a trailing slash', () => {
    expect(HARNESS_ROOT.endsWith('/')).toBe(false);
    expect(existsSync(join(HARNESS_ROOT, 'harness.config.json'))).toBe(true);
  });

  it('loads the repo harness.config.json', () => {
    const c = loadConfig();
    expect(c.pluginDirs).toEqual(['plugins']);
    expect(c.protectedBranches).toContain('main');
    expect(c.history.keepRecentTurns).toBe(2);
    expect(c.limits.maxReadLines).toBe(160);
    expect(c.sandbox).toBe('auto');
  });

  it('fills defaults for a partial config and an absent file', () => {
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({ disabled: ['x'] }));
    const c = loadConfig(tmp.dir);
    expect(c.disabled).toEqual(['x']);
    expect(c.worktreeDir).toBe('.harness/worktrees');
    expect(c.limits).toEqual({ maxReadLines: 160, maxListEntries: 200, maxSearchHits: 40 });
    expect(loadConfig(join(tmp.dir, 'nope')).runsDir).toBe('runs');
    expect(c.sandbox).toBe('auto');
  });

  it('rejects invalid values and unknown keys', () => {
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({ pluginDirs: 'plugins' }));
    expect(() => loadConfig(tmp.dir)).toThrow(/pluginDirs/);
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({ bogus: 1 }));
    expect(() => loadConfig(tmp.dir)).toThrow(/bogus/);
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({ sandbox: 'maybe' }));
    expect(() => loadConfig(tmp.dir)).toThrow(/sandbox/);
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({ sandbox: 'off' }));
    expect(loadConfig(tmp.dir).sandbox).toBe('off');
  });
});

describe('exec', () => {
  it('safeEnv strips credential-looking variables', () => {
    const env = safeEnv({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_BASE_URL: 'b',
      MY_API_KEY: 'c',
      GITHUB_TOKEN: 'd',
      CLIENT_SECRET_X: 'e',
      DB_PASSWORD: 'f',
      KEEP_ME: 'g',
      TOKENIZER: 'h',
    });
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'MY_API_KEY', 'GITHUB_TOKEN', 'CLIENT_SECRET_X', 'DB_PASSWORD']) {
      expect(env[k]).toBeUndefined();
    }
    expect(env.KEEP_ME).toBe('g');
    expect(env.TOKENIZER).toBe('h');
    expect(env.PATH).toBeDefined();
  });

  it('child never sees secrets, even with explicit opts.env', async () => {
    const r = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.X_API_KEY ?? null, process.env.VISIBLE ?? null]))'], {
      cwd: HARNESS_ROOT,
      env: { ...process.env, X_API_KEY: 'leak', VISIBLE: 'yes' },
    });
    expect(JSON.parse(r.stdout)).toEqual([null, 'yes']);
  });

  it('returns exit codes without throwing and captures output + stdin', async () => {
    const ok = await exec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd: HARNESS_ROOT, input: 'hello' });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('hello');
    expect(ok.timedOut).toBe(false);
    const bad = await exec(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], { cwd: HARNESS_ROOT });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain('boom');
  });

  it('does not use a shell', async () => {
    const r = await exec(process.execPath, ['-e', 'console.log(process.argv[1])', '$(echo pwned)'], { cwd: HARNESS_ROOT });
    expect(r.stdout.trim()).toBe('$(echo pwned)');
  });

  it('reports a missing binary as code null', async () => {
    const r = await exec('definitely-not-a-binary-xyz', [], { cwd: HARNESS_ROOT });
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('kills on timeout', async () => {
    const r = await exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: HARNESS_ROOT, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('marks sandboxed results with the mechanism and leaves trusted ones unmarked', async () => {
    const plain = await exec(process.execPath, ['-e', '0'], { cwd: HARNESS_ROOT });
    expect('sandbox' in plain).toBe(false);
    const confined = await exec(process.execPath, ['-e', '0'], { cwd: tmp.dir, sandbox: { writable: [tmp.dir], network: 'none' } }).catch((e: unknown) => e);
    const mechanism = detectMechanism();
    if (mechanism === 'none' && sandboxMode() === 'auto') expect(String(confined)).toMatch(/execution isolation unavailable/);
    else expect(confined).toMatchObject({ code: 0, sandbox: sandboxMode() === 'off' ? 'none' : mechanism });
  });

  it('bin() points into node_modules/.bin', () => {
    expect(bin('vitest')).toBe(join(HARNESS_ROOT, 'node_modules', '.bin', 'vitest'));
    expect(existsSync(bin('tsc'))).toBe(true);
  });
});
