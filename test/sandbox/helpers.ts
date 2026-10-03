/**
 * Fixtures for the isolation tests: a throwaway layout under <harness>/.harness/tmp/<unique>/
 *
 *   original/     a committed git repo standing in for the operator's checkout (must survive)
 *   outside.txt   a path outside every writable dir (must never be created)
 *   api/          the API root agent code lives in (package.json; zod/express resolve from the harness)
 *   run-tmp/      the per-run temp dir
 *
 * Every "outside" target lives inside this temp layout, so even an unconfined run damages nothing real.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../../src/core/config.ts';

export const ENV_KEY = 'SANDBOX_PROBE_API_KEY';

export interface Layout {
  dir: string;
  original: string;
  outside: string;
  api: string;
  runTmp: string;
  head: string;
  cleanup(): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function layout(label: string): Layout {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `sandbox-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const original = join(dir, 'original');
  const api = join(dir, 'api');
  const runTmp = join(dir, 'run-tmp');
  for (const d of [original, join(api, 'src'), join(api, 'test'), runTmp]) mkdirSync(d, { recursive: true });
  writeFileSync(join(original, 'keep.txt'), 'operator data\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: original });
  git(original, ['add', '-A']);
  git(original, ['commit', '-q', '-m', 'initial']);
  writeFileSync(join(api, 'package.json'), JSON.stringify({ name: 'sandbox-fixture', type: 'module', private: true }));
  return {
    dir,
    original,
    outside: join(dir, 'outside.txt'),
    api,
    runTmp,
    head: git(original, ['rev-parse', 'HEAD']),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The original checkout is exactly as committed: same HEAD, clean status, file intact, nothing created outside. */
export function untouched(l: Layout): { head: string; status: string; keep: boolean; outside: boolean; files: string[] } {
  return {
    head: git(l.original, ['rev-parse', 'HEAD']),
    status: git(l.original, ['status', '--porcelain']),
    keep: existsSync(join(l.original, 'keep.txt')),
    outside: existsSync(l.outside),
    files: readdirSync(l.original).sort(),
  };
}

/** A loopback TCP server (the parent's, outside the sandbox) so children can prove loopback is (or is not) reachable. */
export async function loopbackServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((s) => {
    s.on('error', () => undefined); // the child hangs up first
    s.end('hi');
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { port, close: () => new Promise<void>((res) => server.close(() => res())) };
}

/** First existing credential store under the real home (reads must be refused), or null. */
export function existingSecretDir(): string | null {
  for (const d of ['.ssh', '.aws', '.gnupg', '.docker', '.kube']) {
    const p = join(homedir(), d);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface AttackTargets {
  outside: string;
  sibling: string;
  repo: string;
  apiFile: string;
  loopbackPort: number;
  secretDir: string | null;
}

/**
 * ESM source of `attack()`: every attempt is recorded, never thrown. Values: 'ok' (the attack worked)
 * or the error code / exit status that stopped it.
 */
export function attackSource(t: AttackTargets): string {
  return `
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
const T = ${JSON.stringify(t)};
function why(e) { return e && e.code ? e.code : e && typeof e.status === 'number' ? 'exit ' + e.status : String(e).slice(0, 80); }
function tcp(host, port) {
  return new Promise((res) => {
    const s = connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res('timeout'); }, 3000);
    s.on('connect', () => { clearTimeout(t); s.destroy(); res('ok'); });
    s.on('error', (e) => { clearTimeout(t); res(why(e)); });
  });
}
export async function attack() {
  const r = {};
  const tryIt = (k, f) => { try { f(); r[k] = 'ok'; } catch (e) { r[k] = why(e); } };
  tryIt('writeOutside', () => writeFileSync(T.outside, 'pwned'));
  tryIt('rmSibling', () => rmSync(T.sibling, { recursive: true }));
  tryIt('gitCommit', () => execFileSync('git', ['-C', T.repo, '-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'pwned'], { stdio: 'pipe' }));
  tryIt('writeApi', () => writeFileSync(T.apiFile, 'export const pwned = 1;\\n'));
  r.netOutbound = await tcp('192.0.2.1', 443);
  r.netLoopback = await tcp('127.0.0.1', T.loopbackPort);
  r.envKey = process.env.${ENV_KEY} === undefined ? 'absent' : 'present';
  if (T.secretDir !== null) tryIt('readSecrets', () => readdirSync(T.secretDir));
  return r;
}
`;
}

/** Parse the `ATTACK {...}` line a malicious module printed. */
export function attackResult(stdout: string): Record<string, string> | null {
  const line = stdout.split('\n').find((l) => l.startsWith('ATTACK '));
  if (line === undefined) return null;
  const parsed: unknown = JSON.parse(line.slice('ATTACK '.length));
  if (typeof parsed !== 'object' || parsed === null) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
  return out;
}

/** Attack outcomes every confined run must show (blocked writes outside, no git, no outbound network, no keys). */
export const BLOCKED_EVERYWHERE = {
  writeOutside: 'EPERM',
  rmSibling: 'EPERM',
  netOutbound: expectBlockedNet(),
  envKey: 'absent',
} as const;

function expectBlockedNet(): string {
  // Seatbelt refuses with EPERM; bwrap's empty network namespace has no route.
  return process.platform === 'darwin' ? 'EPERM' : 'ENETUNREACH';
}
