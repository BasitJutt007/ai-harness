/**
 * Fail-closed audit of the export-only allowance (src/core/export-only.ts, the observed-red hook): the one
 * write a locked source file takes. Each group starts from an export-only edit the hook ALLOWS (the
 * baseline), then applies one more change; the hook must refuse every mutated write, and the predicate must
 * say it is not export-only. A mutation that still passes is a bypass: fix the predicate, never this list.
 *
 *   every token     each token of the exported module (identifiers, literals, template and regex text, JSX
 *                   text, keywords, punctuation) changed in place, and each token deleted;
 *   operators       each operator or keyword swapped for a sibling that still parses (=== / !==, + / -,
 *                   const / let, true / false, ...), so the tree stays well-formed and only its meaning moves;
 *   named shapes    the exports that are not behaviour-neutral (default, re-exports, `export =`, an imported
 *                   binding, an ambient one), a new declaration, a removed or renamed export, a moved
 *                   statement, a newline that moves a semicolon.
 *
 *   npm run audit:mutations
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import { EXPORT_ONLY_KEY } from '../../plugins/lib/red.ts';
import writeFileTool from '../../plugins/tools/write_file.ts';
import { exportOnlyEdit } from '../../src/core/export-only.ts';
import type { RunContext, TargetLayout } from '../../src/core/plugin-api.ts';
import { LEGACY_LAYOUT, setActiveLayout } from '../../src/core/target.ts';
import { scriptKindOf } from '../../src/core/testmap.ts';
import { brownfieldTask, callInfo, makeHarness, removeTmp, sha } from '../plugins/helpers.ts';

const dirs: string[] = [];
afterAll(async () => {
  setActiveLayout(undefined);
  await Promise.all(dirs.splice(0).map(removeTmp));
});

interface Module {
  file: string;
  before: string;
  /** The baseline: `before` with exactly one declaration exported (the hook allows it). */
  after: string;
  /** Judged in place (a session's web layout, where .tsx is governed) rather than in file mode. */
  inPlace: boolean;
  /** One statement-local change inside the exported module, next to the export. */
  bodyChange: [string, string];
}

/** An in-place web layout (a React app: .tsx under src/ is governed code). */
const WEB: TargetLayout = { ...LEGACY_LAYOUT, sourceRoots: ['src'], testRoots: ['test'], testSupportRoots: ['test'], testGlobs: ['test/**/*.test.ts'], codeKinds: 'web' };

const TS_BEFORE = [
  "import { request } from './http';",
  '',
  'export interface Page { items: string[]; next: string | null }',
  "const CURSOR = /^c(\\d+)$/;",
  'enum Kind { First = 1, Next }',
  'let calls = 0;',
  '',
  'function appendPage(prev: Page, page: Page, kind: Kind = Kind.Next): Page {',
  '  calls += 1;',
  '  const items = kind === Kind.First ? [...page.items] : [...prev.items, ...page.items];',
  '  return { items, next: page.next ?? (CURSOR.test(String(prev.next)) ? null : `c${calls}`) };',
  '}',
  '',
  'export async function loadMore(prev: Page): Promise<Page> {',
  '  if (prev.next === null || calls > 10) return prev;',
  '  return appendPage(prev, await request(`/pages?after=${prev.next}`), Kind.Next);',
  '}',
  '',
].join('\n');

const TSX_BEFORE = [
  "import { useState } from 'react';",
  '',
  'function Badge({ count }: { count: number }) {',
  '  return <span className="badge">{count > 99 ? "99+" : count} new</span>;',
  '}',
  '',
  'export function Inbox() {',
  '  const [n, setN] = useState(0);',
  '  return <button onClick={() => setN(n + 1)}>Inbox <Badge count={n} /></button>;',
  '}',
  '',
].join('\n');

const MODULES: Module[] = [
  { file: 'src/store/x/api.ts', before: TS_BEFORE, after: TS_BEFORE.replace('function appendPage', 'export function appendPage'), inPlace: false, bodyChange: ['calls += 1;', 'calls += 2;'] },
  { file: 'src/ui/Inbox.tsx', before: TSX_BEFORE, after: TSX_BEFORE.replace('function Badge', 'export function Badge'), inPlace: true, bodyChange: ['useState(0)', 'useState(1)'] },
];

/** Every token of `text` (parsed in its file's mode), with where it is. */
function tokens(file: string, text: string): Array<{ kind: ts.SyntaxKind; start: number; end: number; text: string }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const out: Array<{ kind: ts.SyntaxKind; start: number; end: number; text: string }> = [];
  const visit = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      if (n.kind !== ts.SyntaxKind.EndOfFileToken && n.getText(sf).trim() !== '') out.push({ kind: n.kind, start: n.getStart(sf), end: n.end, text: n.getText(sf) });
      return;
    }
    kids.forEach(visit);
  };
  visit(sf);
  return out;
}

/** A changed copy of a token's text that is still the same kind of token. */
function changed(t: { kind: ts.SyntaxKind; text: string }): string | null {
  switch (t.kind) {
    case ts.SyntaxKind.Identifier: return `${t.text}Q`;
    case ts.SyntaxKind.StringLiteral: return `${t.text[0]}q${t.text.slice(1)}`;
    case ts.SyntaxKind.NumericLiteral: return `${t.text}1`;
    case ts.SyntaxKind.RegularExpressionLiteral: return `/q${t.text.slice(1)}`;
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail: return `${t.text[0]}q${t.text.slice(1)}`;
    case ts.SyntaxKind.JsxText: return `${t.text}q`;
    default: return null;
  }
}

const SWAPS: Record<string, string> = {
  '===': '!==', '!==': '===', '+': '-', '+=': '-=', '>': '>=', '??': '||', '||': '&&', '&&': '||', '?': '?', const: 'let', let: 'const', async: '', await: '',
};

function at(text: string, t: { start: number; end: number }, replacement: string): string {
  return text.slice(0, t.start) + replacement + text.slice(t.end);
}

interface Mutation { name: string; content: string }

function mutations(m: Module): Mutation[] {
  const out: Mutation[] = [];
  for (const t of tokens(m.file, m.after)) {
    const where = `${t.text}@${t.start}`;
    const c = changed(t);
    if (c !== null) out.push({ name: `token changed: ${where}`, content: at(m.after, t, c) });
    out.push({ name: `token deleted: ${where}`, content: at(m.after, t, '') });
    const swap = SWAPS[t.text];
    if (swap !== undefined && swap !== t.text) out.push({ name: `operator swapped: ${where} -> ${swap || '(nothing)'}`, content: at(m.after, t, swap) });
  }
  return out.filter((x) => x.content !== m.after);
}

const SHAPES: Array<[string, (m: Module) => string]> = [
  ['export default added', (m) => m.after.replace('export function', 'export default function')],
  ['export { x as default }', (m) => `${m.before}export { ${m.file.endsWith('.tsx') ? 'Badge' : 'appendPage'} as default };\n`],
  ['export * from', (m) => `${m.after}export * from './other';\n`],
  ['export { x } from', (m) => `${m.after}export { other } from './other';\n`],
  ['an imported binding re-exported', (m) => `${m.before}export { ${m.file.endsWith('.tsx') ? 'useState' : 'request'} };\n`],
  ['a new exported declaration', (m) => `${m.after}export const extra = 1;\n`],
  ['a removed export', (m) => m.after.replace(/export (async )?function (loadMore|Inbox)/, '$1function $2')],
  ['a renamed export', (m) => m.after.replace(/export (async )?function (loadMore|Inbox)/, 'export $1function $2Renamed')],
  ['a moved statement (the import, last)', (m) => { const [first, ...rest] = m.after.split('\n'); return `${rest.join('\n')}${first ?? ''}\n`; }],
  ['a newline after return (a moved semicolon)', (m) => m.after.replace('return ', 'return\n')],
  ['a statement-local change next to the export', (m) => m.after.replace(m.bodyChange[0], m.bodyChange[1])],
];

/** A run where `m.file` exists at run start and no test covers it (locked): in file mode, or in place with a supported runner. */
async function lockedRun(m: Module): Promise<{ ctx: RunContext }> {
  setActiveLayout(m.inPlace ? WEB : undefined);
  // In the OS temp dir: an in-place run's repository is never inside the harness checkout.
  const h = await makeHarness({ label: 'export-only-audit', task: brownfieldTask(), files: { [m.file]: m.before }, under: realpathSync(tmpdir()) });
  dirs.push(h.dir);
  h.ctx.state.initialHashes.set(m.file, sha(m.before));
  const ctx: RunContext = m.inPlace ? { ...h.ctx, inPlace: { repoTop: h.dir, branch: 'fix/x' }, runner: { kind: 'vitest', name: 'vitest 5.0.3', supported: true } } : h.ctx;
  return { ctx };
}

for (const m of MODULES) {
  describe(`audit: the export-only allowance on ${m.file} refuses every write that does more than export`, () => {
    it('the baseline export-only edit is allowed while the file is locked, and recorded (unlocking nothing)', async () => {
      expect(exportOnlyEdit(m.file, m.before, m.after)).toMatchObject({ ok: true });
      const h = await lockedRun(m);
      const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: m.file, content: m.after }) }, h.ctx);
      expect(v.decision).toBe('record');
      expect(h.ctx.state.scratch.get(EXPORT_ONLY_KEY)).toHaveLength(1);
    });

    const all = mutations(m);
    it(`every token changed, deleted or swapped is refused (${all.length} mutations)`, async () => {
      expect(all.length).toBeGreaterThan(100);
      const h = await lockedRun(m);
      const passed: string[] = [];
      for (const x of all) {
        const verdict = exportOnlyEdit(m.file, m.before, x.content);
        const hook = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: m.file, content: x.content }) }, h.ctx);
        if (verdict.ok || hook.decision !== 'block') passed.push(x.name);
      }
      expect(passed, `bypasses: ${passed.join('; ')}`).toEqual([]);
      expect(h.ctx.state.scratch.has(EXPORT_ONLY_KEY)).toBe(false);
    });

    for (const [name, make] of SHAPES) {
      it(`refused: ${name}`, async () => {
        const content = make(m);
        expect(content).not.toBe(m.after);
        expect(exportOnlyEdit(m.file, m.before, content).ok).toBe(false);
        const h = await lockedRun(m);
        const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: m.file, content }) }, h.ctx);
        expect(v.decision).toBe('block');
      });
    }
  });
}
