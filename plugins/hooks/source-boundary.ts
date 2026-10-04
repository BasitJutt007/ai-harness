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
 * Production code may not detect that it runs under a test either: reading process.env.VITEST* /
 * JEST_WORKER_ID, comparing NODE_ENV with 'test', or reading import.meta.env.MODE / .VITEST / import.meta.vitest
 * would let it behave one way under the harness's runner and another in production (a test could then go
 * green on a code path production never takes).
 * Only NEW violations are blocked, so legacy code stays editable (a read present at run start stays allowed).
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

/** Env variables test runners set in the processes they run: reading them tells code it is under test. */
const TEST_ENV_RE = /^(__)?VITEST(_.*)?$|^JEST_WORKER_ID$/;
/** import.meta.env keys vite/vitest fill in for a test run. */
const META_ENV_KEYS = new Set(['MODE', 'VITEST', 'TEST']);

/** `process.env` (also `globalThis.process.env`). */
function isProcessEnv(e: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'env') return false;
  const p = e.expression;
  return (ts.isIdentifier(p) && p.text === 'process')
    || (ts.isPropertyAccessExpression(p) && p.name.text === 'process' && ts.isIdentifier(p.expression) && p.expression.text === 'globalThis');
}

/** The key of `process.env.X` / `process.env['X']`, else null. */
function processEnvKey(e: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(e) && isProcessEnv(e.expression)) return e.name.text;
  if (ts.isElementAccessExpression(e) && isProcessEnv(e.expression) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return null;
}

function isImportMeta(e: ts.Expression): boolean {
  return ts.isMetaProperty(e) && e.keywordToken === ts.SyntaxKind.ImportKeyword && e.name.text === 'meta';
}

function isTestLiteral(e: ts.Expression): boolean {
  return ts.isStringLiteralLike(e) && e.text === 'test';
}

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

/**
 * Reads in `sf` that tell code it runs under a test runner: process.env.VITEST* / JEST_WORKER_ID (property,
 * element access, `in`, destructuring), NODE_ENV compared with 'test' (also a `case 'test'` of a switch on it),
 * import.meta.env.MODE / .VITEST / .TEST and import.meta.vitest.
 */
export function testEnvironmentReads(sf: ts.SourceFile): Spec[] {
  const out: Spec[] = [];
  const add = (text: string, node: ts.Node): void => {
    out.push({ text, node });
  };
  const visit = (node: ts.Node): void => {
    const key = processEnvKey(node);
    if (key !== null && TEST_ENV_RE.test(key)) add(`process.env.${key}`, node);
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (EQUALITY.has(k)) {
        const nodeEnv = (e: ts.Expression): boolean => processEnvKey(e) === 'NODE_ENV';
        if ((nodeEnv(node.left) && isTestLiteral(node.right)) || (nodeEnv(node.right) && isTestLiteral(node.left))) add("process.env.NODE_ENV === 'test'", node);
      } else if (k === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(node.left) && TEST_ENV_RE.test(node.left.text) && isProcessEnv(node.right)) {
        add(`process.env.${node.left.text}`, node);
      }
    }
    if (ts.isSwitchStatement(node) && processEnvKey(node.expression) === 'NODE_ENV'
      && node.caseBlock.clauses.some((c) => ts.isCaseClause(c) && isTestLiteral(c.expression))) {
      add("process.env.NODE_ENV === 'test'", node);
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const name = el.propertyName !== undefined && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName)) ? el.propertyName.text
          : ts.isIdentifier(el.name) ? el.name.text : '';
        if (TEST_ENV_RE.test(name)) add(`process.env.${name}`, el);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (isImportMeta(node.expression) && node.name.text === 'vitest') add('import.meta.vitest', node);
      const env = node.expression;
      if (ts.isPropertyAccessExpression(env) && isImportMeta(env.expression) && env.name.text === 'env' && META_ENV_KEYS.has(node.name.text)) {
        add(`import.meta.env.${node.name.text}`, node);
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
  for (const r of testEnvironmentReads(sf)) {
    const lc = sf.getLineAndCharacterOfPosition(r.node.getStart(sf));
    out.push({
      line: lc.line + 1,
      col: lc.character + 1,
      key: `testenv|${r.text ?? ''}`,
      message: `${r.text ?? 'a test-runner variable'} tells the code it runs under a test runner; production code must behave the same under test (pass configuration in explicitly instead)`,
    });
  }
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
  description: 'Blocks source files that import test code, reach outside the source roots of the API, use computed/absolute imports, or detect the test runner.',
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
          `source-boundary: ${r.rel} would cross the production code boundary:`,
          ...violations.map((v) => `  ${r.rel}:${v.line}:${v.col}  ${v.message}`),
          'Move shared code into src/ (under observed red) and import it with a relative string literal.',
        ].join('\n'),
      };
    }
    return { decision: 'pass' };
  },
});
