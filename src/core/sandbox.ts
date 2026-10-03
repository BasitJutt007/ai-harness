/**
 * Execution isolation for agent-written code (the test runner, runtime probes, contract
 * schema extraction). exec.ts routes every call that carries a SandboxPolicy through wrap():
 *
 *   sandbox-exec (macOS)  generated Seatbelt profile: everything allowed except writes outside
 *                         the policy's writable dirs, reads of well-known credential stores,
 *                         and outbound network other than loopback ('localhost') / any ('none').
 *   bwrap (Linux)         read-only bind of /, writable dirs bound read-write, fresh /tmp,
 *                         credential stores masked, new network namespace (loopback only),
 *                         new pid namespace that dies with the harness.
 *
 * Not used: Node's --permission model. Verified on Node 24: a child process started with
 * --allow-child-process (vitest's forks pool needs it) runs any binary unconfined (`touch ~/x`
 * succeeded), and outbound network is not restricted at all.
 *
 * Mode 'auto' (default) with no working mechanism fails closed: exec refuses to run untrusted
 * code. Mode 'off' (HARNESS_SANDBOX=off or harness.config.json "sandbox": "off") runs it
 * unconfined and the run records isolation as UNPROVEN.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Exec, SandboxMechanism, SandboxPolicy } from './types.ts';

export type SandboxMode = 'auto' | 'off';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** One-line description of what the confinement guarantees (run.json, honesty, doctor). */
export const POLICY_SUMMARY = 'agent code: API root read-only, writes only to a per-call temp dir; network loopback only';

let configuredMode: SandboxMode = 'auto';
let cachedMechanism: SandboxMechanism | undefined;

/** Set from harness.config.json "sandbox". HARNESS_SANDBOX=off|auto still overrides it. */
export function setSandboxMode(mode: SandboxMode): void {
  configuredMode = mode;
}

/** Effective mode: HARNESS_SANDBOX env (off|auto) > configured mode > 'auto'. */
export function sandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  const v = env['HARNESS_SANDBOX'];
  if (v === 'off' || v === 'auto') return v;
  return configuredMode;
}

function runs(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Tests only: replace the detected mechanism (undefined = detect again on next use). */
export function forceMechanism(m: SandboxMechanism | undefined): void {
  cachedMechanism = m;
}

/** The best confinement that actually works here (probed once with a trivial confined run). */
export function detectMechanism(): SandboxMechanism {
  if (cachedMechanism !== undefined) return cachedMechanism;
  let m: SandboxMechanism = 'none';
  if (process.platform === 'darwin' && existsSync(SANDBOX_EXEC)) {
    if (runs(SANDBOX_EXEC, ['-p', '(version 1)(allow default)(deny network-outbound)', process.execPath, '-e', '0'])) m = 'sandbox-exec';
  } else if (process.platform === 'linux') {
    const bwrap = onPath('bwrap');
    const probe = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--unshare-pid', '--die-with-parent'];
    if (bwrap !== undefined && runs(bwrap, [...probe, process.execPath, '-e', '0'])) m = 'bwrap';
  }
  cachedMechanism = m;
  return m;
}

/** realpath of p, or of its nearest existing ancestor joined with the missing tail (sandboxes match real paths). */
export function realpathLoose(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Credential stores under the operator's home that confined code may not even read. */
const SECRET_STORES = [
  '.ssh', '.aws', '.gnupg', '.azure', '.docker', '.kube', '.config/gh', '.config/gcloud',
  '.netrc', '.npmrc', '.git-credentials', 'Library/Keychains',
];

function secretStores(): string[] {
  const home = homedir();
  return SECRET_STORES.map((s) => join(home, s)).filter((p) => existsSync(p)).map((p) => realpathLoose(p));
}

export interface Wrapped {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mechanism: SandboxMechanism;
}

/** The Seatbelt profile (paths are passed as -D parameters, never interpolated). */
export function seatbeltProfile(writableCount: number, readDenyCount: number, network: SandboxPolicy['network']): string {
  const writable = Array.from({ length: writableCount }, (_, i) => `(subpath (param "W${i}"))`).join(' ');
  const devices = '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (subpath "/dev/fd")';
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-not (require-any ${writable} ${devices})))`,
  ];
  if (readDenyCount > 0) {
    lines.push(`(deny file-read* ${Array.from({ length: readDenyCount }, (_, i) => `(subpath (param "R${i}"))`).join(' ')})`);
  }
  lines.push(network === 'localhost' ? '(deny network-outbound (require-not (remote ip "localhost:*")))' : '(deny network-outbound)');
  return lines.join('\n');
}

/**
 * Build the confined invocation of `cmd args` for `mechanism` (default: detectMechanism()).
 * TMPDIR/TMP/TEMP are pointed at the first writable dir unless they already point inside one,
 * so temp files (e.g. the tsx cache) land somewhere the child may write. With mechanism 'none'
 * the command is returned unchanged: callers decide whether that is allowed (exec refuses in 'auto').
 */
export function wrap(
  cmd: string,
  args: string[],
  policy: SandboxPolicy,
  env: NodeJS.ProcessEnv,
  mechanism: SandboxMechanism = detectMechanism(),
): Wrapped {
  if (policy.writable.length === 0) throw new Error('sandbox policy needs at least one writable directory');
  const writable = policy.writable.map((w) => realpathLoose(w));
  const first = writable[0] ?? '';
  const outEnv: NodeJS.ProcessEnv = { ...env };
  const tmp = outEnv['TMPDIR'];
  if (tmp === undefined || !writable.some((w) => inside(realpathLoose(tmp), w))) {
    outEnv['TMPDIR'] = first;
    outEnv['TMP'] = first;
    outEnv['TEMP'] = first;
  }
  if (mechanism === 'sandbox-exec') {
    const deny = secretStores();
    const params: string[] = [];
    writable.forEach((w, i) => params.push('-D', `W${i}=${w}`));
    deny.forEach((r, i) => params.push('-D', `R${i}=${r}`));
    return {
      cmd: SANDBOX_EXEC,
      args: [...params, '-p', seatbeltProfile(writable.length, deny.length, policy.network), cmd, ...args],
      env: outEnv,
      mechanism,
    };
  }
  if (mechanism === 'bwrap') {
    // Order matters: later mounts shadow earlier ones, so /tmp is fresh before writable dirs are bound.
    const a = ['--die-with-parent', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
    for (const w of writable) a.push('--bind', w, w);
    for (const r of secretStores()) {
      if (statSync(r).isDirectory()) a.push('--tmpfs', r);
      else a.push('--ro-bind', '/dev/null', r);
    }
    // --unshare-net leaves only loopback (bwrap brings `lo` up), which is what both policies allow.
    return { cmd: onPath('bwrap') ?? 'bwrap', args: [...a, '--', cmd, ...args], env: outEnv, mechanism };
  }
  return { cmd, args, env: outEnv, mechanism: 'none' };
}

/** Error exec raises in 'auto' mode when nothing can confine untrusted code. */
export function isolationUnavailable(): Error {
  return new Error(
    `execution isolation unavailable: no working sandbox on ${process.platform} (need ${SANDBOX_EXEC} on macOS or bwrap on Linux); ` +
      'set HARNESS_SANDBOX=off to run unconfined (recorded as UNPROVEN)',
  );
}

/** What a run records about isolation (run.json `isolation`). */
export interface IsolationInfo {
  mode: SandboxMode;
  mechanism: SandboxMechanism;
  policy: string;
}

export function isolationInfo(): IsolationInfo {
  const mode = sandboxMode();
  return { mode, mechanism: mode === 'off' ? 'none' : detectMechanism(), policy: POLICY_SUMMARY };
}

/** Honesty line: proven when a mechanism confines agent code, UNPROVEN otherwise. */
export function isolationHonesty(info: IsolationInfo): { proven: boolean; line: string } {
  if (info.mechanism !== 'none') return { proven: true, line: `isolation:${info.mechanism} (${info.policy})` };
  return { proven: false, line: info.mode === 'off' ? 'isolation: off (agent code ran unconfined)' : 'isolation: unavailable' };
}

// Self-test child: try an outside write and a non-loopback connect; print what happened as one JSON line.
// 192.0.2.1 is TEST-NET-1 (RFC 5737): nobody's server. Blocked = EPERM/EACCES (Seatbelt) or ENETUNREACH (no route in bwrap's netns).
const SELF_TEST_CHILD = `
const fs = require('node:fs'); const net = require('node:net');
const out = {};
try { fs.writeFileSync(process.argv[1], 'x'); out.write = 'written'; } catch (e) { out.write = e.code || String(e); }
const s = net.connect({ host: '192.0.2.1', port: 443 });
const done = (v) => { if (out.net) return; out.net = v; s.destroy(); process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0); };
s.on('connect', () => done('connected'));
s.on('error', (e) => done(e.code || String(e)));
setTimeout(() => done('timeout'), 3000);
`;

const BLOCKED = new Set(['EPERM', 'EACCES', 'ENETUNREACH']);

/**
 * Spawn a confined node child (policy: writable [scratch/inner], network 'localhost') that tries to
 * write scratch/outside.txt and to connect to a non-loopback address. ok iff both were refused.
 */
export async function isolationSelfTest(run: Exec, scratch: string): Promise<{ ok: boolean; detail: string }> {
  const innerDir = join(scratch, 'inner');
  const target = join(scratch, 'outside.txt');
  mkdirSync(innerDir, { recursive: true });
  const r = await run(process.execPath, ['-e', SELF_TEST_CHILD, target], {
    cwd: innerDir,
    timeoutMs: 20_000,
    sandbox: { writable: [innerDir], network: 'localhost' },
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
  if (line === undefined) return { ok: false, detail: `self-test child produced no result (exit ${String(r.code)}): ${r.stderr.trim().slice(0, 200)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, detail: `unparseable self-test output: ${line.slice(0, 200)}` };
  }
  const rec = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const write = typeof rec['write'] === 'string' ? rec['write'] : 'unknown';
  const netRes = typeof rec['net'] === 'string' ? rec['net'] : 'unknown';
  const writeBlocked = write !== 'written' && !existsSync(target);
  const netBlocked = BLOCKED.has(netRes);
  return {
    ok: writeBlocked && netBlocked,
    detail: `outside write ${writeBlocked ? `refused (${write})` : 'SUCCEEDED'}; outbound connect ${netBlocked ? `refused (${netRes})` : `NOT refused (${netRes})`}`,
  };
}
