/**
 * Operator provenance of a reply typed at the item prompt (assignment 02, the human-yes gate).
 *
 * Trust model: only a line typed at an interactive terminal can approve a contract (channel 'tty').
 * A TTY proves a terminal, not a person: an AI agent's shell can drive one too. The harness does not
 * refuse on that (the operator at a terminal is trusted, and an agent that types for them acts with
 * their authority); it records, truthfully, what it can see: the channel, and which agent-shell
 * environment markers were present when the reply was recorded (their NAMES only, never values).
 * Item status, the approval message and the human-yes verdict then say, for example, "typed at a
 * terminal inside an AI agent's shell (AI_AGENT)", so a reviewer reads exactly what was proven. The
 * markers prove neither way (MARKER_LIMITS): none set proves nothing, since an agent can unset them,
 * and a person typing in a terminal that inherits an agent's markers is recorded as inside its shell.
 *
 * The marker names come from harness.config.json `agentEnvMarkers` (a trailing `*` matches a prefix);
 * the core itself names only the generic ones (config.ts DEFAULT_AGENT_ENV_MARKERS).
 */
import { DEFAULT_AGENT_ENV_MARKERS, HARNESS_ROOT, loadConfig } from './config.ts';

/** What the harness records about who typed a reply, besides the channel. */
export interface OperatorProvenance {
  /** Names of the agent-shell environment markers present when the reply was recorded (sorted; empty = none). */
  agentEnv: string[];
}

/** The configured markers (harness.config.json), or the generic defaults when the config cannot be read. */
export function configuredAgentMarkers(root: string = HARNESS_ROOT): string[] {
  try {
    return loadConfig(root).agentEnvMarkers ?? [...DEFAULT_AGENT_ENV_MARKERS];
  } catch {
    return [...DEFAULT_AGENT_ENV_MARKERS];
  }
}

/** Names of the set (non-empty) variables in `env` that a marker names; `X_*` matches every name starting with `X_`. */
export function agentEnvPresent(env: NodeJS.ProcessEnv, markers: readonly string[]): string[] {
  const set = Object.keys(env).filter((k) => (env[k] ?? '').length > 0);
  const out = new Set<string>();
  for (const m of markers) {
    if (m.endsWith('*')) {
      const prefix = m.slice(0, -1);
      for (const k of set) if (k.startsWith(prefix)) out.add(k);
    } else if (set.includes(m)) {
      out.add(m);
    }
  }
  return [...out].sort();
}

/** The provenance of a reply recorded now, in this process. */
export function operatorProvenance(env: NodeJS.ProcessEnv = process.env, markers: readonly string[] = configuredAgentMarkers()): OperatorProvenance {
  return { agentEnv: agentEnvPresent(env, markers) };
}

/**
 * What the markers cannot prove, either way: their absence proves nothing (an agent can unset its own
 * environment variables before it types), and a person's own yes, typed in a terminal that inherits an
 * agent's markers (one opened from inside an agent's session), is recorded as typed inside an agent's shell.
 */
export const MARKER_LIMITS = "no agent-shell markers were set, which proves nothing: an agent can unset them; and a person's own yes typed in a terminal that inherits agent markers is recorded as typed inside an agent's shell";

/**
 * How a reply arrived, in words: "typed at a terminal" with what an absent marker set does not prove
 * (MARKER_LIMITS), "typed at a terminal inside an AI agent's shell (NAMES)", "piped in (not typed at a
 * terminal)", or, for a reply recorded before provenance was kept, says so.
 */
export function provenanceText(channel: 'tty' | 'pipe', agentEnv: readonly string[] | undefined): string {
  const how = channel === 'tty' ? 'typed at a terminal' : 'piped in (not typed at a terminal)';
  if (agentEnv === undefined) return `${how} (agent markers not recorded)`;
  if (agentEnv.length === 0) return channel === 'tty' ? `${how} (${MARKER_LIMITS})` : how;
  return `${how} inside an AI agent's shell (${agentEnv.join(', ')})`;
}
