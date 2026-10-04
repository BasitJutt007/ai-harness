/**
 * Contract Lock compares schema source by tokens (to see .refine/.transform changes JSON Schema cannot show).
 * Reformatting a schema (line breaks, comments, trailing commas) must not count as a change; a real edit must.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { tokenText } from '../../plugins/lib/contract.ts';

function exprOf(code: string): ts.Node {
  const sf = ts.createSourceFile('s.ts', `const S = ${code};`, ts.ScriptTarget.Latest, true);
  const stmt = sf.statements[0];
  if (stmt === undefined || !ts.isVariableStatement(stmt)) throw new Error('no statement');
  const init = stmt.declarationList.declarations[0]?.initializer;
  if (init === undefined) throw new Error('no initializer');
  return init;
}

const BASE = `z.strictObject({
  name: z.string().min(1).max(100),
  status: Status.default('active'),
})`;

describe('tokenText', () => {
  it.each([
    ['one line, no trailing comma', "z.strictObject({ name: z.string().min(1).max(100), status: Status.default('active') })"],
    ['comments and blank lines', "z.strictObject({\n  // the name\n  name: z.string().min(1).max(100),\n\n  status: Status.default('active'), /* default */\n})"],
    ['trailing comma in a call', "z.strictObject({ name: z.string().min(1,).max(100), status: Status.default('active',), },)"],
  ])('ignores formatting: %s', (_label, code) => {
    expect(tokenText(exprOf(code))).toBe(tokenText(exprOf(BASE)));
  });

  it.each([
    ['a refine', "z.strictObject({ name: z.string().min(1).max(100).refine((s) => s !== 'x'), status: Status.default('active') })"],
    ['a changed bound', "z.strictObject({ name: z.string().min(2).max(100), status: Status.default('active') })"],
    ['a removed comma between members', "z.strictObject({ name: z.string().min(1).max(100) status: Status.default('active') })"],
  ])('sees a real change: %s', (_label, code) => {
    expect(tokenText(exprOf(code))).not.toBe(tokenText(exprOf(BASE)));
  });
});
