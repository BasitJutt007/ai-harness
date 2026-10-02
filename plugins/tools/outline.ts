import ts from 'typescript';
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';

const Input = z.object({
  path: z.string(),
});

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefault(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function stringArg(node: ts.Expression | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

/** Syntactic outline: imports, exports (kind + line), zod schema consts, route registrations. */
export function outlineSource(fileName: string, content: string): string[] {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const imports: string[] = [];
  const exports: string[] = [];
  const schemas: string[] = [];
  const routes: string[] = [];

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = stringArg(st.moduleSpecifier);
      if (spec !== undefined) imports.push(spec);
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      const from = st.moduleSpecifier ? stringArg(st.moduleSpecifier) : undefined;
      const names =
        st.exportClause && ts.isNamedExports(st.exportClause)
          ? st.exportClause.elements.map((e) => e.name.text).join(', ')
          : '*';
      exports.push(`{ ${names} }${from ? ` from ${from}` : ''} L${line(st)}`);
      continue;
    }
    if (ts.isExportAssignment(st)) {
      exports.push(`default L${line(st)}`);
      continue;
    }
    if (ts.isVariableStatement(st)) {
      const kind = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (hasExport(st)) exports.push(`${kind} ${d.name.text} L${line(d)}`);
        if (d.initializer && d.initializer.getText(sf).startsWith('z.')) schemas.push(`${d.name.text} L${line(d)}`);
      }
      continue;
    }
    if (!hasExport(st)) continue;
    const prefix = isDefault(st) ? 'default ' : '';
    const named = (kind: string, name: ts.Identifier | undefined): void => {
      exports.push(`${prefix}${kind} ${name?.text ?? '(anonymous)'} L${line(st)}`);
    };
    if (ts.isFunctionDeclaration(st)) named('function', st.name);
    else if (ts.isClassDeclaration(st)) named('class', st.name);
    else if (ts.isInterfaceDeclaration(st)) named('interface', st.name);
    else if (ts.isTypeAliasDeclaration(st)) named('type', st.name);
    else if (ts.isEnumDeclaration(st)) named('enum', st.name);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const p = stringArg(node.arguments[0]);
      if (METHODS.has(method) && p !== undefined && p.startsWith('/')) {
        routes.push(`${method.toUpperCase()} ${p} L${line(node)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const out: string[] = [];
  out.push(`imports: ${imports.length ? imports.join(', ') : '(none)'}`);
  out.push(`exports: ${exports.length ? exports.join('; ') : '(none)'}`);
  if (schemas.length) out.push(`schemas: ${schemas.join(', ')}`);
  if (routes.length) out.push(`routes: ${routes.join('; ')}`);
  return out;
}

export default defineTool({
  name: 'outline',
  description: 'Imports, exports, zod schemas and routes of a .ts file, with line numbers.',
  input: Input,
  effect: 'read',
  async run(input, ctx) {
    const r = toApiRel(ctx.workspace, input.path);
    if (!r.ok) return { ok: false, summary: `outline: ${r.reason}` };
    const content = await ctx.workspace.read(r.rel);
    if (content === null) return { ok: false, summary: `outline: ${r.rel} does not exist` };
    const total = content === '' ? 0 : content.split('\n').length;
    const summary = [`${r.rel} (${total} lines)`, ...outlineSource(r.rel, content)].join('\n');
    // Baseline (naive) return: the whole file (what a harness without outline would read).
    const whole = `${r.rel} (${total} lines)\n${content}`;
    return { ok: true, summary, raw: whole.length >= summary.length ? whole : summary };
  },
});
