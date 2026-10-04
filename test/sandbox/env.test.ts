/**
 * The environment side of isolation.
 *  - Confined children (agent code) get an allow-list: LANG, LANGUAGE, LC_*, TZ and CI when set, NO_COLOR /
 *    FORCE_COLOR, policy.env, a fixed PATH and HOME/TMPDIR inside a writable dir. Nothing else, whatever
 *    its name: connection strings, cloud keys, PATs and NODE_OPTIONS never arrive.
 *  - Trusted children (git, gh) get the caller's env minus credential-shaped names and values; harmless
 *    look-alikes (AUTHOR_NAME, PUBLIC_KEY) are kept, and ship passes SSH_AUTH_SOCK / GH_TOKEN explicitly.
 * Every value here is a synthetic canary created by the test; nothing real is read or printed.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { exec, passThroughEnv, safeEnv, secretEnv } from '../../src/core/exec.ts';
import { confinedEnv, confinedPath, detectMechanism, type ConfinedPolicy } from '../../src/core/sandbox.ts';
import { ship, SHIP_ENV_PASS_THROUGH } from '../../src/core/ship.ts';
import type { ExecOptions, ExecResult, RegistryView, RunContext } from '../../src/core/types.ts';

const mechanism = detectMechanism();
const dir = mkdtempSync(join(tmpdir(), 'harness-env-test-'));
const savedMode = process.env['HARNESS_SANDBOX'];
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  if (savedMode === undefined) delete process.env['HARNESS_SANDBOX'];
  else process.env['HARNESS_SANDBOX'] = savedMode;
});

/** Canaries in the shape of real credentials and toolchain-steering variables. */
const CANARIES: Record<string, string> = {
  DATABASE_URL: 'postgres://canary:canary@127.0.0.1:5/canary',
  MONGODB_URI: 'mongodb://canary:canary@127.0.0.1:6/canary',
  REDIS_URL: 'redis://:canary@127.0.0.1:7',
  AWS_ACCESS_KEY_ID: 'AKIAENVCANARY0000000',
  AWS_REGION: 'canary-region-1',
  GITHUB_PAT: 'canary-pat',
  SENTRY_DSN: 'https://canary@sentry.invalid/1',
  SLACK_WEBHOOK_URL: 'https://hooks.invalid/canary',
  JWT_PRIVATE_PEM: 'canary',
  NODE_OPTIONS: '--no-warnings',
  NODE_PATH: '/canary/node_path',
  HTTPS_PROXY: 'http://127.0.0.1:9/',
  GIT_DIR: '/canary/git',
  npm_config_registry: 'http://127.0.0.1:9/',
  OPENAI_API_KEY: 'canary',
  APP_LOOKS_HARMLESS: 'canary',
};

const PRINT_KEYS = 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))';
const PRINT_ENV = (names: string[]): string => `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]))))`;

describe('confined children: env allow-list', () => {
  const policy: ConfinedPolicy = { writable: [dir], network: 'none' };

  it('keeps only LANG/LANGUAGE/LC_*/TZ/CI, sets PATH/HOME/XDG/TMPDIR itself, drops everything else', () => {
    const env = confinedEnv({ ...CANARIES, LANG: 'en_US.UTF-8', LC_ALL: 'C', LANGUAGE: 'en', TZ: 'UTC', CI: 'true', HOME: '/Users/operator', TMPDIR: '/elsewhere' }, policy);
    for (const k of Object.keys(CANARIES)) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ LANG: 'en_US.UTF-8', LC_ALL: 'C', LANGUAGE: 'en', TZ: 'UTC', CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' });
    const w = mkdtempSync(join(dir, 'w-')); // realpath spelling below
    const e2 = confinedEnv({ HOME: '/Users/operator' }, { writable: [w], network: 'none' });
    expect(e2['PATH']).toBe(confinedPath());
    expect(confinedPath().split(':')[0]).toBe(join(process.execPath, '..'));
    expect(e2['HOME']).toBe(join(realpathSync(w), 'home'));
    expect(e2['XDG_CONFIG_HOME']).toBe(join(e2['HOME'] ?? '', '.config'));
    expect(e2['USERPROFILE']).toBe(e2['HOME']);
    expect(e2['TMPDIR']).toBe(e2['TMP']);
    expect(Object.keys(e2).sort()).toEqual(
      ['FORCE_COLOR', 'HOME', 'NO_COLOR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'],
    );
  });

  it("keeps the caller's HOME/TMPDIR only inside a writable dir; policy.env adds harness values but cannot move PATH or HOME", () => {
    const home = join(dir, 'h');
    const env = confinedEnv({ HOME: home, TMPDIR: join(dir, 't') }, { ...policy, env: { APP_REGION: 'test-region', PATH: '/evil', HOME: '/Users/operator' } });
    expect(env['HOME']).toBe(home);
    expect(env['TMPDIR']).toBe(join(dir, 't'));
    expect(env['APP_REGION']).toBe('test-region');
    expect(env['PATH']).toBe(confinedPath());
  });

  it.runIf(mechanism !== 'none')(`a confined child (${mechanism}) sees none of the canaries, keeps LANG, gets policy.env`, async () => {
    const withEnv: ConfinedPolicy = { writable: [dir], network: 'none', env: { APP_REGION: 'test-region' } };
    const r = await exec(process.execPath, ['-e', PRINT_KEYS], { cwd: dir, env: { ...process.env, ...CANARIES, LANG: 'en_US.UTF-8' }, sandbox: withEnv });
    expect(r.sandbox).toBe(mechanism);
    const seen = JSON.parse(r.stdout) as string[];
    for (const k of Object.keys(CANARIES)) expect(seen, k).not.toContain(k);
    expect(seen).toEqual(expect.arrayContaining(['LANG', 'PATH', 'HOME', 'TMPDIR', 'APP_REGION']));
    const v = await exec(process.execPath, ['-e', PRINT_ENV(['LANG', 'APP_REGION'])], { cwd: dir, env: { LANG: 'en_US.UTF-8' }, sandbox: withEnv });
    expect(JSON.parse(v.stdout)).toEqual({ LANG: 'en_US.UTF-8', APP_REGION: 'test-region' });
  });

  it("with the sandbox 'off' the agent code runs unconfined but still gets only the allow-list", async () => {
    process.env['HARNESS_SANDBOX'] = 'off';
    const r = await exec(process.execPath, ['-e', PRINT_KEYS], { cwd: dir, env: { ...process.env, ...CANARIES }, sandbox: { writable: [dir], network: 'none' } });
    expect(r.sandbox).toBe('none');
    const seen = JSON.parse(r.stdout) as string[];
    for (const k of Object.keys(CANARIES)) expect(seen, k).not.toContain(k);
  });
});

describe('trusted children: credential-shaped names and values are stripped, look-alikes kept', () => {
  it('secretEnv: connection strings, cloud keys, PATs, DSNs, webhooks, PEMs, URLs with user info', () => {
    const stripped: Array<[string, string]> = [
      ['DATABASE_URL', 'postgres://localhost/db'],
      ['SHADOW_DATABASE_URL', 'x'],
      ['MONGODB_URI', 'x'],
      ['REDIS_URL', 'x'],
      ['DB_CONNECTION_STRING', 'x'],
      ['AWS_ACCESS_KEY_ID', 'x'],
      ['AWS_PROFILE', 'x'],
      ['GITHUB_PAT', 'x'],
      ['SENTRY_DSN', 'x'],
      ['SLACK_WEBHOOK_URL', 'x'],
      ['JWT_PRIVATE_PEM', 'x'],
      ['SIGNING_KEY', 'x'],
      ['GH_TOKEN', 'x'],
      ['SSH_AUTH_SOCK', '/tmp/agent.sock'],
      ['OPENAI_BASE_URL', 'x'],
      ['COOKIE', 'x'],
      ['UPSTREAM', 'https://user:pass@example.invalid/'],
      ['ARBITRARY_URI', 'amqp://canary@127.0.0.1/'],
      ['BLOB', '-----BEGIN RSA PRIVATE KEY-----\nx'],
    ];
    for (const [k, v] of stripped) expect(secretEnv(k, v), k).toBe(true);
    const kept: Array<[string, string]> = [
      ['AUTHOR_NAME', 'x'],
      ['PUBLIC_KEY', 'x'],
      ['TOKENIZER', 'x'],
      ['KEEP_ME', 'x'],
      ['HOME', '/Users/x'],
      ['PATH', '/usr/bin'],
      ['APP_URL', 'https://example.invalid/'],
      ['NODE_OPTIONS', '--no-warnings'],
    ];
    for (const [k, v] of kept) expect(secretEnv(k, v), k).toBe(false);
    const env = safeEnv({ DATABASE_URL: 'x', AUTHOR_NAME: 'x' });
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['AUTHOR_NAME']).toBe('x');
  });

  it('passThroughEnv keeps exactly the named variables for a trusted child (also through { ...env } copies); a confined child ignores it', async () => {
    const base = { PATH: process.env['PATH'] ?? '', SSH_AUTH_SOCK: '/canary/agent.sock', GH_TOKEN: 'canary-gh', OPENAI_API_KEY: 'canary', DATABASE_URL: 'postgres://canary:canary@h/db' };
    const names = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'OPENAI_API_KEY', 'DATABASE_URL'];
    const plain = await exec(process.execPath, ['-e', PRINT_ENV(names)], { cwd: dir, env: base });
    expect(JSON.parse(plain.stdout)).toEqual({ SSH_AUTH_SOCK: null, GH_TOKEN: null, OPENAI_API_KEY: null, DATABASE_URL: null });
    const env = { ...passThroughEnv(['SSH_AUTH_SOCK', 'GH_TOKEN'], base), EXTRA: '1' };
    const passed = await exec(process.execPath, ['-e', PRINT_ENV(names)], { cwd: dir, env });
    expect(JSON.parse(passed.stdout)).toEqual({ SSH_AUTH_SOCK: '/canary/agent.sock', GH_TOKEN: 'canary-gh', OPENAI_API_KEY: null, DATABASE_URL: null });
    if (mechanism === 'none') return;
    const confined = await exec(process.execPath, ['-e', PRINT_ENV(names)], { cwd: dir, env, sandbox: { writable: [dir], network: 'none' } });
    expect(JSON.parse(confined.stdout)).toEqual({ SSH_AUTH_SOCK: null, GH_TOKEN: null, OPENAI_API_KEY: null, DATABASE_URL: null });
  });

  it("ship's git/gh calls pass SSH_AUTH_SOCK and the forge tokens through (and nothing else credential-shaped)", async () => {
    expect([...SHIP_ENV_PASS_THROUGH]).toEqual(expect.arrayContaining(['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN']));
    const planted: Record<string, string> = { SSH_AUTH_SOCK: '/canary/ship-agent.sock', GH_TOKEN: 'canary-ship-gh', DATABASE_URL: 'postgres://canary:canary@h/db' };
    const saved = new Map(Object.keys(planted).map((k) => [k, process.env[k]] as const));
    Object.assign(process.env, planted);
    const calls: ExecOptions[] = [];
    const fail: ExecResult = { code: 1, stdout: '', stderr: 'stop here', durationMs: 0, timedOut: false };
    const ctx = {
      workspace: { repoRoot: dir, rootRel: '' },
      run: { branch: 'harness/env-test', baseBranch: 'main' },
      config: { protectedBranches: ['main'] },
      exec: (_cmd: string, _args: string[], opts: ExecOptions) => {
        calls.push(opts);
        return Promise.resolve(fail);
      },
    } as unknown as RunContext;
    try {
      const res = await ship({ ctx, registry: { gates: [] } as unknown as RegistryView, dryRun: true });
      expect(res.status).toBe('refused'); // the fake git said no: nothing else ran
      const opts = calls[0];
      expect(opts?.sandbox).toBeUndefined();
      const r = await exec(process.execPath, ['-e', PRINT_ENV(Object.keys(planted))], { cwd: dir, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
      expect(JSON.parse(r.stdout)).toEqual({ SSH_AUTH_SOCK: '/canary/ship-agent.sock', GH_TOKEN: 'canary-ship-gh', DATABASE_URL: null });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
