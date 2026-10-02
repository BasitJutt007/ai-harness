/**
 * no-console (category "lint"): no console.* calls in src/**. Debug output leaks
 * request data into logs and is not a logging strategy.
 *
 * Drop-in: copy this file to plugins/checks/. It joins `harness check` and the
 * standards gate with its own lines:
 *   no-console        pass  src/app.ts                       1/1 files
 *   no-console        FAIL  src/routes/users.ts              0/1 files
 *       src/routes/users.ts:14:5  console.log(...): remove it or use the app logger
 *
 * Policy (edit the two constants, like an ESLint rule option):
 * - console.error / console.warn are allowed (operational error logging, e.g. a 5xx handler);
 * - the process entrypoint src/server.ts may log its startup line.
 * An API with no source files gets no findings → n/a.
 */
import ts from 'typescript';
import { defineCheck, fileFinding, nodeLocation, walk } from '../lib/plugin-helpers.ts';
import type { CheckContext, CheckFinding, Violation } from '../lib/plugin-helpers.ts';

const RULE = 'no-console';
const ALLOWED_METHODS = new Set(['error', 'warn']);
const EXEMPT_FILES = new Set(['src/server.ts']);

const DOC = `${RULE} (category: lint, unit: files)
No console.* calls in src/** (console.log, .info, .debug, .trace, .dir, .table, …).
Allowed: console.error and console.warn (operational error logging); the entrypoint src/server.ts.
Each file is one unit; every offending call is reported as file:line:col.
Fix: delete debug output, or route it through the application's logger.`;

/** `console.x(...)`, `console['x'](...)`, `globalThis.console.x(...)` → "x". */
function consoleMethod(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  let obj: ts.Expression;
  let method: string | undefined;
  if (ts.isPropertyAccessExpression(callee)) {
    obj = callee.expression;
    method = callee.name.text;
  } else if (ts.isElementAccessExpression(callee)) {
    obj = callee.expression;
    const arg = callee.argumentExpression;
    method = ts.isStringLiteralLike(arg) ? arg.text : '<computed>';
  } else {
    return undefined;
  }
  const isConsole = (ts.isIdentifier(obj) && obj.text === 'console')
    || (ts.isPropertyAccessExpression(obj) && obj.name.text === 'console' && ts.isIdentifier(obj.expression) && obj.expression.text === 'globalThis');
  return isConsole ? method : undefined;
}

/** Offending console calls in one parsed file. */
export function consoleViolations(sf: ts.SourceFile, rel: string): Violation[] {
  const out: Violation[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const method = consoleMethod(n);
    if (method === undefined || ALLOWED_METHODS.has(method)) return;
    out.push({ location: nodeLocation(sf, n, rel), message: `console.${method}(...): remove it or use the app logger` });
  });
  return out;
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  for (const file of ctx.sourceFiles) {
    if (EXEMPT_FILES.has(file)) continue;
    const text = await ctx.read(file);
    // Cheapest mechanism first: a file that never says "console" passes without parsing.
    const violations = text.includes('console') ? consoleViolations(ctx.sourceFile(file), file) : [];
    const f = fileFinding(RULE, file, 1, violations);
    if (f !== null) findings.push({ ...f, units: { passed: violations.length === 0 ? 1 : 0, total: 1 } });
  }
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'lint',
  description: 'No console.* debug output in src/** (console.error/warn and the src/server.ts entrypoint allowed).',
  unit: 'files',
  doc: DOC,
  run,
});
