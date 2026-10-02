import { describe, expect, it } from 'vitest';
import { applySingleEdit, diffStats, occurrences, unifiedDiff } from '../../plugins/lib/diff.ts';
import { scanSecrets } from '../../plugins/lib/secrets.ts';
import { findUnsafeCode, newUnsafeCode } from '../../plugins/lib/ts-safety.ts';
import { parsePorcelainZ } from '../../plugins/gates/scope.ts';
import { addedLines } from '../../plugins/gates/secrets.ts';
import { outlineSource } from '../../plugins/tools/outline.ts';

describe('diff', () => {
  it('counts added and removed lines', () => {
    expect(diffStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(diffStats('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
    expect(diffStats('same\n', 'same\n')).toEqual({ added: 0, removed: 0 });
  });

  it('produces a unified diff with hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const after = before.replace('line2\n', 'LINE2\n').replace('line18\n', 'line18\nextra\n');
    const d = unifiedDiff('src/a.ts', before, after);
    expect(d.startsWith('--- a/src/a.ts\n+++ b/src/a.ts\n')).toBe(true);
    expect(d).toContain('@@ -1,5 +1,5 @@');
    expect(d).toContain('-line2\n+LINE2');
    expect(d).toContain('+extra');
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(unifiedDiff('x.ts', null, 'a\n')).toContain('--- /dev/null');
    expect(unifiedDiff('x.ts', 'a\n', 'a\n')).toBe('');
  });

  it('applies single edits only', () => {
    expect(occurrences('a b a', 'a')).toEqual([0, 4]);
    expect(applySingleEdit('a b a', 'a', 'x')).toBeNull();
    expect(applySingleEdit('a b c', 'b', '$&')).toBe('a $& c');
  });
});

describe('secrets', () => {
  it('detects key-like content and redacts it', () => {
    const text = [
      'const ok = "hello";',
      `const k = "${'sk-' + 'a'.repeat(30)}";`,
      `const aws = "${'AKIA' + 'B'.repeat(16)}";`,
      `token: ${'ghp_' + 'c'.repeat(36)}`,
      `${'xoxb-' + '1'.repeat(20)}`,
      `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
      `apiKey = "${'d'.repeat(20)}"`,
    ].join('\n');
    const found = scanSecrets(text);
    expect(found.map((f) => [f.id, f.line])).toEqual([
      ['sk-key', 2],
      ['aws-access-key', 3],
      ['github-token', 4],
      ['slack-token', 5],
      ['private-key', 6],
      ['generic-api-key', 7],
    ]);
    expect(found.every((f) => !f.preview.includes('a'.repeat(10)))).toBe(true);
    expect(scanSecrets('const apiKey = process.env.API_KEY;\nconst desk = "sk-short";')).toEqual([]);
  });
});

describe('ts-safety', () => {
  it('reports any, non-null assertions and ts directives with locations', () => {
    const src = ['let a: any = 1;', 'const b = maybe()!;', '// @ts-ignore', 'const c = [] as Array<any>;', '/* @ts-expect-error */', '// @ts-nocheck'].join('\n');
    const v = findUnsafeCode('x.ts', src).map((x) => `${x.kind}@${x.line}:${x.col}`);
    expect(v).toEqual(['any@1:8', 'non-null@2:18', 'ts-directive@3:4', 'any@4:23', 'ts-directive@5:4', 'ts-directive@6:4']);
  });

  it('allows identifiers containing "any", != and directives inside strings', () => {
    const src = ['const company = 1;', 'const any2 = company != 2;', 'const s = "// @ts-ignore";', 'const t = `${company}// @ts-ignore`;', '// do not use @ts-ignore here'].join('\n');
    expect(findUnsafeCode('x.ts', src)).toEqual([]);
  });

  it('only reports violations the edit introduces', () => {
    const before = 'let a: any = 1;\nconst b = 2;\n';
    expect(newUnsafeCode('x.ts', before, before.replace('const b = 2', 'const b = 3'))).toEqual([]);
    expect(newUnsafeCode('x.ts', before, before + 'let c: any;\n')).toHaveLength(1);
  });
});

describe('outline', () => {
  it('lists imports, exports, schemas and routes', () => {
    const src = [
      "import { Router } from 'express';",
      "import { z } from 'zod';",
      'export const ItemSchema = z.object({ id: z.string() });',
      'export type Item = z.infer<typeof ItemSchema>;',
      'export const itemsRouter = Router();',
      "itemsRouter.get('/v1/items', (req, res) => { res.json([]); });",
      "itemsRouter.post('/v1/items', (req, res) => { res.status(201).json({}); });",
      "const cache = new Map(); cache.get('key');",
      'export function helper(): void {}',
      'export default class Thing {}',
    ].join('\n');
    const out = outlineSource('src/routes/items.ts', src).join('\n');
    expect(out).toContain('imports: express, zod');
    expect(out).toContain('const ItemSchema L3');
    expect(out).toContain('type Item L4');
    expect(out).toContain('function helper L9');
    expect(out).toContain('default class Thing L10');
    expect(out).toContain('schemas: ItemSchema L3');
    expect(out).toContain('routes: GET /v1/items L6; POST /v1/items L7');
    expect(out).not.toContain('key');
  });
});

describe('git output parsing', () => {
  it('parses porcelain -z including renames', () => {
    expect(parsePorcelainZ(' M api/src/a.ts\u0000?? api/test/b.test.ts\u0000R  api/src/new.ts\u0000api/src/old.ts\u0000')).toEqual([
      'api/src/a.ts',
      'api/test/b.test.ts',
      'api/src/new.ts',
      'api/src/old.ts',
    ]);
  });

  it('extracts added lines with new-side line numbers', () => {
    const diff = ['diff --git a/x b/x', '--- a/api/x.ts', '+++ b/api/x.ts', '@@ -3,0 +4,2 @@', '+one', '+two'].join('\n');
    expect(addedLines(diff)).toEqual([
      { file: 'api/x.ts', line: 4, text: 'one' },
      { file: 'api/x.ts', line: 5, text: 'two' },
    ]);
  });
});
