/**
 * Reading an item's metric for the outcome check: the contract's Measure command, run by the harness
 * at a named commit of the target repository. A metric is never typed by a person and never reported
 * by the agent.
 *
 * - The commit gets its own detached worktree under .harness/measure/, with the clone's node_modules
 *   linked in, so the reading sees exactly that commit's files and nothing of a working tree.
 * - The script lives in metrics/ under the items root (measureScriptPath): the harness root in file
 *   mode, a session's state directory in a session. No model tool can write either (path-guard confines
 *   model writes to the run's workspace). It runs confined (no network, writes only to its own temp
 *   directory), from a copy in that temp directory because the sandbox never lets confined code read
 *   the harness root; the reading records the script's sha256, so a before and an after taken with
 *   different scripts are never compared.
 * - It runs twice. Both runs must exit 0 and print the same number as their last stdout line; a
 *   non-zero exit, a timeout, a non-numeric last line or two different numbers is no reading (fail
 *   closed), and the reason says which.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec as coreExec } from './exec.ts';
import type { MeasureSpec, MetricReading } from './items.ts';
import { linkDependencies } from './target.ts';
import type { Exec } from './types.ts';

export const MEASURE_TIMEOUT_MS = 300_000;
export const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

export type MeasureResult = { ok: true; reading: MetricReading } | { ok: false; reason: string };

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The number a Measure run printed: its last non-empty stdout line, which must be a plain number, or a
 * JSON object whose `value` is a finite number (`{"metric":"...","value":3}`, the shape a session's
 * propose_contract asks the model's Measure script to print). Anything else is no reading.
 */
export function lastNumber(stdout: string): number | null {
  const last = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).at(-1);
  if (last === undefined) return null;
  if (NUMBER_RE.test(last)) return Number(last);
  if (!last.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(last);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const value: unknown = (v as Record<string, unknown>)['value'];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export interface ReadMetricOptions {
  harnessRoot: string;
  /**
   * The items root whose metrics/ holds the script (docs/contracts/ and items/ live there too).
   * Default: the harness root (file mode, where the two are the same directory).
   */
  itemsRoot?: string;
  /** The target repository clone (its refs and node_modules are used, its working tree never). */
  repoDir: string;
  /** What to read at: a commit sha or a ref such as origin/main. */
  ref: string;
  measure: MeasureSpec;
  exec?: Exec;
  /** Label for the scratch directory (the item slug). */
  label: string;
}

/**
 * The Measure script's file: `<root>/<script>` for the first root in `roots` (the items root, then the
 * harness root when it is another directory) where it is a file. Every candidate must lie inside that
 * root's metrics/ directory (the contract's Measure already names metrics/<file>.mjs, and parseMeasure
 * refuses `..`); a script found under neither root is no reading.
 */
export function measureScriptPath(script: string, roots: readonly string[]): { ok: true; path: string } | { ok: false; reason: string } {
  const candidates = [...new Set(roots.map((r) => resolve(r)))];
  for (const root of candidates) {
    const path = resolve(root, script);
    if (!path.startsWith(`${resolve(root, 'metrics')}/`)) return { ok: false, reason: `Measure script ${script} is outside metrics/` };
    if (existsSync(path) && statSync(path).isFile()) return { ok: true, path };
  }
  const where = candidates.length > 1 ? `in metrics/ under the items root (${candidates[0] ?? ''}) or the harness` : 'in the harness';
  return { ok: false, reason: `Measure script ${script} does not exist ${where}` };
}

export async function readMetric(opts: ReadMetricOptions): Promise<MeasureResult> {
  const run = opts.exec ?? coreExec;
  const found = measureScriptPath(opts.measure.script, [opts.itemsRoot ?? opts.harnessRoot, opts.harnessRoot]);
  if (!found.ok) return { ok: false, reason: found.reason };
  const script = found.path;

  const rev = await run('git', ['-C', opts.repoDir, 'rev-parse', '--verify', `${opts.ref}^{commit}`], { cwd: opts.repoDir });
  if (rev.code !== 0) return { ok: false, reason: `cannot resolve ${opts.ref} in ${opts.repoDir}: ${(rev.stderr || rev.stdout).trim()}` };
  const sha = rev.stdout.trim();
  const top = await run('git', ['-C', opts.repoDir, 'rev-parse', '--show-toplevel'], { cwd: opts.repoDir });
  if (top.code !== 0) return { ok: false, reason: `${opts.repoDir} is not a git repository` };
  const repoTop = realpathSync(top.stdout.trim());

  const scratch = join(opts.harnessRoot, '.harness', 'measure', `${opts.label}-${sha.slice(0, 12)}-${process.pid}-${Date.now()}`);
  const tree = join(scratch, 'tree');
  const tmp = join(scratch, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const scriptSha256 = sha256(readFileSync(script, 'utf8'));
  const copy = join(tmp, 'measure.mjs');
  copyFileSync(script, copy);
  try {
    const add = await run('git', ['-C', repoTop, 'worktree', 'add', '--detach', tree, sha], { cwd: repoTop });
    if (add.code !== 0) return { ok: false, reason: `cannot check out ${sha.slice(0, 12)}: ${(add.stderr || add.stdout).trim()}` };
    linkDependencies(repoTop, '.', tree);

    const values: number[] = [];
    let stdout = '';
    let confinement = 'unknown';
    for (let i = 0; i < 2; i += 1) {
      const r = await run(process.execPath, [copy, ...opts.measure.args], {
        cwd: tree,
        timeoutMs: MEASURE_TIMEOUT_MS,
        env: { TMPDIR: tmp, NODE_OPTIONS: '' },
        sandbox: { writable: [tmp], network: 'none' },
      });
      confinement = r.sandbox ?? 'none';
      if (r.timedOut) return { ok: false, reason: `Measure timed out after ${MEASURE_TIMEOUT_MS / 1000}s at ${sha.slice(0, 12)}` };
      if (r.code !== 0) return { ok: false, reason: `Measure exited ${String(r.code)} at ${sha.slice(0, 12)}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}` };
      const n = lastNumber(r.stdout);
      if (n === null) return { ok: false, reason: `Measure printed no number on its last line at ${sha.slice(0, 12)} (got "${r.stdout.trim().split('\n').at(-1) ?? ''}")` };
      values.push(n);
      stdout = r.stdout;
    }
    if (values[0] !== values[1]) return { ok: false, reason: `Measure is not deterministic at ${sha.slice(0, 12)}: two runs printed ${String(values[0])} and ${String(values[1])}` };
    const excerpt = stdout.trim().split('\n').slice(-6).join('\n');
    return {
      ok: true,
      reading: { value: values[0] ?? Number.NaN, sha, ref: opts.ref, command: opts.measure.text, scriptSha256, stdoutSha256: sha256(stdout), excerpt, confinement },
    };
  } finally {
    await run('git', ['-C', repoTop, 'worktree', 'remove', '--force', tree], { cwd: repoTop }).catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
}
