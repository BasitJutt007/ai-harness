/**
 * The post-image of a write: what a file will contain after a write-effect call, as the loop
 * computed it once from the tool's own preview() (ToolCallInfo.preview). Content hooks judge
 * this, never the tool's input field names, so a new write tool is checked exactly like the
 * shipped ones, and a write tool without preview() is refused (fail closed).
 *
 * Also the structural facts the elision guard compares between pre- and post-image: placeholder
 * occurrences, whether the module parses, and its surface (exported names, route registrations).
 */
import { posix } from 'node:path';
import ts from 'typescript';
import { ELISION_PLACEHOLDER } from '../../src/core/plugin-api.ts';
import type { ToolCallInfo } from '../../src/core/plugin-api.ts';

export type PostImage = { ok: true; after: string | null } | { ok: false; reason: string };

/** Post-call content of `path` (as declared in call.paths); not ok when it is unknown. null = no file afterwards. */
export function postImage(call: ToolCallInfo, path: string): PostImage {
  if (call.preview === undefined) {
    return {
      ok: false,
      reason: `write tool ${call.tool} declares no preview(), so the content it would write to ${path} cannot be checked; refused (fail closed). ` +
        'A write tool must implement preview(input, before) returning the exact post-write content.',
    };
  }
  const after = call.preview.get(path);
  if (after === undefined) return { ok: false, reason: `the content ${call.tool} would write to ${path} could not be computed; refused (fail closed).` };
  return { ok: true, after };
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
};

/** The TypeScript script kind of a path, or undefined when it is not a script. */
export function scriptKind(rel: string): ts.ScriptKind | undefined {
  return SCRIPT_KINDS[posix.extname(rel).toLowerCase()];
}

function parse(rel: string, text: string, kind: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

/** [start, end) ranges of string, template and regex literals: placeholder text inside them is data. */
function literalRanges(sf: ts.SourceFile): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isRegularExpressionLiteral(n) || ts.isTemplateLiteralToken(n)) out.push([n.getStart(sf), n.getEnd()]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Placeholder texts (ELISION_PLACEHOLDER) in `text`, outside string/template/regex literals of a script. */
export function placeholders(rel: string, text: string): string[] {
  const re = new RegExp(ELISION_PLACEHOLDER.source, 'g');
  const hits = [...text.matchAll(re)];
  if (hits.length === 0) return [];
  const kind = scriptKind(rel);
  const literals = kind === undefined ? [] : literalRanges(parse(rel, text, kind));
  return hits.filter((m) => !literals.some(([s, e]) => m.index >= s && m.index < e)).map((m) => m[0]);
}

/** Placeholders the post-image has that the pre-image did not (multiset). */
export function newPlaceholders(rel: string, before: string | null, after: string): string[] {
  const had = new Map<string, number>();
  for (const p of before === null ? [] : placeholders(rel, before)) had.set(p, (had.get(p) ?? 0) + 1);
  return placeholders(rel, after).filter((p) => {
    const n = had.get(p) ?? 0;
    had.set(p, n - 1);
    return n <= 0;
  });
}

/** The first syntax error of a script ("line:col message"), or null when it parses. Purely syntactic, no type information. */
export function syntaxError(rel: string, text: string): string | null {
  const kind = scriptKind(rel);
  if (kind === undefined) return null;
  const sf = parse(rel, text, kind);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (f) => (f === rel ? sf : undefined);
  host.fileExists = (f) => f === rel;
  host.readFile = (f) => (f === rel ? text : undefined);
  const d = ts.createProgram({ rootNames: [rel], options, host }).getSyntacticDiagnostics(sf)[0];
  if (d === undefined) return null;
  const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
  return `${lc.line + 1}:${lc.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options', 'all', 'use', 'route']);
const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All']);

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

/** Exported names of a top-level statement (`default` for a default export, `* from x` for a star re-export). */
function exportedNames(st: ts.Statement): string[] {
  if (ts.isExportDeclaration(st)) {
    const from = st.moduleSpecifier !== undefined && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
    const clause = st.exportClause;
    if (clause === undefined) return [`* from ${from}`];
    return ts.isNamedExports(clause) ? clause.elements.map((el) => el.name.text) : [clause.name.text];
  }
  if (ts.isExportAssignment(st)) return [st.isExportEquals === true ? '=' : 'default'];
  if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
    // CommonJS: exports.x = … / module.exports = …
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const text = st.expression.left.getText();
      if (/^(module\.)?exports(\.[\w$]+)?$/.test(text)) return [text];
    }
    return [];
  }
  if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) return ['default'];
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)
    || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) && st.name !== undefined) return [st.name.getText()];
  return [];
}

/** A route registration: `x.get('/path', …)` and friends, `x.route('/path')`, or a `@Get('/path')`-style decorator. */
function routeKey(n: ts.Node): string | null {
  if (ts.isDecorator(n) && ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression) && ROUTE_DECORATORS.has(n.expression.expression.text)) {
    const arg = n.expression.arguments[0];
    return `@${n.expression.expression.text}(${arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : ''})`;
  }
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !ROUTE_METHODS.has(n.expression.name.text)) return null;
  const arg = n.arguments[0];
  if (arg !== undefined && ts.isStringLiteralLike(arg) && arg.text.startsWith('/')) return `${n.expression.name.text} ${arg.text}`;
  return null;
}

/**
 * What other code relies on in a module: its exported names and its route registrations. A write that
 * keeps fewer than half of them is what a partial or placeholder copy of the file looks like.
 */
export function moduleSurface(rel: string, text: string): string[] {
  const kind = scriptKind(rel);
  if (kind === undefined) return [];
  const sf = parse(rel, text, kind);
  const out = sf.statements.flatMap((st) => exportedNames(st).map((x) => `export ${x}`));
  const visit = (n: ts.Node): void => {
    const r = routeKey(n);
    if (r !== null) out.push(`route ${r}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
