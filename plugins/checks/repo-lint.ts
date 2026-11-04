/**
 * repo-lint (nestjs, react-vite; lint): the repository's OWN ESLint, with its own config, on the files
 * a run changed (every source file for a stand-alone `harness check`). Lint findings are repository
 * standards, so like any non-standards rule they block only what a run introduces (the standards gate
 * compares with the base commit).
 *
 * Coverage is proven, not assumed: a config whose `files` match only **\/*.{js,jsx} reports "0 errors"
 * on a TypeScript codebase without linting one file of it. A file the config does not match ("File
 * ignored because no matching configuration was supplied") is reported n/a with that reason, never as
 * linted.
 *
 * ESLint loads the repository's config, which is code that runs on load, so it runs confined: no
 * network, writes only to a temp dir, never --fix.
 * UNPROVEN: ESLint crashes or exits with a fatal error (2), or prints no report.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';

const RULE = 'repo-lint';
const PROJECT = '(project)';
const CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc', '.eslintrc.yml', '.eslintrc.yaml'];
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IGNORED = /^File ignored/;

const DOC = `repo-lint: the repository's own ESLint config reports no new problem in the files you changed.
Fix what it names in your files; never edit the ESLint config, never disable a rule inline.
A file the config does not cover is reported n/a: the repository has no lint standard for it.`;

interface EslintMessage { ruleId: string | null; severity: number; message: string; line?: number; column?: number }
interface EslintResult { filePath: string; messages: EslintMessage[] }

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** API-relative files this run changed (or added) since the base commit; null = cannot tell. */
async function changedFiles(ctx: CheckContext): Promise<string[] | null> {
  const base = ctx.base;
  if (base === undefined) return null;
  const prefix = base.rootRel === '' || base.rootRel === '.' ? '' : `${base.rootRel.replace(/\/+$/, '')}/`;
  const diff = await ctx.exec('git', ['-C', base.repoRoot, 'diff', '--name-only', base.sha, '--', prefix || '.'], { cwd: base.repoRoot });
  const untracked = await ctx.exec('git', ['-C', base.repoRoot, 'ls-files', '--others', '--exclude-standard', '--', prefix || '.'], { cwd: base.repoRoot });
  if (diff.code !== 0 || untracked.code !== 0) return null;
  return [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].map((l) => l.trim()).filter((l) => l.length > 0))]
    .map((p) => (prefix !== '' && p.startsWith(prefix) ? p.slice(prefix.length) : p))
    .filter((p) => LINTABLE.test(p) && existsSync(join(ctx.root, p)));
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const na = (why: string): CheckFinding[] => [{ rule: RULE, file: PROJECT, status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: why }];
  const skip = (why: string): CheckFinding[] => [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: why }];
  const eslint = join(ctx.root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const config = CONFIGS.find((c) => existsSync(join(ctx.root, c)));
  if (config === undefined) return na('the repository has no ESLint config');
  if (!existsSync(eslint)) return skip(`${config} exists but the repository's ESLint is not installed (node_modules/eslint)`);
  const changed = await changedFiles(ctx);
  const files = changed ?? [...ctx.sourceFiles, ...ctx.testFiles].filter((f) => LINTABLE.test(f));
  if (files.length === 0) return na(changed === null ? 'no source files' : 'the run changed no lintable file');

  const tmp = mkdtempSync(join(tmpdir(), 'repo-lint-'));
  try {
    const r = await ctx.exec(process.execPath, [eslint, '--format', 'json', '--no-error-on-unmatched-pattern', ...files], {
      cwd: ctx.root,
      timeoutMs: 600_000,
      env: { TMPDIR: tmp },
      sandbox: { writable: [tmp], network: 'none' },
    });
    await ctx.logs.write('repo-lint.txt', `$ eslint --format json ${files.join(' ')}  (exit ${String(r.code)})\n${r.stderr.trim()}`);
    if (r.timedOut) return skip('ESLint timed out');
    if (r.code !== 0 && r.code !== 1) return skip(`ESLint exited ${String(r.code)}: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`);
    let results: EslintResult[];
    try {
      results = JSON.parse(r.stdout) as EslintResult[];
    } catch {
      return skip('ESLint printed no JSON report');
    }
    const findings: CheckFinding[] = [];
    for (const res of results) {
      const rel = toPosix(relative(ctx.root, res.filePath));
      if (res.messages.length > 0 && res.messages.every((m) => m.ruleId === null && IGNORED.test(m.message))) {
        findings.push({ rule: RULE, file: rel, status: 'pass', units: { passed: 0, total: 0 }, violations: [], naReason: `${config} does not lint this file (${res.messages[0]?.message ?? 'ignored'})` });
        continue;
      }
      const violations: Violation[] = res.messages
        .filter((m) => !(m.ruleId === null && IGNORED.test(m.message)))
        .map((m) => ({ location: `${rel}:${m.line ?? 0}:${m.column ?? 0}`, message: `${m.severity === 2 ? 'error' : 'warning'} ${m.ruleId ?? 'eslint'}: ${m.message}` }));
      findings.push({ rule: RULE, file: rel, status: violations.length === 0 ? 'pass' : 'fail', units: { passed: violations.length === 0 ? 1 : 0, total: 1 }, violations });
    }
    const missing = files.filter((f) => !results.some((res) => toPosix(relative(ctx.root, res.filePath)) === f));
    for (const f of missing) findings.push({ rule: RULE, file: f, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'ESLint returned no result for this file' });
    return findings;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default defineCheck({
  id: RULE,
  stacks: ['nestjs', 'react-vite'],
  category: 'lint',
  description: "The repository's own ESLint reports nothing new in the changed files; a file its config does not cover is n/a, never linted.",
  unit: 'files',
  doc: DOC,
  run,
});
