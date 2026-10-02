/**
 * Syntactic unsafe-code detection for proposed TypeScript content: the `any`
 * keyword, non-null assertions (`x!`), definite-assignment assertions
 * (`id!: string` on a property, `let x!: T`; reported as non-null too, since they
 * assert away the same undefined) and ts-ignore family comments. Purely
 * syntactic (ts.createSourceFile + scanner), so it works on files that do not
 * type-check yet. `!=`, `!==` and logical `!x` are different tokens/nodes and
 * never match.
 */
import ts from 'typescript';

export interface SafetyViolation {
  kind: 'any' | 'non-null' | 'ts-directive';
  line: number;
  col: number;
  message: string;
}

/** A directive is honoured when it starts a comment line (after slashes, stars and spaces). */
const DIRECTIVE = /^[\s/*]*(@ts-(ignore|expect-error|nocheck))\b/;

function pos(sf: ts.SourceFile, at: number): { line: number; col: number } {
  const lc = sf.getLineAndCharacterOfPosition(at);
  return { line: lc.line + 1, col: lc.character + 1 };
}

export function findUnsafeCode(fileName: string, content: string): SafetyViolation[] {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: SafetyViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      out.push({ kind: 'any', ...pos(sf, node.getStart(sf)), message: '`any` type: use unknown and narrow, or a precise type' });
    } else if (ts.isNonNullExpression(node)) {
      out.push({
        kind: 'non-null',
        ...pos(sf, node.getEnd() - 1),
        message: `non-null assertion \`${node.getText(sf).slice(0, 40)}\`: check for null/undefined explicitly`,
      });
    } else if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.exclamationToken !== undefined) {
      out.push({
        kind: 'non-null',
        ...pos(sf, node.exclamationToken.getStart(sf)),
        message: `definite-assignment assertion \`${node.name.getText(sf).slice(0, 40)}!\`: initialise it, or type it \`T | undefined\` and check`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Comments: every comment is trivia in front of some token, so walking all
  // tokens (getChildren includes punctuation and EOF) finds each one exactly once
  // per start position, and string/template contents never match.
  const seen = new Set<number>();
  const checkComments = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      let offset = r.pos;
      for (const lineText of content.slice(r.pos, r.end).split('\n')) {
        const m = DIRECTIVE.exec(lineText);
        const directive = m?.[1];
        if (m && directive) {
          out.push({
            kind: 'ts-directive',
            ...pos(sf, offset + m[0].length - directive.length),
            message: `${directive} comment: fix the type error instead of suppressing it`,
          });
        }
        offset += lineText.length + 1;
      }
    }
  };
  const walkTokens = (node: ts.Node): void => {
    // JSDoc nodes live inside comment text; the comment itself is trivia of the next real token.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      checkComments(ts.getLeadingCommentRanges(content, node.pos));
      checkComments(ts.getTrailingCommentRanges(content, node.pos));
      return;
    }
    children.forEach(walkTokens);
  };
  walkTokens(sf);
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

export function formatViolations(path: string, violations: SafetyViolation[]): string[] {
  return violations.map((v) => `${path}:${v.line}:${v.col}  ${v.message}`);
}

/**
 * Violations present in `after` that were not already in `before` (matched by
 * kind + trimmed line text, as a multiset), so legacy code can still be edited
 * as long as the edit does not introduce new unsafe constructs.
 */
export function newUnsafeCode(fileName: string, before: string | null, after: string): SafetyViolation[] {
  const found = findUnsafeCode(fileName, after);
  if (before === null) return found;
  const key = (text: string, v: SafetyViolation): string => `${v.kind}|${(text.split('\n')[v.line - 1] ?? '').trim()}`;
  const existing = new Map<string, number>();
  for (const v of findUnsafeCode(fileName, before)) {
    const k = key(before, v);
    existing.set(k, (existing.get(k) ?? 0) + 1);
  }
  return found.filter((v) => {
    const k = key(after, v);
    const n = existing.get(k) ?? 0;
    if (n > 0) {
      existing.set(k, n - 1);
      return false;
    }
    return true;
  });
}
