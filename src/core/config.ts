/**
 * Harness configuration: where the harness lives and what harness.config.json says.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { HarnessConfig } from './types.ts';

function stripTrailingSep(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

/** Absolute path of the harness repository (two levels up from src/core). */
export const HARNESS_ROOT: string = stripTrailingSep(fileURLToPath(new URL('../../', import.meta.url)));

const PriceSchema = z
  .object({ input: z.number().min(0), cachedInput: z.number().min(0), output: z.number().min(0), note: z.string().optional() })
  .strict();

/**
 * Branches the harness never works on, ships or writes in place: the long-lived branches of the
 * common workflows (trunk-based, git-flow, environment branches). harness.config.json
 * `protectedBranches` adds to this list and can never shorten it: a config that names only its own
 * extras still protects every branch here (fail closed).
 */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'development', 'develop', 'staging', 'production', 'release/*', 'trunk'];

/**
 * Agent-shell markers every config gets: generic names only. Product-specific markers are named in
 * harness.config.json (`agentEnvMarkers`), so the core names no provider.
 */
export const DEFAULT_AGENT_ENV_MARKERS: readonly string[] = ['AI_AGENT'];

/** The configured list first (its order kept), then every default it does not name. */
export function withDefaultProtected(configured: readonly string[]): string[] {
  const seen = new Set(configured);
  return [...configured, ...DEFAULT_PROTECTED_BRANCHES.filter((b) => !seen.has(b))];
}

const ConfigSchema = z
  .object({
    pluginDirs: z.array(z.string().min(1)).default(['plugins']),
    disabled: z.array(z.string()).default([]),
    protectedBranches: z
      .array(z.string().min(1))
      .default([...DEFAULT_PROTECTED_BRANCHES])
      .transform(withDefaultProtected),
    worktreeDir: z.string().min(1).default('.harness/worktrees'),
    runsDir: z.string().min(1).default('runs'),
    tokensDir: z.string().min(1).default('tokens'),
    templatesDir: z.string().min(1).default('templates'),
    history: z
      .object({ keepRecentTurns: z.number().int().min(0).default(2) })
      .strict()
      .default({ keepRecentTurns: 2 }),
    limits: z
      .object({
        maxReadLines: z.number().int().min(1).default(160),
        maxListEntries: z.number().int().min(1).default(200),
        maxSearchHits: z.number().int().min(1).default(40),
      })
      .strict()
      .default({ maxReadLines: 160, maxListEntries: 200, maxSearchHits: 40 }),
    // Isolation of agent-written code (src/core/sandbox.ts). HARNESS_SANDBOX=off|auto overrides it.
    sandbox: z.enum(['auto', 'off']).default('auto'),
    // Model allowlist and spend cap (src/core/spend.ts). Without it only the offline replay may run.
    models: z
      .object({
        allow: z.array(z.string().min(1)).default(['scripted:*']),
        prices: z.record(z.string().min(1), PriceSchema).default({ 'scripted:*': { input: 0, cachedInput: 0, output: 0 } }),
        maxRunUsd: z.number().positive().default(2),
      })
      .strict()
      .default({ allow: ['scripted:*'], prices: { 'scripted:*': { input: 0, cachedInput: 0, output: 0 } }, maxRunUsd: 2 }),
    // Options per check id (CheckContext.options): repository facts a generic rule needs. Each check validates its own.
    checkOptions: z.record(z.string().min(1), z.record(z.string(), z.unknown())).default({}),
    // Env names that mark an AI agent's shell, recorded with each typed reply (provenance.ts). Provider-neutral default.
    agentEnvMarkers: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/, 'an environment variable name, optionally ending in *')).default([...DEFAULT_AGENT_ENV_MARKERS])
      .transform((m) => [...new Set([...m, ...DEFAULT_AGENT_ENV_MARKERS])]),
  })
  .strict();

export interface EvidenceDirs {
  /** Absolute directory holding runs/<runId>/. */
  runsDir: string;
  /** Absolute directory holding <runId>.json token reports. */
  tokensDir: string;
}

/**
 * Where run evidence goes. Precedence: explicit override > HARNESS_RUNS_DIR /
 * HARNESS_TOKENS_DIR > harness.config.json. Relative paths resolve against the harness root.
 * (Tests use the overrides so they never write into the committed runs/ and tokens/.)
 */
export function evidenceDirs(
  config: HarnessConfig,
  harnessRoot: string = HARNESS_ROOT,
  override: { runsDir?: string | undefined; tokensDir?: string | undefined } = {},
  env: NodeJS.ProcessEnv = process.env,
): EvidenceDirs {
  const pick = (o: string | undefined, e: string | undefined, c: string): string =>
    resolve(harnessRoot, o !== undefined && o.length > 0 ? o : e !== undefined && e.length > 0 ? e : c);
  return {
    runsDir: pick(override.runsDir, env['HARNESS_RUNS_DIR'], config.runsDir),
    tokensDir: pick(override.tokensDir, env['HARNESS_TOKENS_DIR'], config.tokensDir),
  };
}

/** Read and validate `<root>/harness.config.json`. A missing file yields all defaults. */
export function loadConfig(root: string = HARNESS_ROOT): HarnessConfig {
  const file = join(root, 'harness.config.json');
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`harness.config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid harness.config.json: ${issues}`);
  }
  return parsed.data;
}
