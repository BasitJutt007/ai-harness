/**
 * Optional conveniences for plugin authors (not a plugin: the registry skips lib/).
 *
 * Re-exports the whole plugin API (define* helpers and every contract type), so a
 * drop-in plugin can import everything it needs from one place, plus a few small,
 * mechanical helpers for checks that walk the TypeScript AST:
 *
 *   import { defineCheck, fileFinding, nodeLocation, walk } from '../lib/plugin-helpers.ts';
 *
 * Plugins may equally import from '../../src/core/plugin-api.ts' directly; this
 * file adds nothing the core depends on.
 */
import ts from 'typescript';
import type { CheckFinding, Violation } from '../../src/core/plugin-api.ts';

export * from '../../src/core/plugin-api.ts';

/** "src/x.ts:12:5" (1-based) for a node of `sf`, labelled with the API-relative path `rel`. */
export function nodeLocation(sf: ts.SourceFile, node: ts.Node, rel: string): string {
  const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${rel}:${lc.line + 1}:${lc.character + 1}`;
}

/** Depth-first visit of every node under `root` (root included). */
export function walk(root: ts.Node, visit: (node: ts.Node) => void): void {
  const go = (n: ts.Node): void => {
    visit(n);
    ts.forEachChild(n, go);
  };
  go(root);
}

/**
 * One finding for one file: `total` units checked, each violation is one failing unit.
 * pass iff there are no violations. Returns null when nothing in the file was checked,
 * so a rule with nothing to check reports n/a instead of a vacuous pass.
 */
export function fileFinding(rule: string, file: string, total: number, violations: Violation[]): CheckFinding | null {
  if (total === 0 && violations.length === 0) return null;
  const units = Math.max(total, violations.length);
  return {
    rule,
    file,
    status: violations.length === 0 ? 'pass' : 'fail',
    units: { passed: units - violations.length, total: units },
    violations,
  };
}

/** Last name of an identifier / property access chain (`schema.users` → "users"). */
export function lastName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return lastName(expr.expression);
  return undefined;
}

/** Whether an object literal declares property `name` (`name: …`, shorthand `name`, or method `name()`). */
export function hasProperty(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return false;
    const n = p.name;
    if (n === undefined) return false;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text === name;
    return false;
  });
}
