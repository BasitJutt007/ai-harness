/**
 * Isolation mode and policy: 'auto' with no working mechanism refuses (fail closed, before any
 * worktree exists), 'off' runs unconfined and is recorded as UNPROVEN, the generated
 * Seatbelt / bwrap invocations confine what the policy says, and the doctor self-test works.
 * Also finding 9: a plugin dir inside the agent-writable worktree dir is never imported.
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { doctorIsolation } from '../../src/core/cli.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { executeRun } from '../../src/core/run.ts';
import {
  detectMechanism,
  forceMechanism,
  isolationHonesty,
  isolationInfo,
  POLICY_SUMMARY,
  sandboxMode,
  seatbeltProfile,
  setSandboxMode,
  SANDBOX_EXEC,
  wrap,
} from '../../src/core/sandbox.ts';
import { layout, type Layout } from './helpers.ts';

let l: Layout;
const savedEnv = process.env['HARNESS_SANDBOX'];
const real = detectMechanism();

beforeAll(() => {
  l = layout('policy');
});
afterEach(() => {
  forceMechanism(undefined);
  setSandboxMode('auto');
  if (savedEnv === undefined) delete process.env['HARNESS_SANDBOX'];
  else process.env['HARNESS_SANDBOX'] = savedEnv;
});
afterAll(() => l.cleanup());

const WRITE_OUTSIDE = ['-e', 'require("node:fs").writeFileSync(process.argv[1], "x"); console.log("wrote")'];

describe('mode', () => {
  it('HARNESS_SANDBOX overrides the configured mode; anything else falls back to it', () => {
    setSandboxMode('off');
    expect(sandboxMode({})).toBe('off');
    expect(sandboxMode({ HARNESS_SANDBOX: 'auto' })).toBe('auto');
    setSandboxMode('auto');
    expect(sandboxMode({ HARNESS_SANDBOX: 'off' })).toBe('off');
    expect(sandboxMode({ HARNESS_SANDBOX: 'yes-please' })).toBe('auto');
  });

  it("'auto' with no working mechanism refuses to run untrusted code", async () => {
    delete process.env['HARNESS_SANDBOX'];
    forceMechanism('none');
    await expect(exec(process.execPath, [...WRITE_OUTSIDE, l.outside], { cwd: l.api, sandbox: { writable: [l.api], network: 'none' } })).rejects.toThrow(
      /execution isolation unavailable: .*HARNESS_SANDBOX=off to run unconfined \(recorded as UNPROVEN\)/,
    );
    expect(existsSync(l.outside)).toBe(false);
    // Trusted commands (no policy) are unaffected.
    expect((await exec(process.execPath, ['-e', '0'], { cwd: l.api })).code).toBe(0);
  });

  it("a run in 'auto' with no mechanism is refused before any worktree or evidence exists", async () => {
    delete process.env['HARNESS_SANDBOX'];
    forceMechanism('none');
    await expect(
      executeRun({
        taskFile: join(HARNESS_ROOT, 'tasks', 'users-api.task.yaml'),
        driver: 'scripted',
        driverOptions: { script: join(HARNESS_ROOT, 'fixtures', 'scripted', 'users-api.json') },
        baseline: false,
        ship: false,
        repoBase: l.dir,
        runsDir: join(l.dir, 'runs'),
        tokensDir: join(l.dir, 'tokens'),
        log: () => undefined,
      }),
    ).rejects.toThrow(/execution isolation unavailable/);
    expect(existsSync(join(l.dir, 'runs'))).toBe(false);
  });

  it("'off' runs unconfined (ExecResult.sandbox 'none') and is recorded as UNPROVEN", async () => {
    process.env['HARNESS_SANDBOX'] = 'off';
    const target = join(l.dir, 'off-mode.txt');
    const r = await exec(process.execPath, [...WRITE_OUTSIDE, target], { cwd: l.api, sandbox: { writable: [l.api], network: 'none' } });
    expect(r.sandbox).toBe('none');
    expect(r.stdout.trim()).toBe('wrote');
    const info = isolationInfo();
    expect(info).toEqual({ mode: 'off', mechanism: 'none', policy: POLICY_SUMMARY });
    expect(isolationHonesty(info)).toEqual({ proven: false, line: 'isolation: off (agent code ran unconfined)' });
  });

  it('a working mechanism is recorded as proven isolation', () => {
    expect(isolationHonesty({ mode: 'auto', mechanism: 'sandbox-exec', policy: POLICY_SUMMARY })).toEqual({
      proven: true,
      line: `isolation:sandbox-exec (${POLICY_SUMMARY})`,
    });
  });

  it('doctor: fails in auto without a mechanism, warns in off, passes its self-test with the real mechanism', async () => {
    const lines: string[] = [];
    delete process.env['HARNESS_SANDBOX'];
    forceMechanism('none');
    expect(await doctorIsolation((s) => lines.push(s))).toBe(false);
    expect(lines.pop()).toMatch(/^isolation FAIL/);
    process.env['HARNESS_SANDBOX'] = 'off';
    expect(await doctorIsolation((s) => lines.push(s))).toBe(true);
    expect(lines.pop()).toMatch(/^isolation warn .*UNPROVEN/);
    if (real === 'none') return;
    delete process.env['HARNESS_SANDBOX'];
    forceMechanism(undefined);
    expect(await doctorIsolation((s) => lines.push(s))).toBe(true);
    expect(lines.pop()).toMatch(new RegExp(`^isolation ok +${real} .*outside write refused .*outbound connect refused`));
  }, 60_000);
});

describe('wrap', () => {
  const policy = { writable: [join(HARNESS_ROOT, '.harness', 'tmp'), '/tmp/harness-x'], network: 'localhost' as const };

  it('sandbox-exec: real paths as -D parameters, writes and network denied by the profile, TMPDIR moved into a writable dir', () => {
    const w = wrap('node', ['a.js'], policy, { TMPDIR: '/somewhere/else', KEEP: '1' }, 'sandbox-exec');
    expect(w.cmd).toBe(SANDBOX_EXEC);
    expect(w.mechanism).toBe('sandbox-exec');
    const w0 = realpathSync(join(HARNESS_ROOT, '.harness', 'tmp'));
    expect(w.args.slice(0, 4)).toEqual(['-D', `W0=${w0}`, '-D', `W1=${process.platform === 'darwin' ? '/private/tmp/harness-x' : '/tmp/harness-x'}`]);
    expect(w.args.slice(-2)).toEqual(['node', 'a.js']);
    const profile = w.args[w.args.indexOf('-p') + 1] ?? '';
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny file-write* (require-not (require-any (subpath (param "W0"))');
    expect(profile).toContain('(deny network-outbound (require-not (remote ip "localhost:*")))');
    expect(w.env).toMatchObject({ TMPDIR: w0, TMP: w0, TEMP: w0, KEEP: '1' });
    // A TMPDIR already inside a writable dir is kept.
    const kept = wrap('node', [], policy, { TMPDIR: join(w0, 'x') }, 'sandbox-exec');
    expect(kept.env['TMPDIR']).toBe(join(w0, 'x'));
  });

  it("network 'none' denies every outbound connection", () => {
    expect(seatbeltProfile(1, 0, 'none')).toContain('(deny network-outbound)');
    expect(seatbeltProfile(1, 0, 'none')).not.toContain('localhost');
    expect(seatbeltProfile(1, 2, 'none')).toContain('(deny file-read* (subpath (param "R0")) (subpath (param "R1")))');
  });

  it('bwrap: read-only root, fresh /tmp BEFORE the writable binds, new net + pid namespaces, dies with the harness', () => {
    const w = wrap('node', ['a.js'], policy, {}, 'bwrap');
    expect(w.mechanism).toBe('bwrap');
    const a = w.args;
    for (const f of ['--die-with-parent', '--unshare-pid', '--unshare-net']) expect(a).toContain(f);
    expect(a.slice(a.indexOf('--ro-bind'), a.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/']);
    const w0 = realpathSync(join(HARNESS_ROOT, '.harness', 'tmp'));
    expect(a.indexOf('--tmpfs')).toBeLessThan(a.indexOf(w0));
    expect(a.slice(a.indexOf(w0) - 1, a.indexOf(w0) + 2)).toEqual(['--bind', w0, w0]);
    expect(a.slice(a.indexOf('--'))).toEqual(['--', 'node', 'a.js']);
  });

  it("mechanism 'none' leaves the command unchanged; an empty writable list is a programming error", () => {
    const w = wrap('node', ['a.js'], policy, {}, 'none');
    expect([w.cmd, ...w.args, w.mechanism]).toEqual(['node', 'a.js', 'none']);
    expect(() => wrap('node', [], { writable: [], network: 'none' }, {}, 'none')).toThrow(/writable/);
  });
});

describe('registry trust boundary (finding 9)', () => {
  it('refuses, and never imports, a plugin dir inside the worktree dir (directly or through a symlink)', async () => {
    const wt = join(l.dir, 'worktrees');
    const inside = join(wt, 'run-1', 'plugins', 'tools');
    mkdirSync(inside, { recursive: true });
    const marker = join(l.dir, 'imported.txt');
    writeFileSync(join(inside, 'evil.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport default 1;\n`);
    const link = join(l.dir, 'innocent-plugins');
    symlinkSync(join(wt, 'run-1', 'plugins'), link, 'dir');
    const reg = await loadRegistry({ ...loadConfig(), worktreeDir: wt, pluginDirs: [join(wt, 'run-1', 'plugins'), link] }, HARNESS_ROOT);
    expect(reg.errors).toHaveLength(2);
    for (const e of reg.errors) expect(e.error).toMatch(/inside the worktree dir .*agent-writable.*executed at import/);
    expect(reg.tools).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('the default config keeps plugins/ (outside .harness/worktrees) loadable', async () => {
    const reg = await loadRegistry(loadConfig(), HARNESS_ROOT);
    expect(reg.errors).toEqual([]);
    expect(reg.tools.length).toBeGreaterThan(0);
  });
});
