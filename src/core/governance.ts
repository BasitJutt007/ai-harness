/**
 * What governs a run, recorded in run.json `governance` so `harness agnostic` can prove two runs
 * (different drivers/models) were held to the same rules:
 * - the ACTIVE plugin manifest: every registered (enabled) tool, hook, gate and check with its file
 *   and sha256 (drivers excluded: they legitimately differ). A config that disables a hook changes it.
 * - the governing configuration (harness.config.json as validated, with the effective sandbox mode)
 *   and its sha256. Evidence locations (runsDir, tokensDir) and the worktree dir are where output
 *   goes, not how a run is governed, and are left out.
 * - the core: sha256 of every file under src/core/ (and of the whole set).
 * The run's verdict and gate statuses are recorded beside it (run.json `verdict`, `gateStatuses`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { pluginName } from './registry.ts';
import type { HarnessConfig, RegistryView } from './types.ts';

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with sorted keys: the input of every governance hash. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const ManifestEntrySchema = z.object({
  kind: z.enum(['tool', 'hook', 'gate', 'check']),
  name: z.string(),
  file: z.string(),
  sha256: z.string(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/** Every registered (enabled) tool, hook, gate and check, sorted by kind:name. Drivers are excluded. */
export function activeManifest(reg: RegistryView): ManifestEntry[] {
  const out: ManifestEntry[] = [...reg.tools, ...reg.hooks, ...reg.gates, ...reg.checks].map((r) => ({
    kind: r.plugin.kind,
    name: pluginName(r.plugin),
    file: r.file,
    sha256: r.sha256,
  }));
  return out.sort((a, b) => {
    const ka = `${a.kind}:${a.name}`;
    const kb = `${b.kind}:${b.name}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** The governing part of the configuration: everything but where evidence and worktrees are written. */
export function governingConfig(config: HarnessConfig, effectiveSandbox: HarnessConfig['sandbox']): Record<string, unknown> {
  return {
    pluginDirs: config.pluginDirs,
    disabled: [...config.disabled].sort(),
    protectedBranches: config.protectedBranches,
    templatesDir: config.templatesDir,
    history: config.history,
    limits: config.limits,
    sandbox: effectiveSandbox,
  };
}

/** file (harness-relative) -> sha256 of every file under src/core/, sorted. */
export function coreFiles(harnessRoot: string): Record<string, string> {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) files.push(full);
    }
  };
  const root = join(harnessRoot, 'src', 'core');
  if (existsSync(root) && statSync(root).isDirectory()) visit(root);
  const out: Record<string, string> = {};
  for (const f of files.map((abs) => [toPosix(relative(harnessRoot, abs)), abs] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out[f[0]] = sha256(readFileSync(f[1]));
  }
  return out;
}

const GovernanceSchema = z.object({
  manifest: z.array(ManifestEntrySchema),
  config: z.record(z.string(), z.unknown()),
  configSha256: z.string(),
  core: z.object({ sha256: z.string(), files: z.record(z.string(), z.string()) }),
});
export type Governance = z.infer<typeof GovernanceSchema>;

export function governanceRecord(
  reg: RegistryView,
  config: HarnessConfig,
  harnessRoot: string,
  effectiveSandbox: HarnessConfig['sandbox'],
): Governance {
  const cfg = governingConfig(config, effectiveSandbox);
  const files = coreFiles(harnessRoot);
  return {
    manifest: activeManifest(reg),
    config: cfg,
    configSha256: sha256(stable(cfg)),
    core: { sha256: sha256(stable(files)), files },
  };
}

// ───────────────────────────── harness agnostic ─────────────────────────────

/** What `harness agnostic` reads of a run.json. Every governance field is optional: older runs lack them. */
export const AgnosticRunSchema = z.looseObject({
  driver: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  ok: z.boolean().optional(),
  verdict: z.string().optional(),
  gateStatuses: z.record(z.string(), z.string()).optional(),
  task: z.looseObject({ id: z.string().optional(), sha256: z.string() }),
  pluginFingerprint: z.record(z.string(), z.string()).optional(),
  governance: z.unknown().optional(),
});
export type AgnosticRun = z.infer<typeof AgnosticRunSchema>;

export const DONE = 'DONE';

/** A run's verdict line: "DONE", "NOT DONE (...)", or "not recorded" (an older or unfinished run.json). */
export function runVerdict(r: AgnosticRun): { done: boolean; text: string } {
  if (r.verdict !== undefined) return { done: r.verdict === DONE, text: r.verdict };
  if (r.ok === true) return { done: true, text: `${DONE} (from ok: true; verdict not recorded)` };
  if (r.ok === false) return { done: false, text: `NOT DONE (ok: false, status ${r.status ?? '?'})` };
  return { done: false, text: `not recorded (status ${r.status ?? '?'}): UNPROVEN` };
}

function governanceOf(r: AgnosticRun): Governance | null {
  const g = GovernanceSchema.safeParse(r.governance);
  return g.success ? g.data : null;
}

function short(s: string | undefined): string {
  return s === undefined ? '-' : s.slice(0, 12);
}

/** Every governing difference between two runs; a field either run did not record is a difference (UNPROVEN), never equal. */
export function agnosticDiff(a: AgnosticRun, b: AgnosticRun): string[] {
  const diffs: string[] = [];
  if (a.task.sha256 !== b.task.sha256) diffs.push(`task sha differs: ${short(a.task.sha256)} vs ${short(b.task.sha256)}`);

  const ga = governanceOf(a);
  const gb = governanceOf(b);
  const missing = (what: string): string => `${what}: not recorded in run ${ga === null && gb === null ? 'A and B' : ga === null ? 'A' : 'B'} (older run.json): UNPROVEN`;
  if (ga === null || gb === null) {
    diffs.push(missing('active plugin manifest'), missing('governing config hash'), missing('core hash'));
  } else {
    const key = (e: ManifestEntry): string => `${e.kind}:${e.name}`;
    const ma = new Map(ga.manifest.map((e) => [key(e), e]));
    const mb = new Map(gb.manifest.map((e) => [key(e), e]));
    for (const k of [...new Set([...ma.keys(), ...mb.keys()])].sort()) {
      const x = ma.get(k);
      const y = mb.get(k);
      if (x === undefined) diffs.push(`active only in B: ${k} (${y?.file ?? '?'})`);
      else if (y === undefined) diffs.push(`active only in A: ${k} (${x.file})`);
      else if (x.file !== y.file || x.sha256 !== y.sha256) diffs.push(`plugin changed: ${k} (${x.file} ${short(x.sha256)} vs ${y.file} ${short(y.sha256)})`);
    }
    if (ga.configSha256 !== gb.configSha256) {
      const keys = [...new Set([...Object.keys(ga.config), ...Object.keys(gb.config)])].sort();
      const changed = keys.filter((k) => stable(ga.config[k]) !== stable(gb.config[k]));
      diffs.push(`config hash differs: ${short(ga.configSha256)} vs ${short(gb.configSha256)}${changed.length > 0 ? ` (${changed.map((k) => `${k}: ${stable(ga.config[k])} vs ${stable(gb.config[k])}`).join('; ')})` : ''}`);
    }
    if (ga.core.sha256 !== gb.core.sha256) {
      const files = [...new Set([...Object.keys(ga.core.files), ...Object.keys(gb.core.files)])].sort();
      const changed = files.filter((f) => ga.core.files[f] !== gb.core.files[f]);
      diffs.push(`core hash differs: ${short(ga.core.sha256)} vs ${short(gb.core.sha256)}${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`);
    }
  }

  // Shared helper files under the plugin directories (plugins/lib/**, _*.ts): what the plugins import.
  if (a.pluginFingerprint === undefined || b.pluginFingerprint === undefined) {
    diffs.push(`plugin file fingerprint: not recorded in run ${a.pluginFingerprint === undefined ? 'A' : 'B'}: UNPROVEN`);
  } else {
    const fa = a.pluginFingerprint;
    const fb = b.pluginFingerprint;
    for (const f of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
      const x = fa[f];
      const y = fb[f];
      if (x === undefined) diffs.push(`only in B: ${f}`);
      else if (y === undefined) diffs.push(`only in A: ${f}`);
      else if (x !== y) diffs.push(`changed: ${f} (${short(x)} vs ${short(y)})`);
    }
  }
  return diffs;
}
