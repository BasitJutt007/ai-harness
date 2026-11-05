/**
 * Provider keys from a user-level env file, so `harness` works in any repository without exporting
 * keys in every shell (and without ever putting them in a repository).
 *
 * Which file: SF_HARNESS_ENV_FILE when set (only that file: an explicit choice is never second-guessed),
 * else <state home>/env.development, else <state home>/.env (state home: SF_HARNESS_HOME, else
 * ~/.sf-harness). The first one that exists is the only one read.
 *
 * What it sets: KEY=VALUE lines (an optional leading `export`, optional matching quotes) whose name the
 * caller allows (the credential variables the driver plugins read, and HARNESS_* names). Every other
 * line is ignored. A variable already set in the environment is never overridden, even when empty. No
 * value is ever printed or returned: the result names keys only. A file other users can read is still
 * loaded (the owner may have a reason), with a warning that names the fix.
 *
 * The core names no provider: the allowed names are passed in (the CLI learns them from the drivers).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateHome } from './state-home.ts';

export interface EnvFileResult {
  /** The file that was read, or null when none exists. */
  file: string | null;
  /** The files looked for, in order. */
  candidates: string[];
  /** Names this file set (it supplied them). */
  loaded: string[];
  /** Allowed names the file has that were already set in the environment (kept as they were). */
  kept: string[];
  /** Lines that are not an allowed KEY=VALUE (other names, malformed lines); never set. */
  ignored: number;
  /** Warnings for the owner (never a value). */
  warnings: string[];
}

/** The env files to look for, in order (see the module comment). */
export function envFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env['SF_HARNESS_ENV_FILE'];
  if (explicit !== undefined && explicit.trim().length > 0) return [explicit.trim()];
  const home = stateHome(env);
  return [join(home, 'env.development'), join(home, '.env')];
}

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** One KEY=VALUE line → [name, value], or null (comments, blanks and anything else). */
export function parseEnvLine(line: string): [string, string] | null {
  const t = line.trim();
  if (t.length === 0 || t.startsWith('#')) return null;
  const m = LINE_RE.exec(t);
  if (m === null) return null;
  let value = (m[2] ?? '').trim();
  const q = value[0];
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, '');
  return [m[1] ?? '', value];
}

/**
 * Read the first existing candidate and set the allowed names it has that the environment lacks.
 * `env` is modified in place (process.env by default).
 */
export function loadEnvFile(opts: { allowed: (name: string) => boolean; env?: NodeJS.ProcessEnv; candidates?: string[] }): EnvFileResult {
  const env = opts.env ?? process.env;
  const candidates = opts.candidates ?? envFileCandidates(env);
  const result: EnvFileResult = { file: null, candidates, loaded: [], kept: [], ignored: 0, warnings: [] };
  const file = candidates.find((f) => existsSync(f));
  if (file === undefined) return result;
  result.file = file;
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      result.warnings.push(`${file} is not a regular file: not loaded`);
      return result;
    }
    if ((st.mode & 0o077) !== 0) {
      result.warnings.push(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}): restrict it with chmod 600 ${file}`);
    }
    text = readFileSync(file, 'utf8');
  } catch (e) {
    result.warnings.push(`${file} could not be read (${e instanceof Error ? e.message : String(e)}): not loaded`);
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const kv = parseEnvLine(line);
    if (kv === null || !opts.allowed(kv[0])) {
      result.ignored += 1;
      continue;
    }
    const [name, value] = kv;
    if (env[name] !== undefined) {
      if (!result.kept.includes(name)) result.kept.push(name);
      continue;
    }
    if (value.length === 0) {
      result.ignored += 1;
      continue;
    }
    env[name] = value;
    if (!result.loaded.includes(name)) result.loaded.push(name);
  }
  return result;
}

/** HARNESS_* names (the harness's own settings) are always allowed besides the credential variables. */
export function allowedEnvName(credentialVars: readonly string[]): (name: string) => boolean {
  const creds = new Set(credentialVars);
  return (name) => creds.has(name) || /^HARNESS_[A-Z0-9_]+$/.test(name);
}

/** The last load in this process (the CLI's, before any command), for `harness doctor`. */
let lastLoad: EnvFileResult | null = null;

export function recordEnvLoad(r: EnvFileResult | null): void {
  lastLoad = r;
}

export function lastEnvLoad(): EnvFileResult | null {
  return lastLoad;
}

/** Doctor lines: which file supplied which key NAMES (never a value). */
export function envFileLines(r: EnvFileResult | null): string[] {
  if (r === null) return ['envfile   not loaded in this process (the harness command loads it before any command)'];
  if (r.file === null) return [`envfile   none (looked for ${r.candidates.join(', ')})`];
  const lines = [`envfile   ${r.file}: supplied ${r.loaded.length > 0 ? r.loaded.join(', ') : '(nothing)'}${r.kept.length > 0 ? `; already set, kept: ${r.kept.join(', ')}` : ''}${r.ignored > 0 ? `; ${r.ignored} other line(s) ignored` : ''}`];
  for (const w of r.warnings) lines.push(`envfile   warn  ${w}`);
  return lines;
}
