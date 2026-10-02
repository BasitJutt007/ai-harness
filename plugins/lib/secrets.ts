/**
 * Key-like content detection shared by the secret-guard hook and the secrets gate.
 * Patterns are deliberately conservative (long, prefixed tokens) to keep false
 * positives low; matches are reported redacted.
 */

export interface SecretPattern {
  id: string;
  label: string;
  re: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'private-key', label: 'PEM private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'sk-key', label: 'sk- style API key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    id: 'generic-api-key',
    label: 'hard-coded api key',
    re: /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i,
  },
];

export interface SecretMatch {
  id: string;
  label: string;
  /** 1-based line within the scanned text. */
  line: number;
  /** Redacted excerpt: first 4 chars of the match + "…". */
  preview: string;
}

export function redact(match: string): string {
  return `${match.slice(0, 4)}…(${match.length} chars)`;
}

/** Scan text line by line; at most one match per pattern per line. */
export function scanSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const lines = text.split('\n');
  lines.forEach((lineText, idx) => {
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(lineText);
      if (m) matches.push({ id: p.id, label: p.label, line: idx + 1, preview: redact(m[0]) });
    }
  });
  return matches;
}

/**
 * Matches in `after` that `before` did not already contain (multiset by pattern +
 * line text), so a secret split across several edits is caught on the edit that
 * completes it, and legacy content does not block unrelated edits.
 */
export function newSecrets(before: string | null, after: string): SecretMatch[] {
  const found = scanSecrets(after);
  if (before === null) return found;
  const lineOf = (text: string, m: SecretMatch): string => `${m.id}|${(text.split('\n')[m.line - 1] ?? '').trim()}`;
  const existing = new Map<string, number>();
  for (const m of scanSecrets(before)) {
    const k = lineOf(before, m);
    existing.set(k, (existing.get(k) ?? 0) + 1);
  }
  return found.filter((m) => {
    const k = lineOf(after, m);
    const n = existing.get(k) ?? 0;
    if (n > 0) {
      existing.set(k, n - 1);
      return false;
    }
    return true;
  });
}

/** One compact line per match: `<where>:<line>  <label> <preview>`. */
export function formatSecretMatches(where: string, matches: SecretMatch[]): string[] {
  return matches.map((m) => `${where}:${m.line}  ${m.label} ${m.preview}`);
}
