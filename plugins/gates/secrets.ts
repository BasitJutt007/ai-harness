/**
 * secrets (ship only): scan the staged diff, unstaged changes and untracked
 * files under the API root for key-like content before anything leaves the machine.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import type { RunContext } from '../../src/core/plugin-api.ts';
import { formatSecretMatches, scanSecrets } from '../lib/secrets.ts';

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
    let scanned = 0;
    try {
      for (const args of [['diff', '--cached', '--no-color', '-U0', '--', scope], ['diff', '--no-color', '-U0', '--', scope]]) {
        for (const a of addedLines(await git(ctx, args))) {
          scanned++;
          findings.push(...scanSecrets(a.text).map((m) => `${a.file}:${a.line}  ${m.label} ${m.preview}`));
        }
      }
      const untracked = (await git(ctx, ['ls-files', '--others', '--exclude-standard', '-z', '--', scope])).split('\u0000').filter((p) => p !== '');
      const prefix = ws.rootRel === '' || ws.rootRel === '.' ? '' : `${ws.rootRel}/`;
      for (const p of untracked) {
        if (!p.startsWith(prefix)) continue;
        const content = await ws.read(p.slice(prefix.length));
        if (content === null || content.includes('\u0000')) continue;
        scanned++;
        findings.push(...formatSecretMatches(p, scanSecrets(content)));
      }
    } catch (e) {
      return { status: 'unproven', summary: `secret scan could not run: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (findings.length > 0) {
      return { status: 'fail', summary: `${findings.length} possible secrets in the changes`, details: [...new Set(findings)].slice(0, 25) };
    }
    return { status: 'pass', summary: `no secrets in ${scanned} scanned changes` };
  },
});
