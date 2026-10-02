/**
 * tsc-strict: the API type-checks under strict + noUncheckedIndexedAccess (flags
 * forced), and no file under src/ or test/ uses `any`, non-null or definite-assignment
 * assertions, or ts-ignore family comments. tsc cannot run → UNPROVEN.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { toPosix } from '../lib/api-ast.ts';
import { findUnsafeCode } from '../lib/ts-safety.ts';

const RULE = 'tsc-strict';
const PROJECT = '(project)';

const DOC = `tsc-strict (unit: errors; the summary prints "N errors")
The API must type-check with: tsc --noEmit -p tsconfig.json --strict --noUncheckedIndexedAccess
(the flags are forced even if tsconfig.json relaxes them), over src/ and test/.
Banned in every .ts file under src/ and test/ (reported with file:line:col):
- the \`any\` keyword (annotations, \`as any\`, generic arguments): use unknown and narrow, or a precise type
- non-null assertions \`expr!\` and definite-assignment assertions (\`id!: string\`, \`let x!: T\`): check for null/undefined explicitly, or initialise
- @ts-ignore, @ts-expect-error, @ts-nocheck comments: fix the error instead
Indexed access is \`T | undefined\` under noUncheckedIndexedAccess: handle the undefined case.
Passing example:
  const first = items[0];
  if (first === undefined) throw notFound('no items');
  const parsed: unknown = JSON.parse(text);
  const body = BodySchema.parse(parsed);   // narrow unknown with a Zod schema
If tsc cannot run, the rule is UNPROVEN (never green).`;

const DIAG = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const GLOBAL_DIAG = /^error (TS\d+): (.*)$/;

interface Diag {
  file: string | null;
  location: string;
  message: string;
}

export function parseTscOutput(out: string, root: string): Diag[] {
  const diags: Diag[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = DIAG.exec(line);
    if (m) {
      const [, f = '', l = '0', c = '0', code = '', msg = ''] = m;
      const rel = toPosix(isAbsolute(f) ? relative(root, f) : f);
      const inside = !rel.startsWith('../') && rel !== '..';
      diags.push({ file: inside ? rel : null, location: `${inside ? rel : f}:${l}:${c}`, message: `${code}: ${msg}` });
      continue;
    }
    const g = GLOBAL_DIAG.exec(line);
    if (g) diags.push({ file: null, location: PROJECT, message: `${g[1] ?? ''}: ${g[2] ?? ''}` });
  }
  return diags;
}

function programDiags(ctx: CheckContext): Diag[] {
  const program = ctx.program();
  return ts.getPreEmitDiagnostics(program).map((d): Diag => {
    const msg = `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] ?? ''}`;
    if (d.file === undefined || d.start === undefined) return { file: null, location: PROJECT, message: msg };
    const rel = toPosix(relative(ctx.root, d.file.fileName));
    const lc = d.file.getLineAndCharacterOfPosition(d.start);
    const inside = !rel.startsWith('../');
    return { file: inside ? rel : null, location: `${inside ? rel : d.file.fileName}:${lc.line + 1}:${lc.character + 1}`, message: msg };
  });
}

type TscRun = { ok: true; diags: Diag[] } | { ok: false; reason: string };

async function runTsc(ctx: CheckContext): Promise<TscRun> {
  const tsconfig = join(ctx.root, 'tsconfig.json');
  if (!existsSync(tsconfig)) return { ok: true, diags: programDiags(ctx) };
  const tsc = join(ctx.harnessRoot, 'node_modules', '.bin', 'tsc');
  const res = await ctx.exec(tsc, ['--noEmit', '-p', tsconfig, '--strict', '--noUncheckedIndexedAccess', '--pretty', 'false'], {
    cwd: ctx.root,
    timeoutMs: 180_000,
  });
  const output = `${res.stdout}\n${res.stderr}`;
  await ctx.logs.write('tsc-strict.txt', `$ tsc --noEmit -p tsconfig.json --strict --noUncheckedIndexedAccess\nexit=${String(res.code)}\n${output}`);
  if (res.timedOut) return { ok: false, reason: 'tsc timed out' };
  const diags = parseTscOutput(output, ctx.root);
  if (res.code === 0) return { ok: true, diags };
  if (res.code === null || diags.length === 0) {
    return { ok: false, reason: `tsc could not run (exit ${String(res.code)}): ${output.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)}` };
  }
  return { ok: true, diags };
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const tsc = await runTsc(ctx);
  if (!tsc.ok) {
    return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: tsc.reason }];
  }
  const byFile = new Map<string, Violation[]>();
  const add = (file: string, v: Violation): void => {
    const list = byFile.get(file) ?? [];
    list.push(v);
    byFile.set(file, list);
  };
  const projectViolations: Violation[] = [];
  for (const d of tsc.diags) {
    if (d.file === null) projectViolations.push({ location: d.location, message: d.message });
    else add(d.file, { location: d.location, message: d.message });
  }
  for (const file of [...ctx.sourceFiles, ...ctx.testFiles]) {
    const text = await ctx.read(file);
    for (const v of findUnsafeCode(resolve(ctx.root, file), text)) {
      add(file, { location: `${file}:${v.line}:${v.col}`, message: v.message });
    }
  }
  const findings: CheckFinding[] = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, violations]) => ({ rule: RULE, file, status: 'fail', units: { passed: 0, total: violations.length }, violations }));
  const errors = findings.reduce((n, f) => n + f.violations.length, 0) + projectViolations.length;
  findings.push({
    rule: RULE,
    file: PROJECT,
    status: errors === 0 ? 'pass' : 'fail',
    // A clean project is one passing unit; otherwise each project-level diagnostic is one failing unit,
    // so sum(total - passed) over all findings is always the error count.
    units: errors === 0 ? { passed: 1, total: 1 } : { passed: 0, total: projectViolations.length },
    violations: projectViolations,
  });
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'tsc --strict --noUncheckedIndexedAccess is clean over src+test; no `any`, no `x!` / `id!: T`, no @ts-ignore/@ts-expect-error/@ts-nocheck.',
  unit: 'errors',
  doc: DOC,
  run,
});
