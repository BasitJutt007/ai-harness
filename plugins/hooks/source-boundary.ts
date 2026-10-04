/**
 * source-boundary (pre, write of governed .ts): production code may only import
 * production code. A source file must not import a test file (test/**, *.test.ts,
 * *.spec.ts) — those are writable without an observed red, so importing one would
 * smuggle unreviewed behaviour past the observed-red rule. Files under the API's source
 * roots (src/ for the template; its TargetProfile layout otherwise) may only import relative
 * modules under the source roots (plus packages), and nobody may import
 * by absolute path or through a computed `import(x)` / `require(x)`. Module-loader APIs
 * (`node:module`, e.g. createRequire, and process.getBuiltinModule) are refused too: a
 * require function they return loads any path without the hook seeing it. Production code
 * may not import the test runner (vitest), which would let it rewire assertions.
 * Only NEW violations are blocked, so legacy code stays editable.
 */
import path from 'node:path';
import ts from 'typescript';
import { activeLayout, defineHook, sourceRootsLabel, underAny } from '../../src/core/plugin-api.ts';
import { proposedContent } from '../lib/diff.ts';
import { stringField, toApiRel } from '../lib/path-policy.ts';
import { isGovernedSource, isTestFile, isTestSupport } from '../lib/red.ts';

export interface BoundaryViolation {
  line: number;
  col: number;
  /** Stable identity for "new vs existing" comparison. */
  key: string;
  message: string;
}

interface Spec {
  text: string | null;
  node: ts.Node;
}

function specifiers(sf: ts.SourceFile): Spec[] {
  const out: Spec[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      out.push({ text: ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null, node: node.moduleSpecifier });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      out.push({ text: ts.isStringLiteralLike(e) ? e.text : null, node: e });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule') out.push({ text: 'node:module', node });
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isImport || isRequire) {
        const arg = node.arguments[0];
        out.push({ text: arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null, node: arg ?? node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Import-boundary violations of `content` as file `rel` (API-relative). */
export function boundaryViolations(rel: string, content: string): BoundaryViolation[] {
  const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const roots = activeLayout().sourceRoots;
  const inSrc = underAny(rel, roots);
  const out: BoundaryViolation[] = [];
  for (const s of specifiers(sf)) {
    const lc = sf.getLineAndCharacterOfPosition(s.node.getStart(sf));
    const at = { line: lc.line + 1, col: lc.character + 1 };
    if (s.text === null) {
      out.push({ ...at, key: 'computed', message: 'computed import()/require(): use a string literal so the import graph is checkable' });
      continue;
    }
    const spec = s.text;
    if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('file:')) {
      out.push({ ...at, key: `abs|${spec}`, message: `absolute import "${spec}": import modules relative to the file` });
      continue;
    }
    if (/^(node:)?module$/.test(spec)) {
      out.push({ ...at, key: 'loader', message: 'module-loader API (node:module, createRequire, getBuiltinModule): loads code past the import graph; use static imports' });
      continue;
    }
    if (/^(vitest|@vitest\/.+|vitest\/.+)$/.test(spec)) {
      out.push({ ...at, key: `runner|${spec}`, message: `"${spec}" is the test runner; production code must not depend on it` });
      continue;
    }
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue; // package or node: builtin
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.([cm]?)js$/, '.$1ts');
    if (target === '..' || target.startsWith('../')) {
      out.push({ ...at, key: `escape|${spec}`, message: `"${spec}" resolves outside the API root` });
    } else if (isTestFile(target) || isTestSupport(target)) {
      out.push({ ...at, key: `test|${target}`, message: `"${spec}" imports test code (${target}); production code must not depend on tests` });
    } else if (inSrc && !underAny(target, roots)) {
      const where = sourceRootsLabel();
      out.push({ ...at, key: `outside|${target}`, message: `"${spec}" imports ${target}, outside ${where}; source under ${where} may only import modules there and packages` });
    }
  }
  return out;
}

/** Violations in `after` that `before` did not already have (multiset by key). */
export function newBoundaryViolations(rel: string, before: string | null, after: string): BoundaryViolation[] {
  const found = boundaryViolations(rel, after);
  if (before === null) return found;
  const existing = new Map<string, number>();
  for (const v of boundaryViolations(rel, before)) existing.set(v.key, (existing.get(v.key) ?? 0) + 1);
  return found.filter((v) => {
    const n = existing.get(v.key) ?? 0;
    if (n > 0) {
      existing.set(v.key, n - 1);
      return false;
    }
    return true;
  });
}

export default defineHook({
  name: 'source-boundary',
  description: 'Blocks source files that import test code, reach outside src/, or use computed/absolute imports.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    const target = call.paths[0];
    if (target === undefined) return { decision: 'pass' };
    const r = toApiRel(ctx.workspace, target);
    if (!r.ok || !isGovernedSource(r.rel)) return { decision: 'pass' };

    const before = await ctx.workspace.read(r.rel);
    const after = proposedContent(call.input, before);
    if (after === undefined) return { decision: 'pass' }; // not computable: the tool reports 0/2+ edit matches itself
    const violations = newBoundaryViolations(r.rel, before, after);
    if (violations.length === 0) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: [
        `source-boundary: ${r.rel} would import outside the production code boundary:`,
        ...violations.map((v) => `  ${r.rel}:${v.line}:${v.col}  ${v.message}`),
        'Move shared code into src/ (under observed red) and import it with a relative string literal.',
      ].join('\n'),
    };
  },
});
