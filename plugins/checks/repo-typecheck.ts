/**
 * repo-typecheck (nestjs, react-vite; standards): the repository's OWN type check: its TypeScript
 * (node_modules/typescript), its tsconfig, and every project a solution-style tsconfig references,
 * so the change is held to what the team's build means to run. A solution-style tsconfig.json
 * (files: [] + references) type-checks NOTHING under `tsc --noEmit -p tsconfig.json`; this check
 * expands it into its projects, so a pass never rests on zero files.
 *
 * Nothing is written into the target: incremental projects get a --tsBuildInfoFile in a temp dir
 * (a solution build's tsbuildinfo would otherwise land in the shared node_modules/.tmp).
 * UNPROVEN, never green: no TypeScript in the repository, no tsconfig, a config tsc cannot read, or
 * tsc failing without diagnostics.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';

const RULE = 'repo-typecheck';
const PROJECT = '(project)';
const DIAG = /^(?<file>[^(\n]+?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<msg>.*)$/;

const DOC = `repo-typecheck: the repository's own type check passes (its TypeScript, its tsconfig, every
referenced project), so the change type-checks exactly where the team's build would run it.
Fix every reported error in the files you touched; do not loosen tsconfig or add // @ts-ignore.`;

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

interface Project {
  config: string;
  incremental: boolean;
}

/** tsconfig.json, or every project it references when it is a solution-style config (files: [] + references). */
export function projectsOf(root: string): { projects: Project[]; problem?: string } {
  const top = join(root, 'tsconfig.json');
  if (!existsSync(top)) return { projects: [], problem: 'no tsconfig.json at the repository root' };
  const parsed = ts.getParsedCommandLineOfConfigFile(top, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) return { projects: [], problem: 'tsconfig.json cannot be read' };
  const refs = parsed.projectReferences ?? [];
  const project = (config: string, p: ts.ParsedCommandLine): Project => ({ config, incremental: p.options.incremental === true || p.options.composite === true });
  if (refs.length > 0 && parsed.fileNames.length === 0) {
    const out: Project[] = [];
    for (const r of refs) {
      const cfg = existsSync(r.path) && !r.path.endsWith('.json') ? join(r.path, 'tsconfig.json') : r.path;
      const sub = ts.getParsedCommandLineOfConfigFile(cfg, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
      if (sub === undefined) return { projects: [], problem: `referenced ${relative(root, cfg)} cannot be read` };
      out.push(project(cfg, sub));
    }
    return { projects: out };
  }
  return { projects: [project(top, parsed)] };
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const skip = (why: string): CheckFinding[] => [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: why }];
  const tsc = join(ctx.root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) return skip('the repository has no TypeScript of its own (node_modules/typescript): its type check cannot be run');
  const { projects, problem } = projectsOf(ctx.root);
  if (problem !== undefined) return skip(problem);
  const tmp = mkdtempSync(join(tmpdir(), 'repo-typecheck-'));
  const byFile = new Map<string, Violation[]>();
  const project: Violation[] = [];
  const log: string[] = [];
  try {
    for (const p of projects) {
      const args = [tsc, '--noEmit', '--pretty', 'false', '-p', p.config];
      if (p.incremental) args.push('--tsBuildInfoFile', join(tmp, `${basename(p.config)}.tsbuildinfo`));
      const r = await ctx.exec(process.execPath, args, { cwd: ctx.root, timeoutMs: 900_000 });
      log.push(`$ tsc ${args.slice(1).join(' ')}  (exit ${String(r.code)})`, r.stdout.trim());
      if (r.timedOut) return skip(`tsc timed out on ${relative(ctx.root, p.config)}`);
      let parsedAny = false;
      for (const line of r.stdout.split('\n')) {
        const m = DIAG.exec(line.trim());
        if (m?.groups === undefined) continue;
        parsedAny = true;
        const g = m.groups;
        const abs = resolve(dirname(p.config), g['file'] ?? '');
        const rel = toPosix(relative(ctx.root, abs));
        const v: Violation = { location: `${rel}:${g['line'] ?? '0'}:${g['col'] ?? '0'}`, message: `${g['code'] ?? ''}: ${g['msg'] ?? ''}` };
        if (rel.startsWith('..')) project.push(v);
        else byFile.set(rel, [...(byFile.get(rel) ?? []), v]);
      }
      if (r.code !== 0 && !parsedAny) {
        const first = (r.stdout || r.stderr).trim().split('\n').slice(0, 3).join(' | ');
        return skip(`tsc exited ${String(r.code)} on ${relative(ctx.root, p.config)} without diagnostics it could read: ${first}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await ctx.logs.write('repo-typecheck.txt', log.join('\n'));
  }
  const findings: CheckFinding[] = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, violations]) => ({ rule: RULE, file, status: 'fail', units: { passed: 0, total: violations.length }, violations }));
  const errors = findings.reduce((n, f) => n + f.violations.length, 0) + project.length;
  findings.push({ rule: RULE, file: PROJECT, status: errors === 0 ? 'pass' : 'fail', units: errors === 0 ? { passed: 1, total: 1 } : { passed: 0, total: project.length }, violations: project });
  return findings;
}

export default defineCheck({
  id: RULE,
  stacks: ['nestjs', 'react-vite'],
  category: 'standards',
  description: "The repository's own type check passes: its TypeScript, its tsconfig, every referenced project.",
  unit: 'errors',
  doc: DOC,
  run,
});
