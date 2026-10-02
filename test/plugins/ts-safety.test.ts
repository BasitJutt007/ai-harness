import { describe, expect, it } from 'vitest';
import { findUnsafeCode, newUnsafeCode } from '../../plugins/lib/ts-safety.ts';

const at = (src: string): string[] => findUnsafeCode('x.ts', src).map((v) => `${v.kind}@${v.line}:${v.col}`);

describe('ts-safety: definite-assignment assertions', () => {
  it('flags `let x!: T` and `var`/`let` lists as non-null at the `!`', () => {
    expect(at('let x!: number;')).toEqual(['non-null@1:6']);
    expect(at('let a = 1, b!: string;')).toEqual(['non-null@1:13']);
    expect(at('var legacy!: string;')).toEqual(['non-null@1:11']);
  });

  it('flags class properties `id!: string`, including modifiers and private names', () => {
    const src = ['class User {', '  id!: string;', '  private readonly name!: string;', '  #secret!: number;', '  static count!: number;', '}'].join('\n');
    expect(at(src)).toEqual(['non-null@2:5', 'non-null@3:24', 'non-null@4:10', 'non-null@5:15']);
  });

  it('names the declaration and suggests a fix', () => {
    const [v] = findUnsafeCode('x.ts', 'class A {\n  id!: string;\n}');
    expect(v?.kind).toBe('non-null');
    expect(v?.message).toContain('definite-assignment assertion `id!`');
    expect(v?.message).toContain('T | undefined');
  });

  it('still flags expression non-null assertions alongside them', () => {
    expect(at('let x!: number;\nconst y = maybe()!;')).toEqual(['non-null@1:6', 'non-null@2:18']);
  });

  it('does not flag !=, !==, logical not, optional members or initialised declarations', () => {
    const src = [
      'const a = 1 != 2;',
      'const b = a !== true;',
      'const c = !a;',
      'const d = !!b;',
      'if (!(a != b)) {}',
      'class K {',
      '  id?: string;',
      '  name: string = "k";',
      '  ok = !this.id;',
      '  constructor(public readonly key: string) {}',
      '}',
      'interface I { x?: number }',
      'type T = { y: string };',
      'let e: number | undefined;',
      'const f = (g: boolean): boolean => !g;',
      'const s = "let x!: number";',
      '// let y!: number',
    ].join('\n');
    expect(findUnsafeCode('x.ts', src)).toEqual([]);
  });

  it('is new code for the edit guard only when the edit introduces it', () => {
    const before = 'class A {\n  id!: string;\n}\n';
    expect(newUnsafeCode('x.ts', before, before.replace('class A', 'export class A'))).toEqual([]);
    expect(newUnsafeCode('x.ts', before, `${before}let z!: number;\n`).map((v) => v.line)).toEqual([4]);
    expect(newUnsafeCode('x.ts', null, before)).toHaveLength(1);
  });
});
