/**
 * The scaffold, the sample and the scripted reference files are clean under the
 * lint rules a grader is likely to drop into plugins/ (no-console, no TODO/FIXME,
 * no process.exit / eval / new Function / debugger, explicit return types on
 * exports, no default exports in src/, no unused locals or parameters). The agent
 * cannot edit the read-only scaffold (src/lib/**, src/server.ts), so a violation
 * there would make every greenfield run unfinishable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROOT, run, walk } from './helpers.ts';

const TEMPLATE = join(ROOT, 'templates', 'express-zod');
const SAMPLE = join(ROOT, 'samples', 'existing-api');
const SCRIPTED = join(ROOT, 'fixtures', 'scripted');

/** Directories of complete .ts files (src/ + test/); the cheat script is deliberately dirty and is not here. */
const DIRS: Array<[string, string]> = [
  ['templates/express-zod', TEMPLATE],
  ['samples/existing-api', SAMPLE],
  ['fixtures/scripted/users-api', join(SCRIPTED, 'users-api')],
  ['fixtures/scripted/projects-change', join(SCRIPTED, 'projects-change')],
  ['fixtures/scripted/projects-breaking', join(SCRIPTED, 'projects-breaking')],
];

const MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isFunctionLike(node: ts.Expression | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** Lint findings for one file, as `line: message`. `src` toggles the rules that only apply to API source. */
function lintFindings(fileName: string, text: string, src: boolean): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const report = (node: ts.Node, message: string): void => {
    out.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${message}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const target = `${node.expression.text}.${node.name.text}`;
      if (node.expression.text === 'console') report(node, `no-console: ${target}`);
      if (target === 'process.exit') report(node, 'no-process-exit');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') report(node, 'no-eval');
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') report(node, 'no-new-func');
    if (node.kind === ts.SyntaxKind.DebuggerStatement) report(node, 'no-debugger');
    ts.forEachChild(node, visit);
  };
  visit(sf);

  text.split('\n').forEach((line, i) => {
    if (MARKER.test(line)) out.push(`${i + 1}: no-warning-comments`);
  });

  if (!src) return out;
  for (const stmt of sf.statements) {
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    if (ts.isExportAssignment(stmt) || hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) report(stmt, 'no-default-export');
    if (!exported) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.type === undefined) report(stmt, `explicit-return-type: ${stmt.name?.text ?? '(anonymous)'}`);
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.type === undefined && isFunctionLike(decl.initializer) && decl.initializer.type === undefined) {
          report(decl, `explicit-return-type: ${decl.name.getText(sf)}`);
        }
      }
    }
    if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        const hidden = hasModifier(member, ts.SyntaxKind.PrivateKeyword) || (member.name !== undefined && ts.isPrivateIdentifier(member.name));
        if (ts.isMethodDeclaration(member) && member.type === undefined && !hidden) report(member, `explicit-return-type: ${member.name.getText(sf)}`);
      }
    }
  }
  return out;
}

describe('lintFindings (the rules themselves)', () => {
  it('reports each rule on a dirty file', () => {
    const dirty = [
      "console.log('x');",
      '// TODO: later',
      'process.exit(1);',
      "eval('1');",
      "const f = new Function('return 1');",
      'debugger;',
      'export function noType() { return 1; }',
      'export const arrow = () => 1;',
      'export class K { run() { return 1; } private hidden() { return 2; } }',
      'export default f;',
    ].join('\n');
    expect(lintFindings('d.ts', dirty, true)).toEqual([
      '1: no-console: console.log',
      '3: no-process-exit',
      '4: no-eval',
      '5: no-new-func',
      '6: no-debugger',
      '2: no-warning-comments',
      '7: explicit-return-type: noType',
      '8: explicit-return-type: arrow',
      '9: explicit-return-type: run',
      '10: no-default-export',
    ]);
  });

  it('accepts the clean equivalents', () => {
    const clean = [
      "process.stdout.write('x\\n');",
      'export function typed(): number { return 1; }',
      'export const arrow = (): number => 1;',
      'export const handler: () => number = () => 1;',
      'export class K { run(): number { return this.helper(); } private helper() { return 2; } }',
      'const local = () => 1;',
      'export { local };',
    ].join('\n');
    expect(lintFindings('c.ts', clean, true)).toEqual([]);
  });
});

describe.each(DIRS)('%s is lint-clean', (_label, dir) => {
  it('no console / TODO / process.exit / eval / new Function / debugger; typed exports and no default exports in src/', () => {
    for (const file of walk(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      // vitest.config.ts must default-export its config; src/ is held to the full rule set.
      expect(lintFindings(file, text, file.startsWith('src/')), file).toEqual([]);
    }
  });
});

const EditSchema = z.object({ find: z.string(), replace: z.string() });
const ScriptSchema = z.object({
  turns: z.array(z.object({ calls: z.array(z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) })) })),
});

describe.each(['users-api.json', 'projects-change.json', 'projects-breaking.json'])('fixtures/scripted/%s inline edits', (file) => {
  it('introduce no console / TODO / process.exit / eval', () => {
    const script = ScriptSchema.parse(JSON.parse(readFileSync(join(SCRIPTED, file), 'utf8')));
    for (const call of script.turns.flatMap((t) => t.calls)) {
      const edit = EditSchema.safeParse(call.input);
      if (call.name !== 'edit_file' || !edit.success) continue;
      expect(lintFindings('edit.ts', edit.data.replace, false), edit.data.replace).toEqual([]);
    }
  });
});

describe.each([
  ['templates/express-zod', TEMPLATE],
  ['samples/existing-api', SAMPLE],
])('%s has no unused locals or parameters', (label, dir) => {
  it('tsc --noUnusedLocals --noUnusedParameters is clean (bar the template placeholder the agent rewrites)', () => {
    const res = run('tsc', ['--noEmit', '-p', join(dir, 'tsconfig.json'), '--noUnusedLocals', '--noUnusedParameters', '--pretty', 'false'], dir);
    const diags = res.output
      .split('\n')
      .filter((l) => /error TS\d+/.test(l))
      // src/routes/index.ts is the agent's to edit (not path-guarded): mounting the first router uses `app`.
      .filter((l) => !(label === 'templates/express-zod' && l.startsWith('src/routes/index.ts(') && l.includes("'app'")));
    expect(diags, res.output).toEqual([]);
  });
});
