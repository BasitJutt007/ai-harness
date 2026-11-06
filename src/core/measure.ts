/**
 * Reading an item's metric for the outcome check: the contract's Measure command, run by the harness
 * at a named commit of the target repository. A metric is never typed by a person and never reported
 * by the agent.
 *
 * - The commit gets its own detached worktree under .harness/measure/, with the clone's node_modules
 *   linked in, so the reading sees exactly that commit's files and nothing of a working tree.
 * - The script lives in metrics/ under the items root (measureScriptPath): the harness root in file
 *   mode, a session's state directory in a session; only the file-mode CLI may also fall back to the
 *   harness's metrics/ (harnessMetrics). No model tool can write either (path-guard confines
 *   model writes to the run's workspace). It runs confined (no network, writes only to its own temp
 *   directory), from a copy in that temp directory because the sandbox never lets confined code read
 *   the harness root; the reading records the script's sha256, so a before and an after taken with
 *   different scripts are never compared.
 * - It runs twice. Both runs must exit 0 and print the same number as their last stdout line; a
 *   non-zero exit, a timeout, a non-numeric last line or two different numbers is no reading (fail
 *   closed), and the reason says which.
 * - What the script prints never leaves this function: a failure says how it failed ("exited 3",
 *   "printed no number"), never what it printed, and a reading holds the number, the commit, the
 *   script's and the output's sha256 and the confinement, never the output (`excerpt` is empty). A
 *   script may be model-written (an interactive session): its output must reach neither the model
 *   nor a record that is committed and pushed.
 * - No `.env*` file of the checked-out commit is there when it runs: every one is removed from the
 *   measure worktree first (and a symlink that points at one), and a reading is refused when one
 *   cannot be removed.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { exec as coreExec } from './exec.ts';
import type { MeasureSpec, MetricReading } from './items.ts';
import { linkDependencies } from './target.ts';
import type { Exec, SandboxMechanism } from './types.ts';

export const MEASURE_TIMEOUT_MS = 300_000;
export const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/** How a Measure run failed (what a caller may repeat to the model: never the output itself). */
export type MeasureFailure = 'setup' | 'env-files' | 'timeout' | 'exit' | 'no-number' | 'nondeterministic';

/**
 * A reading, or why there is none. `unproven` is set on a reading taken by a Measure that ran unconfined
 * (sandbox off or unavailable): it is recorded, and close refuses it (readingUnproven). A failure's
 * `reason` never quotes the script's output; `failure` (and `code` for an exit) say how it failed.
 */
export type MeasureResult = { ok: true; reading: MetricReading; unproven?: string } | { ok: false; reason: string; failure?: MeasureFailure; code?: number | null };

/**
 * A `.env*` entry (file, directory or link) at any depth of a checked-out tree, or a symlink whose target
 * is one; node_modules and .git are not walked. Paths relative to `tree`.
 */
export function envEntries(tree: string): string[] {
  const out: string[] = [];
  const realTree = realpathSync(tree);
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      if (/^\.env/i.test(name)) {
        out.push(relative(tree, abs));
        continue;
      }
      if (name === 'node_modules' || name.toLowerCase() === '.git') continue;
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (st === undefined) continue;
      if (st.isSymbolicLink()) {
        // A link is judged by where it leads (inside the tree or out of it): a .env* anywhere on that path.
        let target: string | null = null;
        try {
          target = realpathSync(abs);
        } catch {
          target = null; // dangling: it reads nothing
        }
        if (target !== null && relative(realTree, target).split(sep).concat(target.split(sep)).some((seg) => /^\.env/i.test(seg))) out.push(relative(tree, abs));
        continue;
      }
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(tree);
  return out.sort();
}

/** The sandbox mechanisms that confine a Measure run; any other confinement value is no confinement. */
const CONFINING: ReadonlySet<string> = new Set<SandboxMechanism>(['sandbox-exec', 'bwrap']);

/**
 * Why a reading proves nothing, or null: the Measure that produced it ran unconfined (sandbox off or
 * unavailable, or not recorded), so anything on the machine could have shaped the number. UNPROVEN.
 */
export function readingUnproven(r: Pick<MetricReading, 'confinement' | 'sha'>): string | null {
  if (CONFINING.has(r.confinement)) return null;
  return `the Measure ran unconfined at ${r.sha.slice(0, 12)} (sandbox: ${r.confinement === '' ? 'not recorded' : r.confinement}), so its number is not proven`;
}

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
  /**
   * Also look in the harness's own metrics/ when the items root has no such script. Opt-in, for the
   * file-mode CLI only (its items root is the harness's, or a stand-in for it): an items root of its
   * own (a session's state directory) never borrows a script it does not hold, so a metric can only
   * be read with the script that root's contract was approved next to.
   */
  harnessMetrics?: boolean;
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
  const own = opts.itemsRoot ?? opts.harnessRoot;
  const found = measureScriptPath(opts.measure.script, opts.harnessMetrics === true ? [own, opts.harnessRoot] : [own, own]);
  if (!found.ok) {
    // One root that is not the harness: say which (measureScriptPath's single-root wording names the harness).
    const alone = opts.harnessMetrics !== true && resolve(own) !== resolve(opts.harnessRoot);
    return { ok: false, failure: 'setup', reason: alone && !/outside metrics/.test(found.reason) ? `Measure script ${opts.measure.script} does not exist in metrics/ under the items root (${own})` : found.reason };
  }
  const script = found.path;

  const rev = await run('git', ['-C', opts.repoDir, 'rev-parse', '--verify', `${opts.ref}^{commit}`], { cwd: opts.repoDir });
  if (rev.code !== 0) return { ok: false, failure: 'setup', reason: `cannot resolve ${opts.ref} in ${opts.repoDir}: ${(rev.stderr || rev.stdout).trim()}` };
  const sha = rev.stdout.trim();
  const top = await run('git', ['-C', opts.repoDir, 'rev-parse', '--show-toplevel'], { cwd: opts.repoDir });
  if (top.code !== 0) return { ok: false, failure: 'setup', reason: `${opts.repoDir} is not a git repository` };
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
    if (add.code !== 0) return { ok: false, failure: 'setup', reason: `cannot check out ${sha.slice(0, 12)}: ${(add.stderr || add.stdout).trim()}` };
    // No secret of the commit is readable by the script: every .env* entry (and a link to one) goes first.
    for (const rel of envEntries(tree)) rmSync(join(tree, rel), { recursive: true, force: true });
    const left = envEntries(tree);
    if (left.length > 0) return { ok: false, failure: 'env-files', reason: `the measure checkout at ${sha.slice(0, 12)} still holds ${left.slice(0, 3).join(', ')} after removing every .env* entry: no reading` };
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
      // What the script printed is never quoted: only how it failed.
      if (r.timedOut) return { ok: false, failure: 'timeout', reason: `Measure timed out after ${MEASURE_TIMEOUT_MS / 1000}s at ${sha.slice(0, 12)}` };
      if (r.code !== 0) return { ok: false, failure: 'exit', code: r.code, reason: `Measure exited ${String(r.code)} at ${sha.slice(0, 12)} (its output is not shown)` };
      const n = lastNumber(r.stdout);
      if (n === null) return { ok: false, failure: 'no-number', reason: `Measure printed no number on its last line at ${sha.slice(0, 12)} (its output is not shown)` };
      values.push(n);
      stdout = r.stdout;
    }
    if (values[0] !== values[1]) return { ok: false, failure: 'nondeterministic', reason: `Measure is not deterministic at ${sha.slice(0, 12)}: two runs printed ${String(values[0])} and ${String(values[1])}` };
    // The number and the reading's metadata only: the output itself stays out of every record.
    const reading: MetricReading = { value: values[0] ?? Number.NaN, sha, ref: opts.ref, command: opts.measure.text, scriptSha256, stdoutSha256: sha256(stdout), excerpt: '', confinement };
    const unproven = readingUnproven(reading);
    return { ok: true, reading, ...(unproven !== null ? { unproven } : {}) };
  } finally {
    await run('git', ['-C', repoTop, 'worktree', 'remove', '--force', tree], { cwd: repoTop }).catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
}
