/**
 * test-preservation (pre, write of a test file that existed when the run started):
 * pre-existing test cases may be extended but not removed, renamed or disabled.
 * Gutting or skipping the existing suite is the cheapest way to turn tests green
 * after breaking behaviour; this hook makes it impossible through the write tools.
 * (Tests the agent wrote during the run are its own and stay freely editable.)
 */
import ts from 'typescript';
import { defineHook } from '../../src/core/plugin-api.ts';
import { applySingleEdit } from '../lib/diff.ts';
import { stringField, toApiRel } from '../lib/path-policy.ts';
import { isTestFile } from '../lib/red.ts';

const CASE_FNS = new Set(['it', 'test']);
const SUITE_FNS = new Set(['describe', 'suite']);
const DISABLING = new Set(['skip', 'todo', 'only', 'skipIf', 'runIf', 'fails']);
const DISABLED_ALIASES = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']);

export interface TestCase {
  /** "describe > ... > title" ("<dynamic>" for non-literal titles). */
  key: string;
  /** A modifier (skip/todo/only/skipIf/runIf/fails) applies to the case or an enclosing suite. */
  disabled: boolean;
  line: number;
}

/** Root identifier and modifier names of a callee like `it.skip`, `describe.each([...])`, `test.skipIf(x)`. */
function calleeChain(expr: ts.Expression): { root: string | null; mods: string[] } {
  const mods: string[] = [];
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      mods.push(cur.name.text);
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isIdentifier(cur)) {
      return { root: cur.text, mods };
    } else {
      return { root: null, mods };
    }
  }
}

function titleOf(call: ts.CallExpression): string {
  const a = call.arguments[0];
  return a !== undefined && ts.isStringLiteralLike(a) ? a.text : '<dynamic>';
}

/** Test cases declared in a vitest file (static analysis; nested describes form the key path). */
export function testCases(fileName: string, content: string): TestCase[] {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: TestCase[] = [];
  const visit = (node: ts.Node, suites: string[], disabled: boolean): void => {
    if (ts.isCallExpression(node)) {
      const { root, mods } = calleeChain(node.expression);
      const isDisabled = disabled || mods.some((m) => DISABLING.has(m)) || (root !== null && DISABLED_ALIASES.has(root));
      const base = root !== null && DISABLED_ALIASES.has(root) ? root.slice(1) : root;
      if (base !== null && SUITE_FNS.has(base)) {
        const inner = [...suites, titleOf(node)];
        for (const arg of node.arguments.slice(1)) visit(arg, inner, isDisabled);
        return;
      }
      if (base !== null && CASE_FNS.has(base)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        out.push({ key: [...suites, titleOf(node)].join(' > '), disabled: isDisabled, line });
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, suites, disabled));
  };
  visit(sf, [], false);
  return out;
}

/** Human-readable problems: cases of `before` missing from `after`, or newly disabled there. */
export function weakenedCases(fileName: string, before: string, after: string): string[] {
  const remaining = new Map<string, TestCase[]>();
  for (const c of testCases(fileName, after)) remaining.set(c.key, [...(remaining.get(c.key) ?? []), c]);
  const problems: string[] = [];
  for (const c of testCases(fileName, before)) {
    const candidates = remaining.get(c.key) ?? [];
    if (candidates.length === 0) {
      problems.push(`${fileName}:${c.line}  existing test "${c.key}" would be removed or renamed`);
      continue;
    }
    const same = candidates.findIndex((x) => x.disabled === c.disabled);
    const pick = same >= 0 ? same : 0;
    const match = candidates[pick];
    candidates.splice(pick, 1);
    if (match !== undefined && match.disabled && !c.disabled) {
      problems.push(`${fileName}:${match.line}  existing test "${c.key}" would be disabled (skip/todo/only/skipIf/runIf/fails)`);
    }
  }
  return problems;
}

export default defineHook({
  name: 'test-preservation',
  description: 'Blocks removing, renaming or disabling test cases that existed before the run.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    const target = call.paths[0];
    if (target === undefined) return { decision: 'pass' };
    const r = toApiRel(ctx.workspace, target);
    if (!r.ok || !isTestFile(r.rel) || !ctx.state.initialHashes.has(r.rel)) return { decision: 'pass' };
    const before = await ctx.workspace.read(r.rel);
    if (before === null) return { decision: 'pass' };
    let after = stringField(call.input, 'content');
    if (after === undefined) {
      const find = stringField(call.input, 'find');
      const replace = stringField(call.input, 'replace');
      if (find === undefined || replace === undefined) return { decision: 'pass' };
      const edited = applySingleEdit(before, find, replace);
      if (edited === null) return { decision: 'pass' }; // the tool reports 0/2+ matches itself
      after = edited;
    }
    const problems = weakenedCases(r.rel, before, after);
    if (problems.length === 0) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: [
        `test-preservation: ${r.rel} existed before this run; its test cases may be extended, not removed, renamed or disabled:`,
        ...problems.slice(0, 20).map((p) => `  ${p}`),
        'Keep every existing case (add new cases next to them). If behaviour must change, the task has to allow it.',
      ].join('\n'),
    };
  },
});
