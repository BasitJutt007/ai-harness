/**
 * Which modules the contract runtime may import, i.e. execute (contract.ts).
 *
 * Importing a schema module runs it, and code running in the measuring process controls the
 * measurement: it can show the contract runtime a different schema than the app enforces (e.g.
 * branch on process.argv) or rewrite the runtime's output. So the runtime only imports a module
 * whose whole relative import closure is, file by file, either
 *   - trusted: unchanged since the base commit (operator code, not agent code), or
 *   - declarative: imports (zod or other importable modules), types, enums with literal values,
 *     and consts/functions built only from zod calls, literals, their own locals and a few pure
 *     globals. No statements with effects, no assignments to properties, no `this`, `import()`,
 *     `import.meta`, `process`, `globalThis`, classes, and no member named `constructor`,
 *     `prototype`, `__proto__` or starting with `_` (zod internals).
 * Anything else is not imported: its schemas fall back to the static source hash (unchanged
 * text = no change; changed text = UNPROVEN), never to a runtime value agent code could fake.
 */
import { posix } from 'node:path';
import ts from 'typescript';

export interface PurityContext {
  /** Source of an API-relative module, or null when it does not exist. */
  read(rel: string): string | null;
  /** The module is unchanged since the base commit. */
  trusted(rel: string): boolean;
}

/** Globals declarative code may name (Object/Array only through the members below). */
const GLOBALS = new Set(['undefined', 'NaN', 'Infinity', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Object', 'Array']);
const LIMITED_MEMBERS: Record<string, ReadonlySet<string>> = {
  Object: new Set(['keys', 'values', 'entries', 'fromEntries', 'hasOwn', 'freeze']),
  Array: new Set(['isArray', 'from', 'of']),
};
const FORBIDDEN_MEMBERS = new Set(['constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments']);

function badMember(name: string): boolean {
  return FORBIDDEN_MEMBERS.has(name) || name.startsWith('_');
}

function isZodSpecifier(spec: string): boolean {
  return spec === 'zod' || spec.startsWith('zod/');
}

/** API-relative target of a relative specifier (./x.js -> x.ts, ./x -> x.ts or x/index.ts), or null. */
function resolveRel(from: string, spec: string, ctx: PurityContext): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  if (joined.startsWith('../')) return null;
  const candidates = /\.[cm]?js$/.test(joined) ? [joined.replace(/\.([cm]?)js$/, '.$1ts')]
    : /\.[cm]?ts$/.test(joined) ? [joined] : [`${joined}.ts`, `${joined}/index.ts`];
  return candidates.find((c) => ctx.read(c) !== null) ?? null;
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Names declared anywhere inside `node` (parameters, variables, inner functions). */
function localNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) bindingNames(n.name, out);
    else if (ts.isFunctionDeclaration(n) && n.name !== undefined) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isEnumDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

function literalText(e: ts.Node): string | null {
  return ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) ? e.text : null;
}

const ASSIGNMENT = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Why `node` (a const initialiser or function) is not declarative, or null. `known` = module-level names. */
function impureCode(node: ts.Node, known: ReadonlySet<string>, sf: ts.SourceFile): string | null {
  const locals = localNames(node);
  let why: string | null = null;
  const fail = (n: ts.Node, msg: string): void => {
    if (why === null) why = `${msg} (line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1})`;
  };
  const visit = (n: ts.Node): void => {
    if (why !== null || ts.isTypeNode(n) || ts.isTypeParameterDeclaration(n)) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) return fail(n, '`this`/`super`');
    if (ts.isMetaProperty(n)) return fail(n, '`import.meta`/`new.target`');
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) return fail(n, 'dynamic import()');
    if (ts.isClassLike(n)) return fail(n, 'a class');
    if (ts.isDeleteExpression(n)) return fail(n, '`delete`');
    if (ts.isIdentifier(n) && isReference(n)) {
      const name = n.text;
      if (!locals.has(name) && !known.has(name) && !GLOBALS.has(name)) return fail(n, `reference to \`${name}\``);
      const limited = LIMITED_MEMBERS[name];
      if (limited !== undefined && !locals.has(name) && !known.has(name)) {
        const p = n.parent;
        if (!ts.isPropertyAccessExpression(p) || p.expression !== n || !limited.has(p.name.text)) return fail(n, `\`${name}\` other than ${[...limited].join('/')}`);
      }
    }
    if (ts.isPropertyAccessExpression(n) && badMember(n.name.text)) return fail(n, `member \`${n.name.text}\``);
    if (ts.isElementAccessExpression(n)) {
      const key = literalText(n.argumentExpression);
      if (key === null || badMember(key)) return fail(n, 'computed member access');
    }
    if (ts.isComputedPropertyName(n)) {
      const key = literalText(n.expression);
      if (key === null || badMember(key)) return fail(n, 'computed property name');
    }
    const target = ts.isBinaryExpression(n) && ASSIGNMENT.has(n.operatorToken.kind) ? n.left
      : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ? n.operand
        : undefined;
    if (target !== undefined && !(ts.isIdentifier(target) && locals.has(target.text))) return fail(n, 'assignment to something other than a local variable');
    ts.forEachChild(n, visit);
  };
  visit(node);
  return why;
}

type Verdict = string | null;

/** Why the module's own statements are not declarative (imports are checked by the caller), or null. */
function impureModule(rel: string, text: string): Verdict {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const known = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause !== undefined && !st.importClause.isTypeOnly) {
      const c = st.importClause;
      if (c.name !== undefined) known.add(c.name.text);
      if (c.namedBindings !== undefined) {
        if (ts.isNamespaceImport(c.namedBindings)) known.add(c.namedBindings.name.text);
        else for (const el of c.namedBindings.elements) known.add(el.name.text);
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) bindingNames(d.name, known);
    } else if ((ts.isFunctionDeclaration(st) || ts.isEnumDeclaration(st)) && st.name !== undefined) {
      known.add(st.name.text);
    }
  }
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (st.importClause === undefined) return `side-effect import (line ${line(st)})`;
      continue;
    }
    if (ts.isExportDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEmptyStatement(st)) continue;
    if (ts.isEnumDeclaration(st)) {
      if (st.members.some((m) => m.initializer !== undefined && literalText(m.initializer) === null)) return `enum with computed values (line ${line(st)})`;
      continue;
    }
    if (ts.isVariableStatement(st)) {
      if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) return `a non-const variable (line ${line(st)})`;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) return `a destructuring or uninitialised const (line ${line(d)})`;
        const why = impureCode(d.initializer, known, sf);
        if (why !== null) return why;
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st)) {
      const why = st.body === undefined ? null : impureCode(st, known, sf);
      if (why !== null) return why;
      continue;
    }
    if (ts.isExportAssignment(st)) {
      const why = impureCode(st.expression, known, sf);
      if (why !== null) return why;
      continue;
    }
    return `a statement with effects (line ${line(st)})`;
  }
  return null;
}

/** Runtime module specifiers of a file: import/export-from declarations that are not type-only. */
function runtimeImports(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause?.isTypeOnly !== true) out.push(n.moduleSpecifier.text);
    else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      out.push(a !== undefined && ts.isStringLiteralLike(a) ? a.text : '<computed>');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Why the contract runtime must not import `rel` (an API-relative module), or null when every
 * module in its relative import closure is trusted or declarative.
 */
export function notImportable(rel: string, ctx: PurityContext, memo: Map<string, Verdict> = new Map()): Verdict {
  const cached = memo.get(rel);
  if (cached !== undefined || memo.has(rel)) return cached ?? null;
  memo.set(rel, null); // cycles: judged by the rest of the cycle
  const text = ctx.read(rel);
  let verdict: Verdict = text === null ? `${rel} does not exist` : null;
  if (text !== null && !ctx.trusted(rel)) {
    const why = impureModule(rel, text);
    if (why !== null) verdict = `${rel} was changed and is not declarative: ${why}`;
  }
  if (verdict === null && text !== null) {
    for (const spec of runtimeImports(rel, text)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        if (!ctx.trusted(rel) && !isZodSpecifier(spec)) { verdict = `${rel} was changed and imports "${spec}" (only zod and declarative modules allowed)`; break; }
        continue;
      }
      const target = resolveRel(rel, spec, ctx);
      const sub = target === null ? `${rel} imports "${spec}", which cannot be resolved` : notImportable(target, ctx, memo);
      if (sub !== null) { verdict = sub; break; }
    }
  }
  memo.set(rel, verdict);
  return verdict;
}
