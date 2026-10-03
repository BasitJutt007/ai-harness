/**
 * Execution isolation for agent-written code (the test runner, runtime probes, contract
 * schema extraction, tsc over the agent's tsconfig). exec.ts routes every call that carries a
 * SandboxPolicy through wrap():
 *
 *   sandbox-exec (macOS)  generated Seatbelt profile on top of (allow default):
 *                         - writes only inside the policy's writable dirs;
 *                         - reads fenced: nothing under the operator's home, /Users, /Volumes,
 *                           /private/tmp, /private/var/folders or the harness root, except an
 *                           allow-list derived from the call (readFence) plus stat() on its ancestors;
 *                         - well-known credential stores denied LAST, so no allow re-opens them;
 *                         - mach-lookup limited to name resolution and logging, no Apple events;
 *                         - outbound network loopback only ('localhost') or none ('none').
 *   bwrap (Linux)         read-only bind of /, then fresh tmpfs over /tmp, /var/tmp, /run, /home
 *                         (and the operator's home / the harness root when elsewhere), the same
 *                         allow-list bound back read-only, credential stores masked, writable dirs
 *                         bound read-write LAST, new network namespace (loopback only), new pid and
 *                         ipc namespaces that die with the harness.
 *
 * The child's environment is an allow-list (confinedEnv), never the caller's env minus a deny list.
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
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HARNESS_ROOT, loadConfig } from './config.ts';
import type { Exec, SandboxMechanism, SandboxPolicy } from './types.ts';

export type SandboxMode = 'auto' | 'off';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** One-line description of what the confinement guarantees (run.json, honesty, doctor). */
export const POLICY_SUMMARY =
  'agent code: reads only its worktree, node_modules and toolchain; writes only to a per-call temp dir; env allow-list; network loopback only';

/**
 * A SandboxPolicy plus values the harness itself sets in the confined child's environment
 * (test-only config such as a task's runtime env). They are never copied from process.env.
 * PATH, HOME, USERPROFILE, XDG_*, TMPDIR, TMP and TEMP stay under the harness's control
 * (HOME / TMPDIR given here are honoured only when they lie inside a writable dir).
 */
export interface ConfinedPolicy extends SandboxPolicy {
  env?: Readonly<Record<string, string>>;
}

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

/** p and its realpath (deduplicated): a symlinked path must be allowed under both spellings. */
function spellings(p: string): string[] {
  return [...new Set([resolve(p), realpathLoose(p)])];
}

/** Every ancestor of p, nearest first, up to and including '/'. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = dirname(p);
  for (;;) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/** Credential stores under the operator's home that confined code may not even read. */
const SECRET_STORES = [
  '.ssh', '.aws', '.gnupg', '.azure', '.docker', '.kube', '.config/gh', '.config/gcloud',
  '.netrc', '.npmrc', '.git-credentials', 'Library/Keychains',
];

function secretStores(): string[] {
  const home = homedir();
  return [...new Set(SECRET_STORES.map((s) => join(home, s)).filter((p) => existsSync(p)).map((p) => realpathLoose(p)))];
}

/** macOS directories that hold other people's / other runs' / the operator's private data. */
const PRIVATE_ROOTS_DARWIN = ['/Users', '/Volumes', '/private/tmp', '/private/var/folders'];

/** Linux directories masked with a fresh tmpfs (only the allow-list is bound back). */
const MASKED_LINUX = ['/tmp', '/var/tmp', '/run', '/home', '/root', '/mnt', '/media'];

/** Files of the harness that confined runtimes execute (they import only node: builtins and zod). */
const HARNESS_RUNTIME_FILES = ['package.json', join('plugins', 'lib', 'probe-runtime.ts'), join('plugins', 'lib', 'contract-runtime.ts')];

let cachedWorktreeParent: string | null | undefined;

/** realpath of the configured worktree dir (harness.config.json "worktreeDir"), or null. */
function worktreeParent(): string | null {
  if (cachedWorktreeParent !== undefined) return cachedWorktreeParent;
  try {
    cachedWorktreeParent = realpathLoose(resolve(HARNESS_ROOT, loadConfig(HARNESS_ROOT).worktreeDir));
  } catch {
    cachedWorktreeParent = null;
  }
  return cachedWorktreeParent;
}

function isWorktreeParent(p: string): boolean {
  return p === worktreeParent() || p.endsWith(`${sep}.harness${sep}worktrees`);
}

function isHarnessTmp(p: string): boolean {
  return p.endsWith(`${sep}.harness${sep}tmp`);
}

/**
 * The tree the confined code works in, derived from its cwd:
 *   <worktreeDir>/<runId>/…        → <worktreeDir>/<runId> (the run's worktree, monorepo siblings included)
 *   …/.harness/tmp/<call>/<tree>/… → …/.harness/tmp/<call>/<tree> (a per-call dir holds scratch next to the tree)
 *   …/.harness/tmp/<call>          → itself
 *   anything else                  → the cwd itself
 * A tree that would contain the harness root (an API inside the harness repo, or inside a copy of
 * it that is itself running as the harness) narrows to the cwd: the harness root is never readable whole.
 */
export function enclosingRoot(cwd: string): string {
  const chain = [cwd, ...ancestors(cwd)];
  let root = cwd;
  for (let i = 0; i + 1 < chain.length; i++) {
    const here = chain[i] ?? cwd;
    const parent = chain[i + 1] ?? cwd;
    if (isWorktreeParent(parent)) {
      root = here;
      break;
    }
    if (isHarnessTmp(parent)) {
      root = i > 0 ? (chain[i - 1] ?? here) : here;
      break;
    }
  }
  return spellings(HARNESS_ROOT).some((h) => inside(h, root)) ? cwd : root;
}

/**
 * Realpaths of symlinked packages in a (real) node_modules dir that point outside it: npm / yarn
 * workspaces link to sibling packages of the repo. Links within it (pnpm's .pnpm store) need nothing.
 */
function linkedPackages(nm: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= 500) return;
      const p = join(dir, n);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) {
          const target = realpathSync(p);
          if (!inside(target, nm)) out.push(target);
        } else if (depth === 0 && n.startsWith('@') && st.isDirectory()) visit(p, 1);
      } catch {
        // dangling link: nothing to allow
      }
    }
  };
  visit(nm, 0);
  return out;
}

/** What confined code may read: computed per call from the command, its cwd and the writable dirs. */
export interface ReadFence {
  /** Roots under which everything is unreadable unless allowed (macOS only; Linux masks MASKED_LINUX). */
  deny: string[];
  /** Readable roots (files or directories), every symlinked one under both spellings. */
  allow: string[];
  /** Ancestors of every allowed root: stat()/lstat() only (node's realpath walks them), never readdir. */
  metadata: string[];
  /** Credential stores, denied after (and despite) every allow. */
  secrets: string[];
}

/**
 * Derive the read allow-list for running `cmd` in `cwd` with `writable` dirs:
 *  1. the enclosing worktree (enclosingRoot), never wider than the run's own tree;
 *  2. every node_modules found walking up from the cwd, plus the cmd's own node_modules, the
 *     harness's node_modules (the runtimes import zod from it) and packages symlinked into them;
 *  3. the harness runtime files (package.json, probe-runtime.ts, contract-runtime.ts), not the harness root;
 *  4. the node installation (dirname(dirname(realpath(node)))), so nvm / volta / fnm installs work;
 *  5. the writable dirs.
 * Throws if an allowed root is '/', contains the operator's home, or contains the harness root
 * (which holds .git, runs/, tokens/ and other runs' worktrees), or if the cwd's tree spans the
 * worktree dir or .harness/tmp (every run's trees).
 */
export function readFence(cmd: string, cwd: string, writable: string[]): ReadFence {
  const homes = spellings(homedir());
  const harness = spellings(HARNESS_ROOT);
  const forbidden = (r: string): string | null => {
    if (r === dirname(r)) return 'is the filesystem root';
    if (homes.some((h) => inside(h, r))) return "contains the operator's home directory";
    if (harness.some((h) => inside(h, r))) return 'contains the harness root';
    return null;
  };
  // Dirs that hold every run's trees: the code's own tree may sit inside one, never span one.
  const runParents = [worktreeParent(), join(HARNESS_ROOT, '.harness', 'worktrees'), join(HARNESS_ROOT, '.harness', 'tmp')]
    .filter((p): p is string => p !== null)
    .flatMap(spellings);
  const required: string[] = [];
  const optional: string[] = [];
  for (const c of spellings(cwd)) {
    const root = enclosingRoot(c);
    const spans = runParents.find((p) => inside(p, root));
    if (forbidden(root) === null && spans !== undefined) {
      throw new Error(`sandbox: refusing to make ${root} readable: it contains ${spans}, which holds other runs' trees`);
    }
    required.push(root);
  }
  for (const w of writable) required.push(w);
  const nodeModules: string[] = [];
  for (const c of spellings(cwd)) {
    for (const dir of [c, ...ancestors(c)]) {
      const nm = join(dir, 'node_modules');
      if (existsSync(nm)) nodeModules.push(nm);
    }
  }
  if (isAbsolute(cmd)) {
    const parts = resolve(cmd).split(sep);
    const at = parts.lastIndexOf('node_modules');
    if (at > 0) nodeModules.push(parts.slice(0, at + 1).join(sep));
  }
  const harnessNm = join(HARNESS_ROOT, 'node_modules');
  if (existsSync(harnessNm)) nodeModules.push(harnessNm);
  for (const nm of nodeModules) optional.push(...spellings(nm));
  for (const nm of new Set(nodeModules.map((n) => realpathLoose(n)))) optional.push(...linkedPackages(nm));
  for (const f of HARNESS_RUNTIME_FILES) {
    const p = join(HARNESS_ROOT, f);
    if (existsSync(p)) optional.push(...spellings(p));
  }
  optional.push(dirname(dirname(realpathLoose(process.execPath))));

  const allow: string[] = [];
  for (const r of required) {
    for (const s of spellings(r)) {
      const why = forbidden(s);
      if (why !== null) throw new Error(`sandbox: refusing to make ${s} readable: it ${why}`);
      allow.push(s);
    }
  }
  // Derived from the environment (node install, linked packages): skipped, not fatal, when too wide.
  for (const r of optional) if (forbidden(r) === null) allow.push(r);
  const uniqAllow = [...new Set(allow)];

  const deny = [...new Set([...homes, ...PRIVATE_ROOTS_DARWIN, ...harness])]
    .filter((d) => existsSync(d))
    .map((d) => realpathLoose(d));
  const wt = worktreeParent();
  if (wt !== null && existsSync(wt)) deny.push(wt);
  return {
    deny: [...new Set(deny)],
    allow: uniqAllow,
    metadata: [...new Set(uniqAllow.flatMap(ancestors))],
    secrets: secretStores(),
  };
}

/** Number of -D parameters of each kind a Seatbelt profile takes (see seatbeltProfile). */
export interface ProfileCounts {
  writable: number;
  deny: number;
  allow: number;
  metadata: number;
  secrets: number;
}

/** Name resolution (getaddrinfo / getpwuid), notifications and logging: all a confined toolchain needs. */
const MACH_ALLOWED = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.notification_center',
  'com.apple.system.logger',
  'com.apple.dnssd.service',
];

/**
 * The Seatbelt profile. Paths are passed as -D parameters (W* writable, D* read-denied roots,
 * R* readable roots, M* metadata-only ancestors, S* credential stores), never interpolated.
 * The last matching rule wins, so the order is: deny reads under D, allow R, allow stat on M,
 * deny S again.
 */
export function seatbeltProfile(c: ProfileCounts, network: SandboxPolicy['network']): string {
  const list = (prefix: string, n: number, kind: 'subpath' | 'literal'): string =>
    Array.from({ length: n }, (_, i) => `(${kind} (param "${prefix}${i}"))`).join(' ');
  const devices = '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (subpath "/dev/fd")';
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-not (require-any ${list('W', c.writable, 'subpath')} ${devices})))`,
  ];
  if (c.deny > 0) lines.push(`(deny file-read* ${list('D', c.deny, 'subpath')})`);
  if (c.allow > 0) lines.push(`(allow file-read* ${list('R', c.allow, 'subpath')})`);
  if (c.metadata > 0) lines.push(`(allow file-read-metadata ${list('M', c.metadata, 'literal')})`);
  if (c.secrets > 0) lines.push(`(deny file-read* ${list('S', c.secrets, 'subpath')})`);
  lines.push('(deny mach-lookup)');
  lines.push(`(allow mach-lookup ${MACH_ALLOWED.map((n) => `(global-name "${n}")`).join(' ')})`);
  lines.push('(deny appleevent-send)');
  lines.push(network === 'localhost' ? '(deny network-outbound (require-not (remote ip "localhost:*")))' : '(deny network-outbound)');
  return lines.join('\n');
}

/**
 * The bwrap argv (before `--`): read-only /, private dirs masked with tmpfs, the allow-list bound
 * back read-only (parents before children), credential stores masked, writable dirs bound LAST.
 */
export function bwrapArgs(fence: ReadFence, writable: string[], cwd: string): string[] {
  const a = ['--die-with-parent', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  const masked: string[] = [];
  const mask = (d: string): void => {
    if (masked.some((m) => inside(d, m))) return;
    masked.push(d);
    a.push('--tmpfs', d);
  };
  for (const d of MASKED_LINUX) if (existsSync(d)) mask(d);
  for (const h of spellings(homedir())) if (existsSync(h)) mask(h);
  for (const h of spellings(HARNESS_ROOT)) if (existsSync(h)) mask(h);
  const wt = worktreeParent();
  if (wt !== null && existsSync(wt)) mask(wt);
  // NixOS keeps the system profile (PATH) under /run.
  const binds = [...fence.allow, ...(existsSync('/run/current-system') ? ['/run/current-system'] : [])]
    .filter((r) => existsSync(r))
    .sort((x, y) => x.split(sep).length - y.split(sep).length || x.localeCompare(y));
  for (const r of binds) a.push('--ro-bind', r, r);
  for (const s of fence.secrets) {
    if (statSync(s).isDirectory()) a.push('--tmpfs', s);
    else a.push('--ro-bind', '/dev/null', s);
  }
  for (const w of writable) a.push('--bind', w, w);
  a.push('--chdir', realpathLoose(cwd));
  return a;
}

/** Inherited from the caller's env when set; every other variable is dropped. */
const INHERITED_ENV = /^(LANG|LANGUAGE|LC_[A-Z_]+|TZ|CI)$/;
/** Set by the harness for every confined child: its output is always captured, never a terminal. */
const HARNESS_ENV: Readonly<Record<string, string>> = { NO_COLOR: '1', FORCE_COLOR: '0' };
/** Variables only the harness decides (policy.env cannot override them; HOME/TMPDIR are honoured inside writable dirs). */
const FIXED_ENV = new Set(['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP']);

/** node's own directory first (the .bin launchers are `#!/usr/bin/env node`), then the system dirs; no version-manager shims. */
export function confinedPath(): string {
  const dirs = [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (existsSync('/run/current-system/sw/bin')) dirs.push('/run/current-system/sw/bin');
  return [...new Set(dirs)].join(delimiter);
}

/**
 * The environment of a confined child: an allow-list, never the caller's env minus a deny list.
 * Inherited (only when set): LANG, LANGUAGE, LC_*, TZ, CI. Set by the harness: NO_COLOR/FORCE_COLOR,
 * policy.env, PATH (confinedPath), HOME/USERPROFILE/XDG_* (the caller's HOME when it lies inside a
 * writable dir, else <writable[0]>/home) and TMPDIR/TMP/TEMP (the caller's TMPDIR when inside a writable
 * dir, else writable[0]). Dropped: everything else, including NODE_OPTIONS, NODE_PATH, proxies, GIT_*,
 * npm_* and every credential, whatever its name.
 */
export function confinedEnv(source: NodeJS.ProcessEnv, policy: ConfinedPolicy): NodeJS.ProcessEnv {
  const writable = policy.writable.map((w) => realpathLoose(w));
  const first = writable[0];
  if (first === undefined) throw new Error('sandbox policy needs at least one writable directory');
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && INHERITED_ENV.test(k)) out[k] = v;
  Object.assign(out, HARNESS_ENV);
  const extra = policy.env ?? {};
  for (const [k, v] of Object.entries(extra)) if (!FIXED_ENV.has(k)) out[k] = v;
  const within = (p: string | undefined): p is string =>
    p !== undefined && isAbsolute(p) && writable.some((w) => inside(realpathLoose(p), w));
  const pick = (name: string, fallback: string): string => [extra[name], source[name]].find(within) ?? fallback;
  const home = pick('HOME', join(first, 'home'));
  const tmp = pick('TMPDIR', first);
  return {
    ...out,
    PATH: confinedPath(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
  };
}

export interface Wrapped {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mechanism: SandboxMechanism;
}

/**
 * Build the confined invocation of `cmd args` in `cwd` for `mechanism` (default: detectMechanism()).
 * The env is confinedEnv(env, policy): an allow-list with HOME and TMPDIR inside a writable dir. The
 * read fence is derived from cmd, cwd (default: the first writable dir) and the writable dirs. With
 * mechanism 'none' the command is returned unchanged: callers decide whether that is allowed (exec
 * refuses in 'auto').
 */
export function wrap(
  cmd: string,
  args: string[],
  policy: ConfinedPolicy,
  env: NodeJS.ProcessEnv,
  mechanism: SandboxMechanism = detectMechanism(),
  cwd?: string,
): Wrapped {
  if (policy.writable.length === 0) throw new Error('sandbox policy needs at least one writable directory');
  const writable = [...new Set(policy.writable.map((w) => realpathLoose(w)))];
  const outEnv = confinedEnv(env, policy);
  if (mechanism !== 'sandbox-exec' && mechanism !== 'bwrap') return { cmd, args, env: outEnv, mechanism: 'none' };
  const fence = readFence(cmd, cwd ?? writable[0] ?? '/', writable);
  if (mechanism === 'sandbox-exec') {
    const params: string[] = [];
    const add = (prefix: string, values: string[]): void => values.forEach((v, i) => params.push('-D', `${prefix}${i}=${v}`));
    add('W', writable);
    add('D', fence.deny);
    add('R', fence.allow);
    add('M', fence.metadata);
    add('S', fence.secrets);
    const counts = { writable: writable.length, deny: fence.deny.length, allow: fence.allow.length, metadata: fence.metadata.length, secrets: fence.secrets.length };
    return { cmd: SANDBOX_EXEC, args: [...params, '-p', seatbeltProfile(counts, policy.network), cmd, ...args], env: outEnv, mechanism };
  }
  // --unshare-net leaves only loopback (bwrap brings `lo` up), which is what both policies allow.
  return { cmd: onPath('bwrap') ?? 'bwrap', args: [...bwrapArgs(fence, writable, cwd ?? writable[0] ?? '/'), '--', cmd, ...args], env: outEnv, mechanism };
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

/** Name of the env canary the self-test plants in the caller's env (a connection-string-shaped name). */
export const ENV_CANARY = 'SANDBOX_CANARY_DATABASE_URL';

// Self-test child: try an outside write, an outside read, the env canary and a non-loopback connect;
// print what happened as one JSON line. 192.0.2.1 is TEST-NET-1 (RFC 5737): nobody's server.
// Blocked = EPERM/EACCES (Seatbelt), ENOENT (bwrap's tmpfs hides it) or ENETUNREACH (no route in bwrap's netns).
const SELF_TEST_CHILD = `
const fs = require('node:fs'); const net = require('node:net');
const out = {};
try { fs.writeFileSync(process.argv[1], 'x'); out.write = 'written'; } catch (e) { out.write = e.code || String(e); }
try { fs.readFileSync(process.argv[2], 'utf8'); out.read = 'read'; } catch (e) { out.read = e.code || String(e); }
out.env = process.env[${JSON.stringify(ENV_CANARY)}] === undefined ? 'absent' : 'present';
const s = net.connect({ host: '192.0.2.1', port: 443 });
const done = (v) => { if (out.net) return; out.net = v; s.destroy(); process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0); };
s.on('connect', () => done('connected'));
s.on('error', (e) => done(e.code || String(e)));
setTimeout(() => done('timeout'), 3000);
`;

const BLOCKED = new Set(['EPERM', 'EACCES', 'ENETUNREACH']);
const READ_BLOCKED = new Set(['EPERM', 'EACCES', 'ENOENT']);

/**
 * Spawn a confined node child (policy: writable [scratch/inner], network 'localhost') that tries to
 * write scratch/outside.txt, read scratch/canary/secret.txt (outside its read allow-list), see an env
 * canary planted in its caller's env, and connect to a non-loopback address. ok iff all were refused.
 */
export async function isolationSelfTest(run: Exec, scratch: string): Promise<{ ok: boolean; detail: string }> {
  const innerDir = join(scratch, 'inner');
  const target = join(scratch, 'outside.txt');
  const canaryDir = join(scratch, 'canary');
  const canary = join(canaryDir, 'secret.txt');
  mkdirSync(innerDir, { recursive: true });
  mkdirSync(canaryDir, { recursive: true });
  writeFileSync(canary, 'sandbox-read-canary\n');
  try {
    const r = await run(process.execPath, ['-e', SELF_TEST_CHILD, target, canary], {
      cwd: innerDir,
      timeoutMs: 20_000,
      env: { ...process.env, [ENV_CANARY]: 'postgres://canary:canary@127.0.0.1:5/canary' },
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
    const field = (k: string): string => (typeof rec[k] === 'string' ? rec[k] : 'unknown');
    const write = field('write');
    const read = field('read');
    const env = field('env');
    const netRes = field('net');
    const writeBlocked = write !== 'written' && !existsSync(target);
    const readBlocked = READ_BLOCKED.has(read);
    const envBlocked = env === 'absent';
    const netBlocked = BLOCKED.has(netRes);
    return {
      ok: writeBlocked && readBlocked && envBlocked && netBlocked,
      detail: [
        `outside write ${writeBlocked ? `refused (${write})` : 'SUCCEEDED'}`,
        `outbound connect ${netBlocked ? `refused (${netRes})` : `NOT refused (${netRes})`}`,
        `outside read ${readBlocked ? `refused (${read})` : `NOT refused (${read})`}`,
        `env canary ${envBlocked ? 'not visible' : `VISIBLE (${env})`}`,
      ].join('; '),
    };
  } finally {
    rmSync(canaryDir, { recursive: true, force: true });
  }
}
