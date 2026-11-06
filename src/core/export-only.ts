/**
 * Export-only edits: the way out of the observed-red deadlock of a module-private function.
 *
 * A test that imports a function its module declares but does not export cannot load (ESM: "The requested
 * module 'M' does not provide an export named 'X'"), and a load failure is no red for a file that existed at
 * run start. The only edit that lets such a test load is adding `export`: a source edit the observed-red lock
 * refuses. An EXPORT-ONLY edit breaks that deadlock: it only makes existing top-level declarations importable,
 * so none of the file's own code changes. It is NOT behaviour-neutral in general: a new export changes what
 * code that reads the module AS A WHOLE does (a registry built from `import * as`, `Object.keys` of a
 * namespace, a barrel's `export *` that now meets the same name twice, a framework that reads a route
 * module's exports by name such as `loader`), and a check of one file cannot see that code. So the edit
 * unlocks nothing and proves nothing: the observed-red gate never counts a file that only gained exports as
 * proven (it is UNPROVEN by name), and a file that also changed behaviour is proven by its own revert check.
 *
 * exportOnlyEdit(file, before, after) decides it on the TypeScript AST (the parser mode of the file's
 * extension): after removing exactly the `export` modifiers added to existing top-level function, class,
 * const/let/var, enum, interface and type declarations, and the added local `export { a, b as c }` statements
 * (no `from`), the two files must have the same syntax tree token for token: every token's kind and text, how
 * the tokens nest, and every COMMENT, in order and before the same token (a comment before a removed `export`
 * counts as before the token that follows it). Comments are compared because builds obey some of them: a JSX
 * pragma (`@jsx`, `@jsxRuntime`, `@jsxImportSource`, `@jsxFrag`) changes what every JSX element in the file
 * calls, and `/*#__PURE__*\/` or `@__NO_SIDE_EFFECTS__` lets a bundler drop a call. JSX text is compared whole,
 * leading whitespace included (it is rendered). Only whitespace between tokens is ignored; a newline that changes
 * automatic semicolon insertion changes the tree, so it is refused. Refused as well:
 *   - any other change, a new declaration, an export removed or renamed;
 *   - `export default` in any form (a declaration modifier or `export { a as default }`): a default export
 *     changes how bundlers, frameworks and CommonJS interop consume the module, and a named export is enough
 *     to test a function;
 *   - the names `then` (a module namespace with a `then` export is a thenable: `await import()` resolves to
 *     something else) and `__esModule` (CommonJS interop reads it to decide what the default export is);
 *   - any export in a module that has an `export * from`: a new local export hides the re-exported name of the
 *     same name from every importer;
 *   - re-exports (`export * from`, `export { x } from`): they load another module, with its side effects;
 *     `export =`; exporting an imported binding (a re-export too) or an ambient (`declare`) one, which has no
 *     runtime value; a name the module already exports, or one this edit exports twice;
 *   - a file that does not parse, a kind that is not a TypeScript or JavaScript module (a .d.ts, a .vue file),
 *     a file whose tokens do not account for every character of it, and a file that was not an ES module before
 *     (its first export would turn a script into a module and change how its top-level names are scoped).
 *
 * withExports(file, runStart, current) is the observed-red revert check's base for a file that existed at run
 * start: its run-start content plus the exports the current content makes of declarations that existed at run
 * start, appended as `export { … }` (and `export type { … }` for interfaces, type aliases and every export the
 * current content makes type-only) statements and verified export-only against the run-start content. The
 * reverted copy then still loads a test that imports such a declaration, so the case must fail there on what
 * the run-start code DOES, not because an import is missing.
 */
import ts from 'typescript';
import { scriptKindOf } from './testmap.ts';

/** The verdict of exportOnlyEdit: the names the edit exports (sorted), or why it is not export-only. */
export type ExportOnlyVerdict =
  | { ok: true; names: string[] }
  | {
    ok: false;
    why: string;
    /** The edit adds an `export` somewhere (an attempt at an export-only edit), for a precise refusal. */
    addsExports: boolean;
  };

const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const DECLARATION_FILE = /\.d\.[cm]?tsx?$/i;

type Declaration = ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement | ts.EnumDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function isDeclaration(s: ts.Node): s is Declaration {
  return ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isVariableStatement(s) || ts.isEnumDeclaration(s)
    || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s);
}

function modifier(s: ts.Node, kind: ts.SyntaxKind): ts.Node | undefined {
  return ts.canHaveModifiers(s) ? s.modifiers?.find((m) => m.kind === kind) : undefined;
}

function bindingNames(n: ts.BindingName): string[] {
  if (ts.isIdentifier(n)) return [n.text];
  return n.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

/** The names a top-level declaration declares (a function or class without a name declares none). */
function declaredNames(s: Declaration): string[] {
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  return s.name === undefined ? [] : [s.name.text];
}

/** A local `export { … }` statement: named exports of this module's own bindings, no `from`. */
function isLocalExportStatement(s: ts.Node): s is ts.ExportDeclaration & { exportClause: ts.NamedExports } {
  return ts.isExportDeclaration(s) && s.moduleSpecifier === undefined && s.exportClause !== undefined && ts.isNamedExports(s.exportClause);
}

interface TopLevel {
  /** Every declaration of the name is an interface or a type alias (no runtime value). */
  typeOnly: boolean;
  /** Some declaration of the name is ambient (`declare`): it has no runtime value of its own. */
  ambient: boolean;
}

/** The module's top-level declarations of the kinds an export-only edit may export, by name. */
function topLevelDeclarations(sf: ts.SourceFile): Map<string, TopLevel> {
  const out = new Map<string, TopLevel>();
  for (const s of sf.statements) {
    if (!isDeclaration(s)) continue;
    const typeOnly = ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s);
    const ambient = modifier(s, ts.SyntaxKind.DeclareKeyword) !== undefined;
    for (const name of declaredNames(s)) {
      const prev = out.get(name);
      out.set(name, { typeOnly: (prev?.typeOnly ?? true) && typeOnly, ambient: (prev?.ambient ?? false) || ambient });
    }
  }
  return out;
}

function exportName(n: ts.ModuleExportName): string {
  return n.text;
}

/** Every name the module exports ('default' for a default export, '=' for `export =`); `export *` adds none. */
function exportNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isExportAssignment(s)) out.add(s.isExportEquals === true ? '=' : 'default');
    else if (ts.isExportDeclaration(s)) {
      const clause = s.exportClause;
      if (clause === undefined) continue;
      if (ts.isNamespaceExport(clause)) out.add(exportName(clause.name));
      else for (const e of clause.elements) out.add(exportName(e.name));
    } else if (modifier(s, ts.SyntaxKind.ExportKeyword) !== undefined) {
      if (modifier(s, ts.SyntaxKind.DefaultKeyword) !== undefined) out.add('default');
      else if (isDeclaration(s)) for (const n of declaredNames(s)) out.add(n);
      else if ((ts.isModuleDeclaration(s) || ts.isImportEqualsDeclaration(s)) && ts.isIdentifier(s.name)) out.add(s.name.text);
    }
  }
  return out;
}

/** A module's own exports: exported declarations and local `export { … }`, and whether the export is type-only. */
function localExports(sf: ts.SourceFile): Array<{ local: string; exported: string; typeOnly: boolean }> {
  const out: Array<{ local: string; exported: string; typeOnly: boolean }> = [];
  for (const s of sf.statements) {
    if (isDeclaration(s) && modifier(s, ts.SyntaxKind.ExportKeyword) !== undefined && modifier(s, ts.SyntaxKind.DefaultKeyword) === undefined) {
      for (const n of declaredNames(s)) out.push({ local: n, exported: n, typeOnly: false });
    } else if (isLocalExportStatement(s)) {
      for (const e of s.exportClause.elements) {
        const local = e.propertyName ?? e.name;
        // `export type { f }` and `export { type f }` export no runtime value, whatever `f` is.
        if (ts.isIdentifier(local) && ts.isIdentifier(e.name)) out.push({ local: local.text, exported: e.name.text, typeOnly: s.isTypeOnly || e.isTypeOnly });
      }
    }
  }
  return out;
}

/** The file parsed in its extension's parser mode, or why it cannot be judged. */
function parse(fileName: string, text: string): ts.SourceFile | string {
  if (!MODULE_FILE.test(fileName) || DECLARATION_FILE.test(fileName)) return `${fileName} is not a TypeScript or JavaScript module`;
  const sf = ts.createSourceFile(fileName, text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, true, scriptKindOf(fileName));
  // The parser's own syntax errors (internal but stable; their absence is never assumed: fail closed).
  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) return 'its syntax cannot be checked';
  const first = diagnostics[0] as ts.Diagnostic | undefined;
  if (first !== undefined) {
    return `it does not parse (line ${lineOf(sf, first.start ?? 0)}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')})`;
  }
  // Every character must belong to exactly one token's span (its leading trivia and its text): then the tree walk
  // below sees every token and every comment, and nothing in the file can hide between them.
  if (!tiles(sf)) return "its tokens do not account for every character of it, so it cannot be compared token for token";
  return sf;
}

/** The leaf tokens of `sf` (and its empty lists) cover the text end to end, each starting where the last one ended. */
function tiles(sf: ts.SourceFile): boolean {
  let at = 0;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok || isJsDoc(n)) return;
    const kids = n.getChildren(sf).filter((k) => !isJsDoc(k));
    if (kids.length > 0) {
      for (const k of kids) visit(k);
      return;
    }
    if (n.pos !== at || n.end < n.pos) ok = false;
    at = n.end;
  };
  visit(sf);
  return ok && at === sf.text.length;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isJsDoc(n: ts.Node): boolean {
  return n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
}

function isJsxText(n: ts.Node): boolean {
  return n.kind === ts.SyntaxKind.JsxText || n.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
}

/** One scanner for the trivia between tokens (never skipping it). */
const triviaScanner = ts.createScanner(ts.ScriptTarget.Latest, false);

/**
 * The comments in text[from, to) (a token's leading trivia), in order, as `#<comment>` with CRLF read as LF (a
 * shebang counts as one). Whitespace and newlines are dropped; anything else found there is kept as
 * `?<kind>:<text>`, so nothing between two tokens is ever silently ignored.
 */
function commentsIn(text: string, from: number, to: number): string[] {
  if (to <= from) return [];
  triviaScanner.setText(text, from, to - from);
  const out: string[] = [];
  for (let k = triviaScanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = triviaScanner.scan()) {
    if (k === ts.SyntaxKind.WhitespaceTrivia || k === ts.SyntaxKind.NewLineTrivia) continue;
    const t = triviaScanner.getTokenText().replace(/\r\n/g, '\n');
    const comment = k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia || k === ts.SyntaxKind.ShebangTrivia;
    out.push(comment ? `#${t}` : `?${k}:${t}`);
  }
  triviaScanner.setText(undefined);
  return out;
}

interface Walk {
  out: string[];
  /** Comments of left-out nodes, owed to the next token that is kept. */
  pending: string[];
  comments: boolean;
}

/** The comments of a node left out of the walk: they belong to the next kept token (see treeOf). */
function carry(node: ts.Node, sf: ts.SourceFile, w: Walk): void {
  if (!w.comments || isJsDoc(node)) return;
  const kids = node.getChildren(sf).filter((k) => !isJsDoc(k));
  if (kids.length > 0) {
    for (const k of kids) carry(k, sf, w);
    return;
  }
  // A left-out node is an `export` keyword or a whole `export { … }` statement: never JSX text. Were it, its
  // text is kept as an unknown so that it can only make the comparison fail.
  if (isJsxText(node)) w.pending.push(`?jsx:${sf.text.slice(node.pos, node.end)}`);
  else w.pending.push(...commentsIn(sf.text, node.pos, node.kind === ts.SyntaxKind.SyntaxList ? node.end : node.getStart(sf)));
}

function walk(node: ts.Node, sf: ts.SourceFile, skip: ReadonlySet<ts.Node>, w: Walk): void {
  if (isJsDoc(node)) return;
  if (skip.has(node)) {
    carry(node, sf, w);
    return;
  }
  const kids = node.getChildren(sf).filter((k) => !isJsDoc(k));
  if (node.kind === ts.SyntaxKind.SyntaxList) {
    if (kids.length > 0 && kids.every((k) => skip.has(k))) {
      for (const k of kids) carry(k, sf, w);
      return;
    }
    if (kids.length === 0) carry(node, sf, w);
    w.out.push('[');
    for (const k of kids) walk(k, sf, skip, w);
    w.out.push(']');
    return;
  }
  if (kids.length === 0) {
    // JSX text is rendered as written: its whole span is its text (getText would drop its leading whitespace,
    // and a `//` in it is text, not a comment). Every other token: the comments before it, then its text.
    if (isJsxText(node)) {
      w.out.push(...w.pending, `${node.kind}:${sf.text.slice(node.pos, node.end)}`);
    } else {
      w.out.push(...w.pending, ...(w.comments ? commentsIn(sf.text, node.pos, node.getStart(sf)) : []), `${node.kind}:${node.getText(sf)}`);
    }
    w.pending = [];
    return;
  }
  w.out.push(`(${node.kind}`);
  for (const k of kids) walk(k, sf, skip, w);
  w.out.push(')');
}

/**
 * The syntax tree under `node` as a flat list: `(kind … )` around each node's children, `[ … ]` around each
 * list, and for each token the comments before it (`#…`, unless `comments` is false) and `kind:text`. Nodes in
 * `skip` are left out, their comments passed on to the next token kept; a list emptied by that is left out as
 * a whole, exactly as if it had never had members (a declaration whose only modifier was the skipped `export`
 * has no modifier list).
 */
function treeOf(node: ts.Node, sf: ts.SourceFile, skip: ReadonlySet<ts.Node>, comments = true): string[] {
  const w: Walk = { out: [], pending: [], comments };
  walk(node, sf, skip, w);
  return [...w.out, ...w.pending];
}

function sameTree(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Export names that change how code reading the module as a whole treats it, whatever the binding is. */
const RESERVED_EXPORTS: ReadonlyMap<string, string> = new Map([
  ['then', 'a module namespace with a `then` export is a thenable, so `await import()` of the module resolves to whatever `then` passes on instead of the module'],
  ['__esModule', 'CommonJS interop (a bundler, tsx, jest) reads `__esModule` to decide what a default import of the module is'],
]);

/** Why two trees that differ only in their comments are not export-only: the first comment that differs. */
function commentChange(before: string[], after: string[]): string {
  const cb = before.filter((t) => t.startsWith('#') || t.startsWith('?'));
  const ca = after.filter((t) => t.startsWith('#') || t.startsWith('?'));
  let i = 0;
  while (i < cb.length && i < ca.length && cb[i] === ca[i]) i += 1;
  const shown = (t: string): string => {
    const one = t.slice(1).replace(/\s+/g, ' ');
    return one.length > 60 ? `${one.slice(0, 59)}…` : one;
  };
  const what = ca[i] !== undefined && !cb.includes(ca[i] ?? '') ? `adds the comment \`${shown(ca[i] ?? '')}\``
    : cb[i] !== undefined && !ca.includes(cb[i] ?? '') ? `removes the comment \`${shown(cb[i] ?? '')}\``
      : `moves the comment \`${shown(ca[i] ?? cb[i] ?? '')}\``;
  return `${what}: builds obey some comments (a JSX pragma such as @jsx, /*#__PURE__*/), so an export-only edit keeps every comment as it is, before the same token`;
}

const NONE: ReadonlySet<ts.Node> = new Set();

/** How many top-level statements re-export from another module (`export * from`, `export { x } from`). */
function reExports(sf: ts.SourceFile): number {
  return sf.statements.filter((s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined).length;
}

/** `after` exports a name `before` does not, or re-exports more: the edit tries to add an export. */
function addsAnExport(before: ts.SourceFile, after: ts.SourceFile): boolean {
  const had = exportNames(before);
  return [...exportNames(after)].some((n) => !had.has(n)) || reExports(after) > reExports(before);
}

function firstLineOf(s: ts.Node, sf: ts.SourceFile): string {
  const line = s.getText(sf).split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Why a statement of `after` with no export-only counterpart in `before` is not an export-only change. */
function unmatched(s: ts.Statement, after: ts.SourceFile, declared: ReadonlyMap<string, TopLevel>, o: ts.Statement | undefined, before: ts.SourceFile): string {
  const at = `line ${lineOf(after, s.getStart(after))} (\`${firstLineOf(s, after)}\`)`;
  if (o !== undefined) {
    // The same tokens as its counterpart (once an added `export` is left out), so only its comments differ.
    const kw = modifier(s, ts.SyntaxKind.ExportKeyword);
    const without = kw !== undefined && modifier(o, ts.SyntaxKind.ExportKeyword) === undefined ? new Set([kw]) : NONE;
    if (sameTree(treeOf(o, before, NONE, false), treeOf(s, after, without, false))) return `${at} ${commentChange(treeOf(o, before, NONE), treeOf(s, after, without))}`;
  }
  if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined) return `${at} re-exports from another module: that loads it, with its side effects`;
  if (ts.isExportAssignment(s)) return `${at} adds ${s.isExportEquals === true ? '`export =`' : 'a default export'}`;
  if (modifier(s, ts.SyntaxKind.DefaultKeyword) !== undefined) return `${at} adds a default export`;
  if (isDeclaration(s) && declaredNames(s).some((n) => !declared.has(n))) return `${at} adds a new declaration`;
  if (ts.isModuleDeclaration(s) || ts.isImportEqualsDeclaration(s)) return `${at} is not a function, class, variable, enum, interface or type declaration`;
  return `${at} changes more than adding \`export\``;
}

/**
 * Whether `after` differs from `before` only by exporting existing top-level declarations (see the module
 * comment for the exact rule and everything it refuses).
 */
export function exportOnlyEdit(fileName: string, before: string, after: string): ExportOnlyVerdict {
  const b = parse(fileName, before);
  const a = parse(fileName, after);
  const addsExports = typeof a !== 'string' && (typeof b === 'string' || addsAnExport(b, a));
  const no = (why: string): ExportOnlyVerdict => ({ ok: false, why, addsExports });
  if (typeof b === 'string') return no(`the current content: ${b}`);
  if (typeof a === 'string') return no(`the new content: ${a}`);
  if (!ts.isExternalModule(b)) return no('the file is not an ES module yet (no import or export): a first export would change how its top-level names are scoped');
  const star = b.statements.find((s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && s.exportClause === undefined);
  if (star !== undefined) {
    return no(`line ${lineOf(b, star.getStart(b))} (\`${firstLineOf(star, b)}\`) re-exports every name of another module: a new export of a name it shares would hide the re-exported one from every importer`);
  }
  const declared = topLevelDeclarations(b);
  const skip = new Set<ts.Node>();
  const addedDeclarations: Declaration[] = [];
  const addedStatements: Array<ts.ExportDeclaration & { exportClause: ts.NamedExports }> = [];
  // Statement by statement: equal, an added local `export { … }`, or equal once its added `export` modifier is removed.
  let i = 0;
  for (const s of a.statements) {
    const o = b.statements[i];
    const was = o === undefined ? null : treeOf(o, b, NONE);
    if (was !== null && sameTree(was, treeOf(s, a, NONE))) {
      i += 1;
      continue;
    }
    if (isLocalExportStatement(s)) {
      skip.add(s);
      addedStatements.push(s);
      continue;
    }
    const kw = modifier(s, ts.SyntaxKind.ExportKeyword);
    if (kw !== undefined && was !== null && o !== undefined && modifier(o, ts.SyntaxKind.ExportKeyword) === undefined && sameTree(was, treeOf(s, a, new Set([kw])))) {
      if (!isDeclaration(s)) return no(unmatched(s, a, declared, undefined, b));
      if (modifier(s, ts.SyntaxKind.DefaultKeyword) !== undefined) return no(unmatched(s, a, declared, undefined, b));
      skip.add(kw);
      addedDeclarations.push(s);
      i += 1;
      continue;
    }
    return no(unmatched(s, a, declared, o, b));
  }
  const left = b.statements[i];
  if (left !== undefined) return no(`it removes or changes line ${lineOf(b, left.getStart(b))} of the current content (\`${firstLineOf(left, b)}\`)`);
  // The source of truth: the whole trees, with exactly the added exports removed, are identical.
  const whole = treeOf(b, b, NONE);
  const exportsLeftOut = treeOf(a, a, skip);
  if (!sameTree(whole, exportsLeftOut)) {
    return no(sameTree(treeOf(b, b, NONE, false), treeOf(a, a, skip, false)) ? `it ${commentChange(whole, exportsLeftOut)}` : 'the files differ outside their top-level statements');
  }
  const already = exportNames(b);
  const names: string[] = [];
  for (const d of addedDeclarations) {
    const at = `line ${lineOf(a, d.getStart(a))}`;
    if (modifier(d, ts.SyntaxKind.DeclareKeyword) !== undefined) return no(`${at} exports an ambient (declare) declaration, which has no runtime value`);
    const declaredHere = declaredNames(d);
    if (declaredHere.length === 0) return no(`${at} exports a declaration without a name`);
    for (const n of declaredHere) {
      if (already.has(n)) return no(`${at} exports ${n}, which the module already exports`);
      if (!names.includes(n)) names.push(n);
    }
  }
  const viaStatements = new Set<string>();
  for (const s of addedStatements) {
    const at = `line ${lineOf(a, s.getStart(a))}`;
    for (const e of s.exportClause.elements) {
      const local = e.propertyName ?? e.name;
      if (!ts.isIdentifier(local) || !ts.isIdentifier(e.name)) return no(`${at} exports a string-named binding`);
      const exported = e.name.text;
      if (exported === 'default') return no(`${at} adds a default export`);
      const d = declared.get(local.text);
      if (d === undefined) return no(`${at} exports ${local.text}, which is not a top-level function, class, variable, enum, interface or type declaration of this module (an imported binding would be a re-export)`);
      if (d.ambient) return no(`${at} exports ${local.text}, an ambient (declare) declaration with no runtime value`);
      if (already.has(exported)) return no(`${at} exports ${exported}, which the module already exports`);
      if (names.includes(exported) || viaStatements.has(exported)) return no(`${at} exports ${exported} twice`);
      viaStatements.add(exported);
    }
  }
  const all = [...names, ...viaStatements].sort();
  if (all.length === 0) return no('it exports nothing new');
  const reserved = all.find((n) => RESERVED_EXPORTS.has(n));
  if (reserved !== undefined) return no(`it exports ${reserved}: ${RESERVED_EXPORTS.get(reserved) ?? ''}`);
  return { ok: true, names: all };
}

/**
 * The run-start content of `fileName` with the exports `current` makes of its run-start declarations added
 * (one appended `export { … }` statement, and `export type { … }` for interfaces, type aliases and what `current`
 * exports type-only: `export type { f }` keeps `f` a type-only export in the base too), verified
 * export-only against `runStart`; null when `current` exports no such declaration, or either content cannot
 * be judged (the caller then keeps the bare run-start content).
 */
export function withExports(fileName: string, runStart: string, current: string): { content: string; names: string[] } | null {
  const s = parse(fileName, runStart);
  const c = parse(fileName, current);
  if (typeof s === 'string' || typeof c === 'string' || !ts.isExternalModule(s)) return null;
  const declared = topLevelDeclarations(s);
  const already = exportNames(s);
  const values: string[] = [];
  const types: string[] = [];
  const seen = new Set<string>();
  for (const { local, exported, typeOnly } of localExports(c)) {
    if (exported === 'default' || already.has(exported) || seen.has(exported)) continue;
    const d = declared.get(local);
    if (d === undefined || d.ambient) continue;
    seen.add(exported);
    (d.typeOnly || typeOnly ? types : values).push(local === exported ? local : `${local} as ${exported}`);
  }
  if (seen.size === 0) return null;
  const added = [
    ...(values.length > 0 ? [`export { ${values.join(', ')} };`] : []),
    ...(types.length > 0 ? [`export type { ${types.join(', ')} };`] : []),
  ];
  const content = `${runStart}${runStart.endsWith('\n') || runStart === '' ? '' : '\n'}${added.join('\n')}\n`;
  const v = exportOnlyEdit(fileName, runStart, content);
  return v.ok ? { content, names: v.names } : null;
}

/**
 * The missing named export a suite failed to load on (Node's ESM linker: "The requested module 'M' does not
 * provide an export named 'X'"): the specifier as written and the name, else null. Only that exact message
 * counts: a CommonJS "x is not a function" has many causes and is never read as a missing export.
 */
export function missingNamedExport(message: string): { module: string; name: string; line: string } | null {
  const m = /The requested module '([^']+)' does not provide an export named '([^']+)'/.exec(message);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const line = /^.*does not provide an export named '[^']+'.*$/m.exec(message)?.[0]?.trim() ?? m[0];
  return { module: m[1], name: m[2], line };
}

/** `name` is a top-level declaration of `text` (a module of `fileName`'s kind) that the module does not export. */
export function declaresUnexported(fileName: string, text: string, name: string): boolean {
  const sf = parse(fileName, text);
  if (typeof sf === 'string') return false;
  const d = topLevelDeclarations(sf).get(name);
  return d !== undefined && !d.ambient && !exportNames(sf).has(name);
}
