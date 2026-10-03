/**
 * Deterministic subprocess execution. No shell, bounded time, bounded output,
 * and provider credentials are always stripped from the child environment.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { HARNESS_ROOT } from './config.ts';
import { isolationUnavailable, sandboxMode, wrap } from './sandbox.ts';
import type { Exec, ExecOptions, ExecResult, SandboxMechanism } from './types.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const IS_WIN = process.platform === 'win32';

// Generic credential/endpoint shapes only: core never names a provider.
const SECRET_ENV = /(API_KEY|_KEY$|_TOKEN$|SECRET|PASSWORD|CREDENTIAL|AUTH|_BASE_URL$)/i;

/** Absolute path of a binary in the harness's node_modules/.bin. */
export function bin(name: string): string {
  return join(HARNESS_ROOT, 'node_modules', '.bin', name);
}

/** process.env (+ extra) without anything that looks like a credential. */
export function safeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return filterEnv({ ...process.env, ...(extra ?? {}) });
}

function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    out[k] = v;
  }
  return out;
}

class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  push(chunk: Buffer): void {
    if (this.size >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_OUTPUT_BYTES - this.size;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }
  text(): string {
    const s = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${s}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : s;
  }
}

export const exec: Exec = (cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> => {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let env = opts.env !== undefined ? filterEnv(opts.env) : safeEnv();
  // Untrusted code (opts.sandbox): confined by the OS sandbox, refused when none works in 'auto' mode.
  let sandbox: SandboxMechanism | undefined;
  if (opts.sandbox !== undefined) {
    if (sandboxMode() === 'off') {
      sandbox = 'none';
    } else {
      let w: ReturnType<typeof wrap>;
      try {
        w = wrap(cmd, args, opts.sandbox, env);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      if (w.mechanism === 'none') return Promise.reject(isolationUnavailable());
      ({ cmd, args, env } = w);
      sandbox = w.mechanism;
    }
  }
  const tag = sandbox !== undefined ? { sandbox } : {};
  return new Promise<ExecResult>((resolve) => {
    const out = new CappedBuffer();
    const err = new CappedBuffer();
    const chan = new CappedBuffer();
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (code: number | null, extraErr?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      const stderr = extraErr !== undefined ? `${err.text()}${extraErr}` : err.text();
      const channel = opts.channel === true ? { channel: chan.text() } : {};
      resolve({ ...tag, ...channel, code, stdout: out.text(), stderr, durationMs: Date.now() - started, timedOut });
    };

    let child: ReturnType<typeof spawn>;
    try {
      // detached → own process group, so a timeout kills grandchildren too (POSIX).
      const stdio: Array<'pipe'> = opts.channel === true ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
      child = spawn(cmd, args, { cwd: opts.cwd, env, shell: false, stdio, detached: !IS_WIN });
    } catch (e) {
      settled = true;
      resolve({
        ...tag,
        code: null,
        stdout: '',
        stderr: `failed to spawn ${cmd}: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - started,
        timedOut: false,
      });
      return;
    }

    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (!IS_WIN && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        // If something still holds the pipes open, stop waiting for 'close'.
        killTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    const fd3 = child.stdio[3];
    if (opts.channel === true && fd3 !== null && fd3 !== undefined && 'on' in fd3) fd3.on('data', (c: Buffer) => chan.push(c));
    child.on('error', (e) => finish(null, `${e.message}\n`));
    child.on('close', (code) => {
      // Reap anything the command left behind in its process group (e.g. a test that
      // spawned a background writer): nothing outlives the call that started it.
      kill('SIGKILL');
      finish(code);
    });

    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    }
  });
};
