/**
 * Plugin discovery. A plugin is a file under a configured plugin directory whose
 * default export is a plugin object (or an array of them). Core never imports
 * plugins statically; it finds them here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathLoose } from './sandbox.ts';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  CheckPlugin,
  DriverPlugin,
  GatePlugin,
  HarnessConfig,
  HookPlugin,
  JsonSchema,
  Plugin,
  PluginRecord,
  RegistryView,
  TaskKind,
  ToolSpec,
} from './types.ts';

// ───────────────────────────── discovery ─────────────────────────────

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Loadable plugin sources: .ts/.mts/.js/.mjs, never declarations, tests or `_`-prefixed files. */
const PLUGIN_EXT = /\.(?:ts|mts|js|mjs)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isPluginFile(name: string): boolean {
  return PLUGIN_EXT.test(name) && !name.startsWith('_') && !DECLARATION.test(name) && !TEST_FILE.test(name);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'lib' || entry.name === 'node_modules' || entry.name.startsWith('.')) {
      if (entry.isDirectory() || entry.isSymbolicLink()) continue;
    }
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const st = statSync(full, { throwIfNoEntry: false });
      isDir = st?.isDirectory() ?? false;
      isFile = st?.isFile() ?? false;
    }
    if (isDir) {
      if (entry.name.startsWith('_')) continue;
      walk(full, out);
    } else if (isFile && isPluginFile(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * TRUST BOUNDARY. Plugins are trusted code: like eslint or vitest plugins, a plugin file is
 * executed by `import()` before its export is validated. Plugin directories are operator
 * configuration and must never be a location the agent can write. Agent-written files persist
 * only in the worktrees (config.worktreeDir); sandboxed agent code can otherwise write only its
 * own per-call temp dir, deleted when the call ends. So a plugin dir that resolves (symlinks
 * included) inside the worktree dir is refused: reported as a load error, never imported.
 */
export function agentWritablePluginDir(config: HarnessConfig, harnessRoot: string, d: string): string | null {
  const dir = realpathLoose(isAbsolute(d) ? d : join(harnessRoot, d));
  const wt = realpathLoose(resolve(harnessRoot, config.worktreeDir));
  const rel = relative(wt, dir);
  const within = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  return within ? `plugin dir "${d}" is inside the worktree dir ${config.worktreeDir} (agent-writable); plugins are executed at import and must never come from there` : null;
}

/** Absolute paths of candidate plugin files, sorted by harness-relative path. */
export function discoverPluginFiles(config: HarnessConfig, harnessRoot: string): string[] {
  const files: string[] = [];
  for (const d of config.pluginDirs) {
    const dir = isAbsolute(d) ? d : join(harnessRoot, d);
    if (agentWritablePluginDir(config, harnessRoot, d) !== null) continue;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    walk(dir, files);
  }
  const uniq = [...new Set(files)];
  return uniq.sort((a, b) => {
    const ra = toPosix(relative(harnessRoot, a));
    const rb = toPosix(relative(harnessRoot, b));
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

// ───────────────────────────── validation ─────────────────────────────

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function', { message: 'expected a function' });
const optFn = fn.optional();
const zodSchema = z.custom<z.ZodType>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    'safeParse' in v &&
    typeof (v as { safeParse: unknown }).safeParse === 'function',
  { message: 'input must be a Zod schema' },
);
const taskKind = z.enum(['greenfield', 'brownfield']);
const effect = z.enum(['read', 'write', 'exec', 'control']);
const name = z.string().min(1);
/** Tool names the model sees: letters, digits, `_` and `-`, starting with a letter (e.g. "openapi-diff"). */
export const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const optText = z.string().optional();

const DriverShape = z.object({
  kind: z.literal('driver'),
  name,
  description: z.string(),
  create: fn,
});
const ToolShape = z.object({
  kind: z.literal('tool'),
  name: z.string().regex(TOOL_NAME, 'tool names must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ (e.g. "openapi-diff")'),
  description: optText,
  input: zodSchema,
  effect,
  fetcher: z.boolean().optional(),
  availableIn: z.array(taskKind).optional(),
  paths: optFn,
  run: fn,
});
const HookShape = z.object({
  kind: z.literal('hook'),
  name,
  description: optText,
  events: z.array(z.enum(['pre_tool', 'post_tool'])).min(1),
  effects: z.array(effect).optional(),
  tools: z.array(z.string()).optional(),
  run: fn,
});
const GateShape = z.object({
  kind: z.literal('gate'),
  name,
  description: optText,
  phases: z.array(z.enum(['finish', 'ship'])).min(1),
  appliesTo: z.array(taskKind).optional(),
  run: fn,
});
const CheckShape = z.object({
  kind: z.literal('check'),
  id: name,
  category: z.string().min(1),
  description: optText,
  unit: z.string().min(1).optional(),
  doc: optText,
  run: fn,
});

const SHAPES = {
  driver: DriverShape,
  tool: ToolShape,
  hook: HookShape,
  gate: GateShape,
  check: CheckShape,
} as const;

type Kind = keyof typeof SHAPES;

function isKind(v: unknown): v is Kind {
  return typeof v === 'string' && Object.hasOwn(SHAPES, v);
}

function issuesText(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

/** Validate one exported value. Returns the plugin (the original object, untouched) or an error message. */
export function validatePlugin(value: unknown): { plugin: Plugin } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'default export is not a plugin object' };
  const kind: unknown = (value as { kind?: unknown }).kind;
  if (!isKind(kind)) return { error: `unknown plugin kind ${JSON.stringify(kind)}` };
  const res = SHAPES[kind].safeParse(value);
  if (!res.success) return { error: `invalid ${kind} plugin: ${issuesText(res.error)}` };
  // Shape verified above; keep the original object so methods keep their `this` and identity.
  return { plugin: value as Plugin };
}

export function pluginName(p: Plugin): string {
  return p.kind === 'check' ? p.id : p.name;
}

// ───────────────────────────── loading ─────────────────────────────

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadRegistry(config: HarnessConfig, harnessRoot: string): Promise<RegistryView> {
  const reg: RegistryView = { drivers: [], tools: [], hooks: [], gates: [], checks: [], errors: [] };
  const seen = new Map<string, string>(); // `${kind}:${name}` -> file
  const disabled = new Set(config.disabled);
  for (const d of config.pluginDirs) {
    const unsafe = agentWritablePluginDir(config, harnessRoot, d);
    if (unsafe !== null) reg.errors.push({ file: d, error: unsafe });
  }

  for (const abs of discoverPluginFiles(config, harnessRoot)) {
    const file = toPosix(relative(harnessRoot, abs));
    let hash: string;
    let mod: unknown;
    try {
      hash = sha256File(abs);
      mod = await import(pathToFileURL(abs).href);
    } catch (e) {
      reg.errors.push({ file, error: `failed to import: ${errMsg(e)}` });
      continue;
    }
    const exported: unknown =
      typeof mod === 'object' && mod !== null && 'default' in mod ? (mod as { default: unknown }).default : undefined;
    if (exported === undefined) {
      reg.errors.push({ file, error: 'no default export (export default defineTool/defineHook/... )' });
      continue;
    }
    const values: unknown[] = Array.isArray(exported) ? exported : [exported];
    if (values.length === 0) {
      reg.errors.push({ file, error: 'default export is an empty array' });
      continue;
    }
    values.forEach((value, idx) => {
      const where = values.length > 1 ? `${file}[${idx}]` : file;
      const v = validatePlugin(value);
      if ('error' in v) {
        reg.errors.push({ file: where, error: v.error });
        return;
      }
      const p = v.plugin;
      const nm = pluginName(p);
      if (disabled.has(nm) || disabled.has(`${p.kind}:${nm}`)) return;
      const key = `${p.kind}:${nm}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        reg.errors.push({ file: where, error: `duplicate ${p.kind} "${nm}" (already registered by ${prior})` });
        return;
      }
      seen.set(key, file);
      addRecord(reg, p, file, hash);
    });
  }
  return reg;
}

function addRecord(reg: RegistryView, p: Plugin, file: string, sha: string): void {
  switch (p.kind) {
    case 'driver':
      reg.drivers.push({ plugin: p, file, sha256: sha } satisfies PluginRecord<DriverPlugin>);
      return;
    case 'tool':
      reg.tools.push({ plugin: p, file, sha256: sha });
      return;
    case 'hook':
      reg.hooks.push({ plugin: p, file, sha256: sha } satisfies PluginRecord<HookPlugin>);
      return;
    case 'gate':
      reg.gates.push({ plugin: p, file, sha256: sha } satisfies PluginRecord<GatePlugin>);
      return;
    case 'check':
      reg.checks.push({ plugin: p, file, sha256: sha } satisfies PluginRecord<CheckPlugin>);
      return;
  }
}

// ───────────────────────────── tool specs ─────────────────────────────

/** Neutral JSON Schema for a tool input (no "$schema" key, input side of transforms). */
export function toolInputSchema(input: z.ZodType): JsonSchema {
  const js: Record<string, unknown> = { ...z.toJSONSchema(input, { io: 'input' }) };
  delete js['$schema'];
  return js;
}

export function toolSpecs(tools: RegistryView['tools'], kind: TaskKind): ToolSpec[] {
  return tools
    .filter((r) => r.plugin.availableIn === undefined || r.plugin.availableIn.includes(kind))
    .map((r) => ({
      name: r.plugin.name,
      description: r.plugin.description ?? r.plugin.name,
      inputSchema: toolInputSchema(r.plugin.input),
    }));
}

/** Source extensions that can carry plugin or helper code. */
const CODE_EXT = /\.(?:ts|mts|js|mjs)$/;
/** The conventional driver folder directly under a plugin directory (its helpers, e.g. a shared wire format, may differ per driver). */
const DRIVERS_DIR = 'drivers';

/**
 * Every code file under each plugin directory that is not driver code: plugin files and
 * the helpers they share (`lib/`, `_`-prefixed files). Excluded: files the registry loaded
 * as driver plugins, the `drivers/` folder directly under a plugin directory, tests,
 * declarations, `node_modules` and dot-directories. Absolute paths, unsorted.
 */
export function governingFiles(config: HarnessConfig, harnessRoot: string, driverFiles: Iterable<string>): string[] {
  const drivers = new Set([...driverFiles].map((f) => toPosix(f)));
  const out: string[] = [];
  const visit = (dir: string, top: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const st = entry.isSymbolicLink() ? statSync(full, { throwIfNoEntry: false }) : undefined;
      const isDir = st !== undefined ? st.isDirectory() : entry.isDirectory();
      const isFile = st !== undefined ? st.isFile() : entry.isFile();
      if (isDir) {
        if (!(top && entry.name === DRIVERS_DIR)) visit(full, false);
      } else if (isFile && CODE_EXT.test(entry.name) && !DECLARATION.test(entry.name) && !TEST_FILE.test(entry.name)) {
        if (!drivers.has(toPosix(relative(harnessRoot, full)))) out.push(full);
      }
    }
  };
  for (const d of config.pluginDirs) {
    const dir = isAbsolute(d) ? d : join(harnessRoot, d);
    if (existsSync(dir) && statSync(dir).isDirectory()) visit(dir, true);
  }
  return [...new Set(out)];
}

/**
 * file -> sha256 for everything that governs a run: every tool, hook, gate and check file
 * and, given the config, every shared helper under the plugin directories (`plugins/lib/**`,
 * `_*.ts`), so `harness agnostic` also proves the logic those plugins import is identical.
 * Driver code is excluded: it legitimately differs between the two runs being compared.
 */
export function pluginFingerprint(reg: RegistryView, scan?: { config: HarnessConfig; harnessRoot: string }): Record<string, string> {
  const byFile = new Map<string, string>();
  for (const r of [...reg.tools, ...reg.hooks, ...reg.gates, ...reg.checks]) byFile.set(r.file, r.sha256);
  if (scan !== undefined) {
    const driverFiles = new Set(reg.drivers.map((r) => r.file));
    for (const abs of governingFiles(scan.config, scan.harnessRoot, driverFiles)) {
      const file = toPosix(relative(scan.harnessRoot, abs));
      if (!byFile.has(file)) byFile.set(file, sha256File(abs));
    }
  }
  const out: Record<string, string> = {};
  for (const file of [...byFile.keys()].sort()) out[file] = byFile.get(file) ?? '';
  return out;
}
