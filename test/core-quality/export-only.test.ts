/**
 * Export-only edits (src/core/export-only.ts): the one write a file locked by observed-red takes. Every
 * allowed shape is paired with the refusal next to it: the same `export`, plus one more change of any kind
 * (a body, a constant, an import, a newline that moves a semicolon), or an export of a kind that is not
 * behaviour-neutral (a default export, a re-export that loads another module, `export =`). The revert base
 * (withExports) and the ESM missing-export message parser are pinned here too.
 */
import { describe, expect, it } from 'vitest';
import { declaresUnexported, exportOnlyEdit, missingNamedExport, withExports } from '../../src/core/export-only.ts';

const API = [
  "import { request } from './http';",
  '',
  'export interface Page { items: number[]; next: number | null }',
  'type Cursor = number | null;',
  'enum Kind { A, B }',
  'const PAGE_SIZE = 20;',
  'let calls = 0, { a: first } = { a: 1 };',
  '/** Appends the next page. */',
  'function appendPage(prev: Page, page: Page): Page {',
  '  return { items: [...page.items], next: page.next };',
  '}',
  'async function fetchRaw(url: string) { return request(url) }',
  'class Store { pages: Page[] = [] }',
  'export function load(p: Page): Page {',
  '  calls += 1;',
  '  return appendPage({ items: [], next: null }, p);',
  '}',
  '',
].join('\n');

const at = (needle: string, replacement: string, text = API): string => {
  expect(text.split(needle)).toHaveLength(2);
  return text.replace(needle, replacement);
};
const verdict = (after: string, before = API, file = 'src/store/x/api.ts') => exportOnlyEdit(file, before, after);

describe('allowed: only existing top-level declarations become exported', () => {
  const cases: Array<[string, string, string[]]> = [
    ['a function', at('function appendPage', 'export function appendPage'), ['appendPage']],
    ['an async function', at('async function fetchRaw', 'export async function fetchRaw'), ['fetchRaw']],
    ['a const', at('const PAGE_SIZE', 'export const PAGE_SIZE'), ['PAGE_SIZE']],
    ['a let with a destructuring pattern (every name it binds)', at('let calls', 'export let calls'), ['calls', 'first']],
    ['a class', at('class Store', 'export class Store'), ['Store']],
    ['an enum', at('enum Kind', 'export enum Kind'), ['Kind']],
    ['a type alias', at('type Cursor', 'export type Cursor'), ['Cursor']],
    ['a local export statement with an alias', `${API}export { appendPage, PAGE_SIZE as pageSize };\n`, ['appendPage', 'pageSize']],
    ['a type-only local export statement', `${API}export type { Cursor };\n`, ['Cursor']],
    ['several at once, with a comment added (comments are trivia)', at('class Store', '// for tests\nexport class Store', at('function appendPage', 'export function appendPage')), ['Store', 'appendPage']],
  ];
  for (const [name, after, names] of cases) {
    it(name, () => {
      expect(verdict(after)).toEqual({ ok: true, names: [...names].sort() });
    });
  }

  it('JSX (.tsx), JavaScript (.js) and .mts modules parse in their own mode', () => {
    const tsx = "import React from 'react';\nfunction Row({ n }: { n: number }) { return <li className=\"row\">it's {n}</li>; }\nexport function List() { return <ul><Row n={1} /></ul>; }\n";
    expect(exportOnlyEdit('src/List.tsx', tsx, at('function Row', 'export function Row', tsx))).toEqual({ ok: true, names: ['Row'] });
    const js = "import { x } from './x.js';\nfunction twice(n) { return /a\\/b/.test(String(n)) ? x : n * 2; }\nexport const y = 1;\n";
    expect(exportOnlyEdit('src/twice.js', js, at('function twice', 'export function twice', js))).toEqual({ ok: true, names: ['twice'] });
    const mts = "export const a = 1;\nfunction b() { return `t${a}` }\n";
    expect(exportOnlyEdit('src/b.mts', mts, `${mts}export { b };\n`)).toEqual({ ok: true, names: ['b'] });
  });
});

describe('refused: anything that is not exactly an added export', () => {
  const exported = at('function appendPage', 'export function appendPage');
  const cases: Array<[string, string, RegExp]> = [
    ['export plus a changed body', at('[...page.items]', '[...prev.items, ...page.items]', exported), /line 9 .*changes more than adding `export`/],
    ['export plus a changed constant', at('const PAGE_SIZE = 20', 'export const PAGE_SIZE = 21'), /line 6 .*changes more than adding `export`/],
    ['export plus a changed import', at("from './http'", "from './http2'", exported), /line 1 .*changes more than adding `export`/],
    ['a new exported declaration', `${API}export function extra(): number { return 2; }\n`, /adds a new declaration/],
    ['a new declaration exported by a statement', `${API}const extra = 2;\nexport { extra };\n`, /adds a new declaration/],
    ['export * from (it loads another module)', `${API}export * from './http';\n`, /re-exports from another module/],
    ['export { x } from (it loads another module)', `${API}export { request } from './http';\n`, /re-exports from another module/],
    ['re-exporting an imported binding', `${API}export { request };\n`, /not a top-level function, class, variable, enum, interface or type declaration/],
    ['removing an export', at('export function load', 'function load', exported), /changes more than adding `export`/],
    ['renaming an export (the new name is a new declaration)', at('export interface Page', 'export interface Paged', exported), /line 3 .*adds a new declaration/],
    ['export default on a declaration', at('function appendPage', 'export default function appendPage'), /adds a default export/],
    ['export { x as default }', `${API}export { appendPage as default };\n`, /adds a default export/],
    ['export default of an expression', `${API}export default appendPage;\n`, /adds a default export/],
    ['export =', `${API}export = appendPage;\n`, /adds `export =`/],
    ['a name the module already exports', `${API}export { load };\n`, /exports load, which the module already exports/],
    ['the same name exported twice', `${API}export { appendPage };\nexport { appendPage };\n`, /exports appendPage twice/],
    ['a string-named export', `${API}export { appendPage as "append page" };\n`, /string-named binding/],
    ['a newline that changes automatic semicolon insertion', at('{ return request(url) }', '{ return\nrequest(url) }', at('async function fetchRaw', 'export async function fetchRaw')), /changes more than adding `export`/],
    ['a moved statement', `${at('const PAGE_SIZE = 20;\n', '')}export const PAGE_SIZE = 20;\n`, /line|removes/],
    ['content that does not parse', at('return { items', 'return {{ items', exported), /does not parse/],
    ['an edit that exports nothing', API, /exports nothing new/],
  ];
  for (const [name, after, why] of cases) {
    it(name, () => {
      const v = verdict(after);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.why).toMatch(why);
    });
  }

  it('an ambient (declare) declaration has no runtime value to export; its exported twin of a real declaration passes', () => {
    const before = "export const a = 1;\ndeclare function host(): void;\nfunction real() {}\n";
    expect(exportOnlyEdit('src/a.ts', before, `${before}export { host };\n`)).toMatchObject({ ok: false, why: expect.stringMatching(/ambient/) });
    expect(exportOnlyEdit('src/a.ts', before, at('declare function host', 'export declare function host', before))).toMatchObject({ ok: false, why: expect.stringMatching(/ambient/) });
    expect(exportOnlyEdit('src/a.ts', before, `${before}export { real };\n`)).toEqual({ ok: true, names: ['real'] });
  });

  it('a script (no import or export yet) is refused: its first export would change how its names are scoped; a module twin passes', () => {
    expect(exportOnlyEdit('src/a.ts', 'function a() {}\n', 'export function a() {}\n')).toMatchObject({ ok: false, why: expect.stringMatching(/not an ES module yet/) });
    expect(exportOnlyEdit('src/a.ts', 'export {};\nfunction a() {}\n', 'export {};\nexport function a() {}\n')).toEqual({ ok: true, names: ['a'] });
  });

  it('JSX text is a token: changing it next to an added export is refused', () => {
    const tsx = "import React from 'react';\nfunction Row() { return <li>it's here</li>; }\nexport const x = 1;\n";
    const v = exportOnlyEdit('src/Row.tsx', tsx, at("it's here", 'it is here', at('function Row', 'export function Row', tsx)));
    expect(v).toMatchObject({ ok: false, why: expect.stringMatching(/line 2 .*changes more than adding `export`/) });
  });

  it('kinds that are not TypeScript or JavaScript modules are never judged export-only', () => {
    expect(exportOnlyEdit('src/App.vue', 'x', 'y')).toMatchObject({ ok: false, why: expect.stringMatching(/not a TypeScript or JavaScript module/) });
    expect(exportOnlyEdit('src/types.d.ts', 'export {};\ninterface A {}\n', 'export {};\nexport interface A {}\n')).toMatchObject({ ok: false });
  });

  it('addsExports tells an attempt at an export-only edit from an unrelated edit', () => {
    expect(verdict(at('[...page.items]', '[...prev.items]', at('function appendPage', 'export function appendPage')))).toMatchObject({ ok: false, addsExports: true });
    expect(verdict(at('[...page.items]', '[...prev.items]'))).toMatchObject({ ok: false, addsExports: false });
  });
});

describe('withExports: the revert base keeps the exports the run made of run-start declarations', () => {
  const fixed = at('[...page.items]', '[...prev.items, ...page.items]', at('function appendPage', 'export function appendPage'));

  it('the run-start content plus exactly those exports, verified export-only against it', () => {
    const base = withExports('src/store/x/api.ts', API, fixed);
    expect(base).not.toBeNull();
    expect(base?.names).toEqual(['appendPage']);
    expect(base?.content).toBe(`${API}export { appendPage };\n`);
    // The base still holds the run-start BEHAVIOUR: only the export differs from the run-start content.
    expect(exportOnlyEdit('src/store/x/api.ts', API, base?.content ?? '')).toEqual({ ok: true, names: ['appendPage'] });
    expect(base?.content).toContain('[...page.items]');
  });

  it('types go to an `export type` statement; aliases are kept', () => {
    const current = `${API}export type { Cursor };\nexport { PAGE_SIZE as pageSize };\n`;
    expect(withExports('src/store/x/api.ts', API, current)?.content).toBe(`${API}export { PAGE_SIZE as pageSize };\nexport type { Cursor };\n`);
  });

  it('twins with nothing to keep: no new export, a declaration new in the run, a default export, an already exported name', () => {
    expect(withExports('src/store/x/api.ts', API, API)).toBeNull();
    expect(withExports('src/store/x/api.ts', API, `${API}export function extra() { return 1; }\n`)).toBeNull();
    expect(withExports('src/store/x/api.ts', API, at('function appendPage', 'export default function appendPage'))).toBeNull();
    expect(withExports('src/store/x/api.ts', API, `${API}export { load as loadPage };\n`)?.names).toEqual(['loadPage']);
    expect(withExports('src/store/x/api.ts', 'function a() {}\n', 'export function a() {}\n')).toBeNull();
  });

  it('a run-start content without a final newline still gets a statement of its own', () => {
    const start = 'export const a = 1;\nfunction b() { return a }';
    expect(withExports('src/b.ts', start, `${start}\nexport { b };\n`)?.content).toBe(`${start}\nexport { b };\n`);
  });
});

describe('the ESM missing-export message', () => {
  it("Node's linker message is parsed (specifier as written, the name, the line); CommonJS's 'is not a function' is not guessed at", () => {
    const msg = "SyntaxError: The requested module '../src/store/x/api' does not provide an export named 'appendPage'\n    at ModuleJob._instantiate";
    expect(missingNamedExport(msg)).toEqual({ module: '../src/store/x/api', name: 'appendPage', line: "SyntaxError: The requested module '../src/store/x/api' does not provide an export named 'appendPage'" });
    expect(missingNamedExport('TypeError: (0 , import_api.appendPage) is not a function')).toBeNull();
    expect(missingNamedExport("Error: Cannot find module '../src/x'")).toBeNull();
  });

  it('declaresUnexported: a top-level declaration the module does not export; exported or absent names are not', () => {
    expect(declaresUnexported('src/store/x/api.ts', API, 'appendPage')).toBe(true);
    expect(declaresUnexported('src/store/x/api.ts', API, 'load')).toBe(false);
    expect(declaresUnexported('src/store/x/api.ts', API, 'missing')).toBe(false);
  });
});
