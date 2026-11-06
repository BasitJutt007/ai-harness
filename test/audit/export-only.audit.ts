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
 *   named shapes    the exports that change how the module is consumed (default, re-exports, `export =`, an
 *                   imported binding, an ambient one, `then`, `__esModule`, any export next to an
 *                   `export * from`), a new declaration, a removed or renamed export, a moved statement, a
 *                   newline that moves a semicolon;
 *   comments        a comment builds obey (`/*#__PURE__*\/`) inserted before every token, a JSX pragma
 *                   (@jsx, @jsxRuntime, @jsxImportSource, @jsxFrag) at the top or the end, and every comment
 *                   of the module removed, changed or moved to the next token;
 *   JSX text        each JSX text's leading and trailing whitespace changed (the rendered text).
 *
 * A check of one file cannot see what a new export does to code that reads the module as a whole (a registry
 * built from `import * as`, a framework that reads exports by name), so the last group audits the gate instead:
 * a file that only gained exports never ends green, alone or next to a proven fix, however many export-only
 * edits led there; only its exact run-start content again (the way back) leaves nothing to report.
 *
 *   npm run audit:mutations
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import observedRedHook from '../../plugins/hooks/observed-red.ts';
import { EXPORT_ONLY_KEY, recordUnlocked } from '../../plugins/lib/red.ts';
import writeFileTool from '../../plugins/tools/write_file.ts';
import { exportOnlyEdit } from '../../src/core/export-only.ts';
import type { RunContext, TargetLayout, TestObservation, TestRunReport } from '../../src/core/plugin-api.ts';
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
  /** The text of `after` that starts with the added `export` keyword. */
  exportAt: string;
  /** A top-level declaration of `before` that is not exported (for the whole-module names). */
  local: string;
}

/** An in-place web layout (a React app: .tsx under src/ is governed code). */
const WEB: TargetLayout = { ...LEGACY_LAYOUT, sourceRoots: ['src'], testRoots: ['test'], testSupportRoots: ['test'], testGlobs: ['test/**/*.test.ts'], codeKinds: 'web' };

const TS_BEFORE = [
  "import { request } from './http';",
  '',
  'export interface Page { items: string[]; next: string | null }',
  "const CURSOR = /^c(\\d+)$/;",
  'enum Kind { First = 1, Next }',
  'let calls = 0; // pages fetched so far',
  "const trace = /*#__PURE__*/ String('pages');",
  '',
  '/** Appends the next page to the ones already loaded. */',
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
  '// The unread badge.',
  'function Badge({ count }: { count: number }) {',
  '  return <span className="badge">{/* capped */}{count > 99 ? "99+" : count} new</span>;',
  '}',
  '',
  'export function Inbox() {',
  '  const [n, setN] = useState(0);',
  '  return <button onClick={() => setN(n + 1)}>Inbox <Badge count={n} /></button>;',
  '}',
  '',
].join('\n');

const MODULES: Module[] = [
  { file: 'src/store/x/api.ts', before: TS_BEFORE, after: TS_BEFORE.replace('function appendPage', 'export function appendPage'), inPlace: false, bodyChange: ['calls += 1;', 'calls += 2;'], exportAt: 'export function appendPage', local: 'appendPage' },
  { file: 'src/ui/Inbox.tsx', before: TSX_BEFORE, after: TSX_BEFORE.replace('function Badge', 'export function Badge'), inPlace: true, bodyChange: ['useState(0)', 'useState(1)'], exportAt: 'export function Badge', local: 'Badge' },
];

/** Every comment of `text` (from each token's leading trivia; JSX text is text), with where it is and the token after it. */
function comments(file: string, text: string): Array<{ start: number; end: number; text: string; before: number }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  const out: Array<{ start: number; end: number; text: string; before: number }> = [];
  const visit = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length > 0) {
      kids.forEach(visit);
      return;
    }
    if (n.kind === ts.SyntaxKind.JsxText || n.pos >= n.getStart(sf)) return;
    scanner.setText(text, n.pos, n.getStart(sf) - n.pos);
    for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
      if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) out.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), text: scanner.getTokenText(), before: n.getStart(sf) });
    }
  };
  visit(sf);
  return out;
}

/** Every JSX text of `text`, whole (its leading whitespace included). */
function jsxTexts(file: string, text: string): Array<{ start: number; end: number; text: string }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const out: Array<{ start: number; end: number; text: string }> = [];
  const visit = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.JsxText) out.push({ start: n.pos, end: n.end, text: text.slice(n.pos, n.end) });
    n.getChildren(sf).forEach(visit);
  };
  visit(sf);
  return out;
}

const PRAGMAS = ['/** @jsx h */', '/** @jsxRuntime classic */', '/** @jsxImportSource preact */', '/** @jsxFrag Frag */', '/* @__NO_SIDE_EFFECTS__ */', '// @ts-nocheck'];

/** The comment class: a comment a build obeys inserted anywhere, pragmas at either end, every comment removed, changed or moved. */
function commentMutations(m: Module): Mutation[] {
  const out: Mutation[] = [];
  const exportStart = m.after.indexOf(m.exportAt);
  const toks = tokens(m.file, m.after);
  for (const t of toks) {
    if (t.kind === ts.SyntaxKind.JsxText) continue;
    out.push({ name: `/*#__PURE__*/ inserted before ${t.text}@${t.start}`, content: `${m.after.slice(0, t.start)}/*#__PURE__*/ ${m.after.slice(t.start)}` });
  }
  for (const p of PRAGMAS) {
    out.push({ name: `${p} at the top`, content: `${p}\n${m.after}` });
    out.push({ name: `${p} at the end`, content: `${m.after}${p}\n` });
  }
  for (const c of comments(m.file, m.after)) {
    const where = `${c.text}@${c.start}`;
    out.push({ name: `comment removed: ${where}`, content: m.after.slice(0, c.start) + m.after.slice(c.end) });
    out.push({ name: `comment changed: ${where}`, content: `${m.after.slice(0, c.end - (c.text.startsWith('/*') ? 2 : 0))}#__PURE__${m.after.slice(c.end - (c.text.startsWith('/*') ? 2 : 0))}` });
    // Moved to before the next token (past the added `export` when it leads that one: left out, it is no anchor).
    const anchor = c.before === exportStart ? 1 : 0;
    const next = toks.filter((t) => t.start > c.before && t.kind !== ts.SyntaxKind.JsxText)[anchor];
    if (next !== undefined) {
      const without = m.after.slice(0, c.start) + m.after.slice(c.end);
      const at = next.start - (c.end - c.start);
      const sep = c.text.startsWith('//') ? '\n' : ' ';
      out.push({ name: `comment moved: ${where} -> before ${next.text}`, content: `${without.slice(0, at)}${c.text}${sep}${without.slice(at)}` });
    }
  }
  return out.filter((x) => x.content !== m.after);
}

/** The JSX text class: the rendered text's whitespace changed at either end, or inside. */
function jsxTextMutations(m: Module): Mutation[] {
  const out: Mutation[] = [];
  for (const j of jsxTexts(m.file, m.after)) {
    const where = `${JSON.stringify(j.text)}@${j.start}`;
    const put = (text: string): string => m.after.slice(0, j.start) + text + m.after.slice(j.end);
    out.push({ name: `JSX text: leading spaces added: ${where}`, content: put(`   ${j.text}`) });
    out.push({ name: `JSX text: trailing spaces added: ${where}`, content: put(`${j.text}   `) });
    if (/^\s/.test(j.text)) out.push({ name: `JSX text: leading whitespace removed: ${where}`, content: put(j.text.trimStart()) });
    if (j.text.includes(' ')) out.push({ name: `JSX text: a space doubled: ${where}`, content: put(j.text.replace(' ', '  ')) });
  }
  return out.filter((x) => x.content !== m.after);
}

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
  ['an export named then (the namespace becomes a thenable)', (m) => `${m.before}export { ${m.local} as then };\n`],
  ['an export named __esModule (CommonJS interop)', (m) => `${m.before}export { ${m.local} as __esModule };\n`],
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

    it('refused: the baseline export in a module that has an `export * from` (the new name would hide a re-exported one)', async () => {
      const star = { ...m, before: `export * from './other';\n${m.before}`, after: `export * from './other';\n${m.after}` };
      expect(exportOnlyEdit(star.file, star.before, star.after).ok).toBe(false);
      const h = await lockedRun(star);
      const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: star.file, content: star.after }) }, h.ctx);
      expect(v.decision).toBe('block');
    });

    for (const [group, make] of [['comment', commentMutations], ['JSX text', jsxTextMutations]] as const) {
      const all = make(m);
      if (all.length === 0) continue;
      it(`every ${group} mutation next to the export is refused (${all.length} mutations)`, async () => {
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
    }
  });
}

describe('audit: a file that only gained exports never ends green (the observed-red gate)', () => {
  const F = 'src/store/x/commands.ts';
  const F_BEFORE = "export function save(): string {\n  return 'saved';\n}\n\nfunction wipeAll(): string {\n  return 'wiped';\n}\n\nfunction dump(): string {\n  return 'dumped';\n}\n\nexport const size = wipeAll.length + dump.length;\n";
  const G = 'src/store/x/total.ts';
  const G_BEFORE = 'export function total(items: number[]): number {\n  return items.length;\n}\n';
  const G_FIXED = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
  const T = 'test/total.test.ts';
  const T_TEXT = "import { total } from '../src/store/x/total';\nimport { it, expect } from 'vitest';\nit('sums', () => expect(total([1, 2])).toBe(3));\n";
  const obs = (status: 'fail' | 'pass'): TestObservation => ({
    file: T, hash: sha(T_TEXT), status, collected: 1, failed: status === 'fail' ? 1 : 0, validRed: status === 'fail', reason: status, turn: 1, at: '',
    cases: [{ name: 'sums', status, bodyHash: 'b', exercisesSource: true, constantOnly: false }],
  });
  const report = (status: 'fail' | 'pass'): TestRunReport => ({ ok: status === 'pass', totals: { files: 1, tests: 1, passed: status === 'pass' ? 1 : 0, failed: status === 'fail' ? 1 : 0 }, observations: [obs(status)], summary: '', logPath: '' });

  /** A run (file mode, or in place) where G went red -> green (or not, without `fixG`) and F took `exportSteps` through the hook, locked. */
  async function gateAfter(opts: { exportSteps: string[]; fixG: boolean; restore?: boolean; inPlace?: boolean }): Promise<string> {
    setActiveLayout(opts.inPlace === true ? WEB : undefined);
    const h = await makeHarness({ label: 'export-only-gate-audit', task: brownfieldTask(), files: { [F]: F_BEFORE, [G]: G_BEFORE, [T]: T_TEXT }, under: realpathSync(tmpdir()) });
    dirs.push(h.dir);
    for (const [rel, text] of [[F, F_BEFORE], [G, G_BEFORE]] as const) h.ctx.state.initialHashes.set(rel, sha(text));
    const ctx: RunContext = {
      ...h.ctx,
      ...(opts.inPlace === true ? { inPlace: { repoTop: h.dir, branch: 'fix/x' }, runner: { kind: 'vitest' as const, name: 'vitest 5.0.3', supported: true } } : {}),
      services: { ...h.ctx.services, runTests: async () => report('pass'), runTestsReverted: async () => ({ current: report('pass'), reverted: report('fail') }) },
    };
    h.ctx.state.tests.push(obs('fail'));
    let content = F_BEFORE;
    for (const name of opts.exportSteps) {
      const next = content.replace(`function ${name}`, `export function ${name}`);
      const v = await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: F, content: next }) }, ctx);
      expect(v.decision, name).toBe('record');
      await h.ws.write(F, next);
      content = next;
    }
    if (opts.restore === true) {
      expect((await observedRedHook.run({ event: 'pre_tool', call: callInfo(writeFileTool, { path: F, content: F_BEFORE }) }, ctx)).decision).toBe('record');
      await h.ws.write(F, F_BEFORE);
    }
    if (opts.fixG) {
      recordUnlocked(h.ctx.state, G);
      await h.ws.write(G, G_FIXED);
    }
    return (await observedRedGate.run(ctx, 'finish')).status;
  }

  it('the baseline: the proven fix alone is green (so "not green" below is the export-only file, not the setup)', async () => {
    expect(await gateAfter({ exportSteps: [], fixG: true })).toBe('pass');
  });

  const cases: Array<[string, Parameters<typeof gateAfter>[0]]> = [
    ['one export-only edit, alone', { exportSteps: ['wipeAll'], fixG: false }],
    ['one export-only edit next to a proven fix (file mode)', { exportSteps: ['wipeAll'], fixG: true }],
    ['one export-only edit next to a proven fix (in place)', { exportSteps: ['wipeAll'], fixG: true, inPlace: true }],
    ['two chained export-only edits next to a proven fix', { exportSteps: ['wipeAll', 'dump'], fixG: true }],
  ];
  for (const [name, opts] of cases) {
    it(`never green: ${name}`, async () => {
      expect(await gateAfter(opts)).not.toBe('pass');
    });
  }

  it('the way back: the exact run-start content again (allowed while locked) leaves only the proven fix, green', async () => {
    expect(await gateAfter({ exportSteps: ['wipeAll', 'dump'], fixG: true, restore: true })).toBe('pass');
  });
});
