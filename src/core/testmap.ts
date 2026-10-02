/**
 * Static import graph between test files and source files.
 *
 * Deterministic: parses imports with the TypeScript parser (no type checking),
 * resolves relative specifiers the way NodeNext + TS do for .ts sources, and keeps
 * targets that do not exist yet as nodes (a test may import a module the agent
 * has not written; that is exactly the "observed red" case).
 */
import ts from 'typescript';
import { posix } from 'node:path';
import type { TestMap, Workspace } from './types.ts';

const TEST_RE = /\.(test|spec)\.[cm]?ts$/;
const TS_RE = /\.[cm]?ts$/;

export function isTestFile(rel: string): boolean {
  return TEST_RE.test(rel);
}

export async function buildTestMap(ws: Workspace): Promise<TestMap> {
  // Every .ts file under the API root: governed files outside src/ are covered through imports too.
  const files = (await ws.list(['**/*.ts', '**/*.mts', '**/*.cts']))
    .filter((f) => !/\.d\.[cm]?ts$/.test(f) && !f.startsWith('dist/') && !f.includes('/dist/'))
    .sort();
  const existing = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const text = (await ws.read(file)) ?? '';
    const targets = new Set<string>();
    for (const spec of importSpecifiers(file, text)) {
      const target = resolveSpecifier(file, spec, existing);
      if (target !== null) targets.add(target);
    }
    edges.set(file, [...targets].sort());
  }
  const tests = files.filter(isTestFile);
  const coverage: Record<string, string[]> = {};
  for (const test of tests) coverage[test] = closure(test, edges);
  return createTestMap(coverage, existing);
}

/**
 * Build the TestMap view (testsFor) over a coverage table. The basename fallback
 * (test/x.test.ts for src/x.ts) applies only to a source that does not exist yet
 * (per `existing`; without it, to any source no test imports).
 */
export function createTestMap(coverage: Record<string, string[]>, existing?: ReadonlySet<string>): TestMap {
  const tests = Object.keys(coverage).sort();
  return {
    coverage,
    testsFor(source: string): string[] {
      const src = normalizeSource(source);
      const direct = tests.filter((t) => (coverage[t] ?? []).includes(src));
      if (direct.length > 0) return direct;
      if (existing?.has(src) === true) return [];
      const base = stem(src);
      return tests.filter((t) => stem(t) === base);
    },
  };
}

/** Every module specifier a file references: import/export-from, dynamic import(lit), vi.mock(lit) & friends. */
export function importSpecifiers(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg) && isImportLikeCall(node)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isImportLikeCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi') {
    return ['mock', 'doMock', 'importActual', 'importMock'].includes(callee.name.text);
  }
  return false;
}

/**
 * Resolve a relative specifier from `from` (API-relative) to an API-relative path.
 * `./x.js` → `./x.ts`; `./x` → `./x.ts` or `./x/index.ts` (whichever exists, else `./x.ts`).
 * Non-relative specifiers and paths escaping the API root → null.
 */
export function resolveSpecifier(from: string, spec: string, existing: ReadonlySet<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  if (joined.startsWith('../') || joined === '..') return null;
  const jsMatch = /\.([cm]?)js$/.exec(joined);
  if (jsMatch !== null) return `${joined.slice(0, -jsMatch[0].length)}.${jsMatch[1] ?? ''}ts`;
  if (/\.[cm]?ts$/.test(joined)) return joined;
  if (/\.[a-z0-9]+$/i.test(joined) && !existing.has(`${joined}.ts`)) return joined; // e.g. ./data.json
  if (existing.has(`${joined}.ts`)) return `${joined}.ts`;
  if (existing.has(`${joined}/index.ts`)) return `${joined}/index.ts`;
  return `${joined}.ts`;
}

/** Non-test source files reachable from `start` (excluding `start` itself): .ts anywhere, anything under src/. */
function closure(start: string, edges: ReadonlyMap<string, string[]>): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const t of edges.get(next) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  seen.delete(start);
  return [...seen].filter((f) => !isTestFile(f) && (TS_RE.test(f) || f.startsWith('src/'))).sort();
}

function normalizeSource(p: string): string {
  const clean = posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  return clean.replace(/\.([cm]?)js$/, '.$1ts');
}

/** Basename without extension and without a trailing .test/.spec. */
function stem(p: string): string {
  return posix.basename(p).replace(/\.[cm]?[jt]s$/, '').replace(/\.(test|spec)$/, '');
}
