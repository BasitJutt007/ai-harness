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

const ConfigSchema = z
  .object({
    pluginDirs: z.array(z.string().min(1)).default(['plugins']),
    disabled: z.array(z.string()).default([]),
    protectedBranches: z
      .array(z.string().min(1))
      .default(['main', 'master', 'develop', 'trunk', 'release/*', 'production']),
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
