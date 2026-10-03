/**
 * tsc-strict: every TypeScript file of the API type-checks under the strict set (every strict-family
 * flag, noUncheckedIndexedAccess and noEmit forced one by one, whatever the tsconfig says), and none
 * uses `any`, non-null or definite-assignment assertions, or ts-ignore family comments.
 *
 * The file set is not the tsconfig's `include`: it is every .ts/.tsx/.mts/.cts and own .d.ts under the
 * API plus whatever the program loads, each checked by the project (tsconfig, its references, side
 * configs) that lists it (see src/core/typecheck.ts). Anything the type check cannot decide (an
 * unusable tsconfig, no tsconfig and settings-dependent errors, a declared dependency that does not
 * resolve, no TypeScript at all) is UNPROVEN, with the reason; syntactic violations are still reported.
 */
import { resolve } from 'node:path';
import { defineCheck, FORCED_FLAGS, isTestFile, isTestSupport, typecheckOf } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, TypecheckResult, Violation } from '../../src/core/plugin-api.ts';
import { findImplicitAny, findUnsafeCode } from '../lib/ts-safety.ts';

const RULE = 'tsc-strict';
const PROJECT = '(project)';
/** Directory names that hold test code (tests may read untyped library values such as supertest's res.body). */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', 'e2e', 'fixtures', '__fixtures__']);

const DOC = `tsc-strict (unit: errors; the summary prints "N errors")
Every TypeScript file of the API must type-check with
  ${FORCED_FLAGS}
forced, whatever tsconfig.json says (an explicit "strictNullChecks": false, "noCheck": true or a narrow
"include" changes nothing). Checked: every .ts/.tsx/.mts/.cts and own .d.ts under the API (tests, config
files and files no tsconfig lists included), each with the options of the tsconfig (or referenced project)
that lists it; node_modules and build output are not.
Banned in every checked file (reported with file:line:col):
- the \`any\` keyword (annotations, \`as any\`, generic arguments, declarations in .d.ts): use unknown and narrow, or a precise type
- outside test code also \`any\` without the keyword (type checker): a variable, parameter, function result or type alias
  whose type is any (e.g. \`type T = ReturnType<typeof JSON.parse>\`, \`const x = JSON.parse(s)\`, an untyped
  \`(err, req, res, next) =>\` parameter), and member access or calls on an any-typed value
- non-null assertions \`expr!\` and definite-assignment assertions (\`id!: string\`, \`let x!: T\`): check for null/undefined explicitly, or initialise
- @ts-ignore, @ts-expect-error, @ts-nocheck comments: fix the error instead
Indexed access is \`T | undefined\` under noUncheckedIndexedAccess: handle the undefined case.
Passing example:
  const first = items[0];
  if (first === undefined) throw notFound('no items');
  const parsed: unknown = JSON.parse(text);
  const body = BodySchema.parse(parsed);   // narrow unknown with a Zod schema
UNPROVEN (never green) when the type check cannot decide: an unusable tsconfig, no tsconfig.json and errors
that depend on the harness's default settings, a declared dependency that does not resolve, or no TypeScript files.`;

/** Test code: a test file, test support, or anything under a test-named directory. */
function isTestCode(rel: string): boolean {
  return isTestFile(rel) || isTestSupport(rel) || rel.split('/').slice(0, -1).some((seg) => TEST_DIRS.has(seg));
}

/** "file:line:col" order within one file. */
function byPosition(a: Violation, b: Violation): number {
  const at = (v: Violation): number[] => v.location.split(':').slice(-2).map(Number);
  const [al = 0, ac = 0] = at(a);
  const [bl = 0, bc = 0] = at(b);
  return al - bl || ac - bc;
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const tc = typecheckOf(ctx);
  let result: TypecheckResult | undefined;
  const problems: string[] = [];
  try {
    result = tc.result();
    problems.push(...result.problems);
  } catch (e) {
    problems.push(`the type check could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
  const files = result?.files ?? [...tc.files];

  const byFile = new Map<string, Violation[]>();
  const add = (file: string, v: Violation): void => {
    const list = byFile.get(file) ?? [];
    list.push(v);
    byFile.set(file, list);
  };
  const projectViolations: Violation[] = [];
  for (const d of result?.errors ?? []) {
    if (d.file === null) projectViolations.push({ location: d.location, message: d.message });
    else add(d.file, { location: d.location, message: d.message });
  }
  // Syntactic: needs no configuration, so it is reported even when the type check is unproven.
  const keywordAny = new Set<string>();
  for (const file of files) {
    const text = await ctx.read(file);
    for (const v of findUnsafeCode(resolve(ctx.root, file), text)) {
      add(file, { location: `${file}:${v.line}:${v.col}`, message: v.message });
      if (v.kind === 'any') keywordAny.add(`${file}:${v.line}`);
    }
  }
  // `any` without the keyword (ReturnType<typeof JSON.parse>, an unannotated JSON.parse result, an untyped
  // callback parameter): found with the type checker, outside test code.
  if (result?.usable === true) {
    for (const file of files.filter((f) => !isTestCode(f))) {
      const source = result.sourceOf(file);
      if (source === undefined) continue;
      for (const v of findImplicitAny(source.program, source.sf)) {
        if (!keywordAny.has(`${file}:${v.line}`)) add(file, { location: `${file}:${v.line}:${v.col}`, message: v.message });
      }
    }
  }
  if (files.length === 0 && problems.length === 0) problems.push('the API has no TypeScript files: nothing was type-checked');

  const findings: CheckFinding[] = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, violations]) => ({ rule: RULE, file, status: 'fail', units: { passed: 0, total: violations.length }, violations: violations.sort(byPosition) }));
  const errors = findings.reduce((n, f) => n + f.violations.length, 0) + projectViolations.length;
  if (problems.length > 0) {
    findings.push({ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: projectViolations, skipReason: problems.join('; ') });
  } else {
    findings.push({
      rule: RULE,
      file: PROJECT,
      status: errors === 0 ? 'pass' : 'fail',
      // A clean project is one passing unit; otherwise each project-level diagnostic is one failing unit,
      // so sum(total - passed) over all findings is always the error count.
      units: errors === 0 ? { passed: 1, total: 1 } : { passed: 0, total: projectViolations.length },
      violations: projectViolations,
    });
  }
  await ctx.logs.write('tsc-strict.txt', [
    ...(result?.log ?? []),
    `files: ${files.length}, errors: ${errors}`,
    ...problems.map((p) => `UNPROVEN: ${p}`),
    ...findings.flatMap((f) => f.violations.map((v) => `${v.location}  ${v.message}`)),
  ].join('\n'));
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'Every TypeScript file of the API type-checks with all strict flags + noUncheckedIndexedAccess forced; no `any`, no `x!` / `id!: T`, no @ts-ignore/@ts-expect-error/@ts-nocheck.',
  unit: 'errors',
  doc: DOC,
  run,
});
