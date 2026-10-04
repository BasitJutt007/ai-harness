/**
 * secrets (ship only): scan the staged diff, unstaged changes and untracked
 * files under the API root for key-like content before anything leaves the machine.
 * Binary-looking content is scanned too: the diffs are taken with `--text` (git would otherwise print only
 * "Binary files … differ" for a file with a NUL byte) and untracked files are scanned with NUL bytes removed.
 * A file the gate still cannot scan (unreadable, or a diff git reports only as binary) is UNPROVEN, never pass.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { formatSecretMatches, scanSecrets } from '../lib/secrets.ts';

/** Files a unified diff reports only as "Binary files a/x and b/y differ" (their content was not shown). */
export function binaryDiffFiles(diff: string): string[] {
  const out: string[] = [];
  for (const l of diff.split('\n')) {
    const m = /^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+)|\/dev\/null) differ$/.exec(l);
    if (m !== null) out.push(m[2] ?? m[1] ?? l);
  }
  return out;
}

/** Added lines of a unified diff, with the file and new-side line number. */
export function addedLines(diff: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  let file = '';
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '');
    } else if (l.startsWith('@@')) {
      const m = /\+(\d+)/.exec(l);
      line = m?.[1] ? Number(m[1]) : 0;
    } else if (l.startsWith('+')) {
      out.push({ file, line, text: l.slice(1) });
      line++;
    } else if (!l.startsWith('-') && !l.startsWith('\\')) {
      line++;
    }
  }
  return out;
}

async function git(ctx: RunContext, args: string[]): Promise<string> {
  const ws = ctx.workspace;
  const res = await ctx.exec('git', ['-C', ws.repoRoot, ...args], { cwd: ws.repoRoot });
  if (res.code !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${res.stderr.trim().split('\n')[0] ?? ''}`);
  return res.stdout;
}

export default defineGate({
  name: 'secrets',
  description: 'No key-like secrets in the staged diff, unstaged changes or untracked files under the API root.',
  phases: ['ship'],
  async run(ctx) {
    const ws = ctx.workspace;
    const scope = ws.rootRel === '' ? '.' : ws.rootRel;
    const findings: string[] = [];
    const unscanned: string[] = [];
    let scanned = 0;
    try {
      for (const args of [['diff', '--cached', '--no-color', '--text', '-U0', '--', scope], ['diff', '--no-color', '--text', '-U0', '--', scope]]) {
        const diff = await git(ctx, args);
        unscanned.push(...binaryDiffFiles(diff).map((f) => `${f}: git reports the change only as binary`));
        for (const a of addedLines(diff)) {
          scanned++;
          findings.push(...scanSecrets(a.text.replace(/\u0000/g, '')).map((m) => `${a.file}:${a.line}  ${m.label} ${m.preview}`));
        }
      }
      const untracked = (await git(ctx, ['ls-files', '--others', '--exclude-standard', '-z', '--', scope])).split('\u0000').filter((p) => p !== '');
      const prefix = ws.rootRel === '' || ws.rootRel === '.' ? '' : `${ws.rootRel}/`;
      for (const p of untracked) {
        if (!p.startsWith(prefix)) continue;
        const content = await ws.read(p.slice(prefix.length));
        if (content === null) {
          unscanned.push(`${p}: could not be read`);
          continue;
        }
        scanned++;
        // NUL bytes (binary-looking content) are dropped, not a reason to skip the file: a key next to one is still a key.
        findings.push(...formatSecretMatches(p, scanSecrets(content.replace(/\u0000/g, ''))));
      }
    } catch (e) {
      return { status: 'unproven', summary: `secret scan could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (findings.length > 0) {
      return { status: 'fail', summary: `${findings.length} possible secrets in the changes`, details: [...new Set(findings)].slice(0, 25) };
    }
    if (unscanned.length > 0) {
      return { status: 'unproven', summary: `${unscanned.length} changed file(s) could not be scanned for secrets`, details: [...new Set(unscanned)].slice(0, 25) };
    }
    return { status: 'pass', summary: `no secrets in ${scanned} scanned changes` };
  },
});
