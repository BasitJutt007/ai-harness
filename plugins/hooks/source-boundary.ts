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
 * Non-relative specifiers are resolved the way the API resolves them (tsconfig paths/baseUrl,
 * package.json `imports`, the runner's aliases) before they count as packages, so `@test/x` mapped
 * to test/x.ts is test code like `../test/x.ts`.
 * Only NEW violations are blocked, so legacy code stays editable.
 */
import path from 'node:path';
import ts from 'typescript';
import { activeLayout, defineHook, resolveImport, sourceRootsLabel, underAny } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { postImage } from '../lib/post-image.ts';
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

/**
 * Import-boundary violations of `content` as file `rel` (API-relative). Every specifier is resolved with the
 * harness resolver (testmap.ts resolveImport, the active layout) before it counts as a package, so an alias
 * to test code is judged like the relative import it stands for. `existing`: the API's files (aliases that
 * need an existing target, e.g. baseUrl, resolve against it).
 */
export function boundaryViolations(rel: string, content: string, existing: ReadonlySet<string> = new Set()): BoundaryViolation[] {
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
    const relative = spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
    let target: string;
    if (relative) {
      target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.([cm]?)js$/, '.$1ts');
    } else {
      // A bare specifier is a package only if the API's own resolution (tsconfig paths/baseUrl, package.json
      // `imports`, the runner's aliases) does not map it to a local file: `@test/x` -> test/x.ts is test code.
      const local = resolveImport(rel, spec, existing);
      if (local === null || local.split('/').includes('node_modules')) continue; // package or node: builtin
      target = local;
    }
    const via = relative ? `"${spec}"` : `"${spec}" (resolves to ${target})`;
    if (target === '..' || target.startsWith('../')) {
      out.push({ ...at, key: `escape|${spec}`, message: `"${spec}" resolves outside the API root` });
    } else if (isTestFile(target) || isTestSupport(target)) {
      out.push({ ...at, key: `test|${target}`, message: `${via} imports test code (${target}); production code must not depend on tests` });
    } else if (inSrc && !underAny(target, roots)) {
      const where = sourceRootsLabel();
      out.push({ ...at, key: `outside|${target}`, message: `${via} imports ${target}, outside ${where}; source under ${where} may only import modules there and packages` });
    }
  }
  return out;
}

/** Violations in `after` that `before` did not already have (multiset by key). */
export function newBoundaryViolations(rel: string, before: string | null, after: string, files: ReadonlySet<string> = new Set()): BoundaryViolation[] {
  const found = boundaryViolations(rel, after, files);
  if (before === null) return found;
  const existing = new Map<string, number>();
  for (const v of boundaryViolations(rel, before, files)) existing.set(v.key, (existing.get(v.key) ?? 0) + 1);
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
  description: 'Blocks source files that import test code, reach outside the source roots of the API, or use computed/absolute imports.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    let files: ReadonlySet<string> | undefined;
    for (const target of call.paths) {
      const r = toApiRel(ctx.workspace, target);
      if (!r.ok || !isGovernedSource(r.rel)) continue;
      // Judged on the post-image the loop computed from the tool's preview(); none = fail closed.
      const img = postImage(call, target);
      if (!img.ok) return { decision: 'block', reason: `source-boundary: ${img.reason}` };
      if (img.after === null) continue; // no file afterwards
      const before = await ctx.workspace.read(r.rel);
      files ??= new Set(await ctx.workspace.list(['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx']));
      const violations = newBoundaryViolations(r.rel, before, img.after, files);
      if (violations.length === 0) continue;
      return {
        decision: 'block',
        reason: [
          `source-boundary: ${r.rel} would import outside the production code boundary:`,
          ...violations.map((v) => `  ${r.rel}:${v.line}:${v.col}  ${v.message}`),
          'Move shared code into src/ (under observed red) and import it with a relative string literal.',
        ].join('\n'),
      };
    }
    return { decision: 'pass' };
  },
});
