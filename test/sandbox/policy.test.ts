/**
 * Isolation mode and policy: 'auto' with no working mechanism refuses (fail closed, before any
 * worktree exists), 'off' runs unconfined and is recorded as UNPROVEN, the generated
 * Seatbelt / bwrap invocations confine what the policy says, and the doctor self-test works.
 * Also finding 9: a plugin dir inside the agent-writable worktree dir is never imported.
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { doctorIsolation } from '../../src/core/cli.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { executeRun } from '../../src/core/run.ts';
import {
  confinedPath,
  detectMechanism,
  enclosingRoot,
  forceMechanism,
  isolationHonesty,
  isolationInfo,
  POLICY_SUMMARY,
  readFence,
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
    expect(lines.pop()).toMatch(
      new RegExp(`^isolation ok +${real} .*outside write refused .*outbound connect refused .*outside read refused .*env canary not visible`),
    );
  }, 60_000);
});

describe('wrap', () => {
  const policy = { writable: [join(HARNESS_ROOT, '.harness', 'tmp'), '/tmp/harness-x'], network: 'localhost' as const };
  const w0 = (): string => realpathSync(join(HARNESS_ROOT, '.harness', 'tmp'));

  it('sandbox-exec: real paths as -D parameters, writes and network denied by the profile, env reduced to the allow-list', () => {
    const w = wrap('node', ['a.js'], policy, { TMPDIR: '/somewhere/else', KEEP: '1', LANG: 'C.UTF-8', NODE_OPTIONS: '--inspect' }, 'sandbox-exec', l.api);
    expect(w.cmd).toBe(SANDBOX_EXEC);
    expect(w.mechanism).toBe('sandbox-exec');
    expect(w.args.slice(0, 4)).toEqual(['-D', `W0=${w0()}`, '-D', `W1=${process.platform === 'darwin' ? '/private/tmp/harness-x' : '/tmp/harness-x'}`]);
    expect(w.args.slice(-2)).toEqual(['node', 'a.js']);
    const profile = w.args[w.args.indexOf('-p') + 1] ?? '';
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny file-write* (require-not (require-any (subpath (param "W0"))');
    expect(profile).toContain('(deny network-outbound (require-not (remote ip "localhost:*")))');
    expect(w.env).toMatchObject({ TMPDIR: w0(), TMP: w0(), TEMP: w0(), HOME: join(w0(), 'home'), LANG: 'C.UTF-8', PATH: confinedPath() });
    expect(w.env['KEEP']).toBeUndefined();
    expect(w.env['NODE_OPTIONS']).toBeUndefined();
    // A TMPDIR already inside a writable dir is kept.
    const kept = wrap('node', [], policy, { TMPDIR: join(w0(), 'x') }, 'sandbox-exec', l.api);
    expect(kept.env['TMPDIR']).toBe(join(w0(), 'x'));
  });

  it("the profile: network 'none' denies every outbound connection; read denies, allows, ancestor stats, then credential stores LAST", () => {
    const counts = { writable: 1, deny: 2, allow: 2, metadata: 1, secrets: 2 };
    expect(seatbeltProfile(counts, 'none')).toContain('(deny network-outbound)');
    expect(seatbeltProfile(counts, 'none')).not.toContain('localhost');
    const p = seatbeltProfile(counts, 'none');
    const at = (s: string): number => {
      const i = p.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    const deny = at('(deny file-read* (subpath (param "D0")) (subpath (param "D1")))');
    const allow = at('(allow file-read* (subpath (param "R0")) (subpath (param "R1")))');
    const meta = at('(allow file-read-metadata (literal (param "M0")))');
    const secrets = at('(deny file-read* (subpath (param "S0")) (subpath (param "S1")))');
    // SBPL: the last matching rule wins, so a credential store inside an allowed root stays unreadable.
    expect(deny).toBeLessThan(allow);
    expect(allow).toBeLessThan(meta);
    expect(meta).toBeLessThan(secrets);
    expect(p.trimEnd().split('\n').slice(-1)[0]).toBe('(deny network-outbound)');
    expect(p).toContain('(deny mach-lookup)\n(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo")');
    expect(p).toContain('(deny appleevent-send)');
    // Empty lists emit no rule at all (an empty SBPL filter list is a syntax error).
    expect(seatbeltProfile({ writable: 1, deny: 0, allow: 0, metadata: 0, secrets: 0 }, 'none')).not.toContain('file-read');
  });

  it('sandbox-exec parameters: private roots denied, the call tree / node_modules / runtime / node install allowed, every ancestor stat-able, secrets by realpath', () => {
    const api = join(l.dir, 'api');
    const w = wrap(join(HARNESS_ROOT, 'node_modules', '.bin', 'tsx'), [], { writable: [l.runTmp], network: 'none' }, {}, 'sandbox-exec', api);
    const params = (prefix: string): string[] =>
      w.args.filter((a, i) => w.args[i - 1] === '-D' && a.startsWith(prefix) && /^[A-Z]\d+=/.test(a)).map((a) => a.slice(a.indexOf('=') + 1));
    const deny = params('D');
    const allow = params('R');
    const meta = params('M');
    const real = (p: string): string => realpathSync(p);
    expect(deny).toContain(real(homedir()));
    expect(deny).toContain(real(HARNESS_ROOT));
    if (process.platform === 'darwin') for (const d of ['/Users', '/private/tmp', '/private/var/folders']) expect(deny).toContain(d);
    expect(allow).toContain(real(api));
    expect(allow).toContain(real(l.runTmp));
    expect(allow).toContain(real(join(HARNESS_ROOT, 'node_modules')));
    expect(allow).toContain(real(join(HARNESS_ROOT, 'plugins', 'lib', 'probe-runtime.ts')));
    expect(allow).toContain(dirname(dirname(realpathSync(process.execPath))));
    // never the harness root, its .git, or the layout around the API (sibling checkout)
    for (const no of [HARNESS_ROOT, real(HARNESS_ROOT), real(l.dir), real(l.original)]) expect(allow).not.toContain(no);
    expect(allow.some((a) => a.includes(`${join('.harness', 'worktrees')}`) || a === real(join(HARNESS_ROOT, 'plugins')))).toBe(false);
    for (const a of allow) expect(meta).toContain(dirname(a));
    expect(meta).toContain('/');
  });

  it('bwrap: read-only root, private dirs (incl. /home) masked with tmpfs, allow-list bound back read-only, writable binds LAST', () => {
    const w = wrap('node', ['a.js'], policy, {}, 'bwrap', l.api);
    expect(w.mechanism).toBe('bwrap');
    const a = w.args;
    for (const f of ['--die-with-parent', '--unshare-pid', '--unshare-net', '--unshare-ipc']) expect(a).toContain(f);
    expect(a.slice(a.indexOf('--ro-bind'), a.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/']);
    const tmpfs = a.flatMap((x, i) => (x === '--tmpfs' ? [a[i + 1] ?? ''] : []));
    for (const d of ['/tmp', '/home', '/run']) if (existsSync(d)) expect(tmpfs).toContain(d);
    expect(tmpfs.some((t) => realpathSync(homedir()).startsWith(t))).toBe(true);
    const roBinds = a.flatMap((x, i) => (x === '--ro-bind' && a[i + 1] !== '/' && a[i + 1] !== '/dev/null' ? [i] : []));
    const binds = a.flatMap((x, i) => (x === '--bind' ? [i] : []));
    expect(roBinds.length).toBeGreaterThan(0);
    expect(binds.length).toBe(2);
    // masks, then read-only allow-list, then writable dirs last (later mounts shadow earlier ones)
    expect(a.lastIndexOf('--tmpfs', roBinds[0])).toBeGreaterThan(0);
    expect(Math.max(...roBinds)).toBeLessThan(Math.min(...binds));
    expect(a.slice(binds[0], (binds[0] ?? 0) + 3)).toEqual(['--bind', w0(), w0()]);
    expect(a.slice(a.indexOf('--'))).toEqual(['--', 'node', 'a.js']);
    // read-only binds go parents first, so a child bind is never shadowed by its parent's
    const ro = roBinds.map((i) => a[i + 1] ?? '');
    for (let i = 1; i < ro.length; i++) expect((ro[i - 1] ?? '').split('/').length).toBeLessThanOrEqual((ro[i] ?? '').split('/').length);
  });

  it("refuses to make '/', the operator's home, the harness root or every run's trees readable", () => {
    const refuse = (cwd: string): (() => unknown) => () => wrap('node', [], { writable: [l.runTmp], network: 'none' }, {}, 'sandbox-exec', cwd);
    expect(refuse(homedir())).toThrow(/refusing to make .* readable: it contains the operator's home directory/);
    expect(refuse(dirname(homedir()))).toThrow(/contains the operator's home directory/);
    expect(refuse(HARNESS_ROOT)).toThrow(/contains the harness root/);
    // nor every run's trees at once
    expect(refuse(join(HARNESS_ROOT, '.harness', 'tmp'))).toThrow(/holds other runs' trees/);
    expect(refuse(join(HARNESS_ROOT, '.harness'))).toThrow(/holds other runs' trees/);
    expect(() => wrap('node', [], { writable: ['/'], network: 'none' }, {}, 'bwrap', l.api)).toThrow(/is the filesystem root/);
    expect(() => readFence('node', l.api, [realpathSync(homedir())])).toThrow(/home directory/);
  });

  it('enclosingRoot: the run worktree, a .harness/tmp call tree, else the cwd itself', () => {
    const wt = join(HARNESS_ROOT, '.harness', 'worktrees');
    expect(enclosingRoot(join(wt, 'run-1', 'apps', 'api'))).toBe(join(wt, 'run-1'));
    expect(enclosingRoot(join(wt, 'run-1'))).toBe(join(wt, 'run-1'));
    const tmp = join(HARNESS_ROOT, '.harness', 'tmp');
    expect(enclosingRoot(join(tmp, 'contract-base-1', 'tree', 'apps', 'api'))).toBe(join(tmp, 'contract-base-1', 'tree'));
    expect(enclosingRoot(join(tmp, 'sandbox-x', 'api'))).toBe(join(tmp, 'sandbox-x', 'api'));
    expect(enclosingRoot(join(tmp, 'call-1'))).toBe(join(tmp, 'call-1'));
    expect(enclosingRoot('/srv/some/api')).toBe('/srv/some/api');
    // an API inside the harness repo itself (harness check --api samples/...) never widens to the harness root
    expect(enclosingRoot(join(HARNESS_ROOT, 'samples', 'existing-api'))).toBe(join(HARNESS_ROOT, 'samples', 'existing-api'));
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
