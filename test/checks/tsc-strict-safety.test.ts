import { describe, expect, it } from 'vitest';
import { findUnsafeCode } from '../../plugins/lib/ts-safety.ts';

const at = (file: string, src: string): string[] => findUnsafeCode(file, src).map((v) => `${v.kind}@${v.line}:${v.col}`);

describe('ts-safety over every TypeScript file kind tsc-strict now scans', () => {
  it('finds the same constructs in .ts, .mts, .cts and declaration files', () => {
    const src = 'export declare const a: any;\nexport const b = maybe()!;\n// @ts-ignore\nexport const c = 1;\n';
    for (const file of ['x.ts', 'x.mts', 'x.cts', 'x.d.ts', 'x.d.mts', 'nested/dir/x.ts']) {
      expect(at(file, src), file).toEqual(['any@1:25', 'non-null@2:25', 'ts-directive@3:4']);
    }
  });

  it('parses .tsx as TSX: JSX is not misread, and `any` / `x!` inside it are still found', () => {
    const src = 'export const v = (p: any): unknown => <div title={p.name!}>{p.id}</div>;\n';
    expect(at('view.tsx', src)).toEqual(['any@1:22', 'non-null@1:57']);
    // the same text as plain TypeScript is a parse error, so a .tsx file must not be parsed as .ts
    expect(at('view.ts', src)).not.toEqual(at('view.tsx', src));
  });

  it('`declare global { var x: any }` and `declare module` bodies in a .d.ts are flagged', () => {
    const src = 'declare global {\n  var cache: any;\n}\ndeclare module "legacy" {\n  export function f(x: any): void;\n}\nexport {};\n';
    expect(at('src/types/global.d.ts', src)).toEqual(['any@2:14', 'any@5:24']);
  });

  it('`as unknown as X` stays allowed (deliberately not an unsafe construct)', () => {
    expect(at('x.ts', 'export const n = JSON.parse("1") as unknown as number;\n')).toEqual([]);
  });
});
