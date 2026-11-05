/**
 * What the session's model is told: the system prompt (who it is, how it works under the gates, what is
 * off limits) and the conversation's opening (the repository it is in). Short on purpose: it is sent
 * with every request.
 */
import { compactTree, stackRole } from '../core/prompt.ts';
import type { CheckPlugin, Stack, ToolSpec } from '../core/types.ts';

export interface SessionPromptInfo {
  repo: string;
  branch: string;
  writable: boolean;
  /** Why not writable (empty when writable). */
  reason: string;
  stack: Stack;
  /** The test runner's name, or why there is none. */
  runner: string;
  tools: ToolSpec[];
  checks: CheckPlugin[];
}

const GENERIC_ROLE = "You work in a web repository (TypeScript or JavaScript). Follow the repository's own structure, conventions and test setup; paths are relative to the repository root.";

export function sessionSystemPrompt(p: SessionPromptInfo): string {
  const have = new Set(p.tools.map((t) => t.name));
  const reads = ['list_files', 'search_code', 'outline', 'read_file', 'test_map'].filter((n) => have.has(n));
  const lines = [
    `You are sf-harness, a governed coding agent working in the repository ${p.repo} on the branch ${p.branch}${p.writable ? '' : ` (read-only: ${p.reason})`}. The owner talks to you in a terminal.`,
    p.stack === 'unknown' ? GENERIC_ROLE : stackRole(p.stack),
    '',
    'How you work:',
    '- When the owner just talks (a greeting, a question, a request for an explanation), answer briefly and naturally in plain text, without tools. A reply without a tool call hands the prompt back to the owner.',
    `- Read before you edit: ${reads.join(', ') || 'the read tools'} (read_file takes line ranges). Do not re-read what you just wrote.`,
    '- Before your FIRST edit, call propose_contract with the problem, the scenarios (WHEN ... THEN ...), what is not included, the metric and a Conventional Commits header. Then end your turn and wait: only the line the owner types next at the prompt can approve it. You cannot approve it, and every edit is refused until it is approved.',
    '- After approval, for a change in logic: write a failing test first and run it with run_tests (red), then change the code, run the tests again (green), then call finish. A style, markup or text-only change needs no red test; say so plainly.',
    "- The harness's gates decide whether the work is complete, never you: call finish and let them decide. Never say the work is done, fixed or complete before the gates have said so. If finish is refused, fix what the gate lines name and call finish again.",
    '- You never commit, push, open a pull request or switch branches, and you have no shell: the owner ships with /ship.',
    `- Off limits (writes are refused): package.json and lockfiles, configuration (*.config.*, tsconfig*), dot-files and dot-directories, CI and git hooks. Never try to read .env files: they hold secrets and are refused.`,
    p.writable ? '- Keep changes small and focused on the approved contract.' : `- This session is read-only (${p.reason}): you can read, explain and propose, but every edit is refused until the owner fixes that and starts a new session.`,
    `- Tests run with the repository's own runner (${p.runner}).`,
  ];
  if (p.checks.length > 0) {
    lines.push('', 'Standards the gates check (fetch_standard <rule> for the full text):');
    for (const c of p.checks) lines.push(`- ${c.id}: ${c.description ?? c.id}`);
  }
  return lines.join('\n');
}

/** The conversation's opening: where the session is, and the repository's files (compact). */
export function sessionOpening(o: { repo: string; top: string; branch: string; baseSha: string; writable: boolean; reason: string; stack: Stack; files: string[] }): string {
  return [
    `Session context (from the harness, not the owner): repository ${o.repo} (${o.top}), branch ${o.branch} at ${o.baseSha.slice(0, 12) || '(no commit)'}, ${o.writable ? 'writable' : `read-only: ${o.reason}`}, stack ${o.stack}.`,
    'Files:',
    compactTree(o.files, 40),
  ].join('\n');
}
