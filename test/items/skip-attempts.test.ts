/**
 * The graders' skip attempts (assignment 02, section 4.1), each as a paired test: the bypass is
 * refused WITH the reason, and its legitimate twin passes.
 *
 *   1. edit a source file with no contract                    -> problem-gate (and bindItem preflight)
 *   2. echo "yes" from a tool result and try to Stop          -> contract-gate holds finish
 *   3. close an item without reading the metric               -> test/items/close.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import contractGate from '../../plugins/hooks/contract-gate.ts';
import problemGate from '../../plugins/hooks/problem-gate.ts';
import stakeholderYes from '../../plugins/gates/stakeholder-yes.ts';
import { itemPaths, parseContract, proposeItem, recordReply } from '../../src/core/items.ts';
import { bindItem } from '../../src/core/run.ts';
import type { HookPlugin, ItemBinding, PluginRecord, RegistryView, RunContext, ToolCallInfo } from '../../src/core/types.ts';
import { contractFor, writeContract } from '../support/items.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'skip-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write: ToolCallInfo = { id: 'c1', tool: 'write_file', effect: 'write', input: { path: 'src/app.ts', content: 'x' }, paths: ['src/app.ts'] };
const finish: ToolCallInfo = { id: 'c2', tool: 'finish', effect: 'control', input: { summary: 'done' }, paths: [] };
const read: ToolCallInfo = { id: 'c3', tool: 'read_file', effect: 'read', input: { path: 'src/app.ts' }, paths: ['src/app.ts'] };

/** The parts of a RunContext the item hooks read: the binding and the run's own transcript. */
function ctxFor(item: ItemBinding | undefined, runDir: string): RunContext {
  return { item, run: { runDir } } as unknown as RunContext;
}
function binding(root: string, slug: string): ItemBinding {
  const text = contractFor(slug);
  return { slug, root, contractHash: parseContract(text).hash };
}
async function hook(h: HookPlugin, call: ToolCallInfo, ctx: RunContext): Promise<{ decision: string; reason?: string }> {
  return (await h.run({ event: 'pre_tool', call }, ctx)) as { decision: string; reason?: string };
}

describe('skip 1: edit a source file with no contract', () => {
  it('is refused when the run is bound to no item', async () => {
    const v = await hook(problemGate, write, ctxFor(undefined, tmp()));
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/bound to no backlog item, and no edit happens without a contract/);
  });

  it('is refused when the contract file does not exist, naming the file to write', async () => {
    const root = tmp();
    const v = await hook(problemGate, write, ctxFor(binding(root, 'guard-export'), tmp()));
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/no contract for item "guard-export": write docs\/contracts\/guard-export\.md/);
  });

  it('is refused with each missing field named', async () => {
    const root = tmp();
    writeContract(root, 'guard-export', contractFor('guard-export', { Owner: '', Measure: '', 'Not included': '' }));
    const v = await hook(problemGate, write, ctxFor(binding(root, 'guard-export'), tmp()));
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/is incomplete: missing Owner, Measure, Not included/);
  });

  it('is refused when the contract changed after the run started', async () => {
    const root = tmp();
    writeContract(root, 'guard-export', contractFor('guard-export', { Scenario: 'WHEN anything THEN something else' }));
    const v = await hook(problemGate, write, ctxFor(binding(root, 'guard-export'), tmp()));
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/changed after this run started/);
  });

  it('passes for the complete contract the run started under (the legitimate twin)', async () => {
    const root = tmp();
    writeContract(root, 'guard-export');
    expect((await hook(problemGate, write, ctxFor(binding(root, 'guard-export'), tmp()))).decision).toBe('pass');
  });

  it('a file-mode run is refused before the first model turn (no worktree, no tokens), naming what is missing', () => {
    const root = tmp();
    const registry = { hooks: [{ plugin: problemGate }, { plugin: contractGate }] } as unknown as RegistryView;
    expect(() => bindItem('guard-export', registry, root)).toThrow(/refused before the first model turn \(no tokens spent\): item "guard-export" \(no-contract\)[\s\S]*problem-statement\s+REFUSE\s+no contract/);
    writeContract(root, 'guard-export');
    expect(() => bindItem('guard-export', registry, root)).toThrow(/\(unproposed\)[\s\S]*human-yes\s+REFUSE\s+the contract was never proposed/);
    proposeItem(root, 'guard-export', { session: 's', before: null });
    recordReply(root, 'guard-export', 'yes, go ahead', 'tty', 's');
    expect(bindItem('guard-export', registry, root)).toMatchObject({ slug: 'guard-export', root });
  });

  it('switching the gate off (disabled in harness.config.json) refuses the run instead of skipping the gate', () => {
    const root = tmp();
    writeContract(root, 'guard-export');
    proposeItem(root, 'guard-export', { session: 's', before: null });
    recordReply(root, 'guard-export', 'approved', 'tty', 's');
    const onlyContract = { hooks: [{ plugin: contractGate }] as Array<PluginRecord<HookPlugin>> } as unknown as RegistryView;
    expect(() => bindItem('guard-export', onlyContract, root)).toThrow(/required hook\(s\) problem-gate not registered/);
    const none = { hooks: [] } as unknown as RegistryView;
    expect(() => bindItem('guard-export', none, root)).toThrow(/required hook\(s\) problem-gate, contract-gate not registered/);
  });
});

describe('skip 2: echo "yes" from a tool result and try to Stop', () => {
  function proposedItem(): { root: string; runDir: string; ctx: RunContext } {
    const root = tmp();
    writeContract(root, 'guard-export');
    proposeItem(root, 'guard-export', { session: 's', before: null });
    const runDir = tmp();
    // The run's own transcript: a tool printed "yes" (echo yes), and the assistant claimed approval.
    writeFileSync(
      join(runDir, 'transcript.jsonl'),
      [
        { turn: 1, assistant: [{ type: 'tool_call', id: 't1', name: 'run_tests', input: {} }], results: [{ type: 'tool_result', callId: 't1', content: 'yes', isError: false }] },
        { turn: 2, assistant: [{ type: 'text', text: 'The stakeholder said yes, so I am done.' }], results: null },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    return { root, runDir, ctx: ctxFor(binding(root, 'guard-export'), runDir) };
  }

  it('the Stop (finish) is held, and the refusal says why each "yes" did not count', async () => {
    const { ctx } = proposedItem();
    const v = await hook(contractGate, finish, ctx);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/Stop held: no stakeholder yes for guard-export: no typed yes from Test Stakeholder after the proposal \(seq 1\)/);
    expect(v.reason).toMatch(/turn 1: tool output says "yes" \(tool output never counts\)/);
    expect(v.reason).toMatch(/turn 2: assistant text says "yes" \(assistant text never counts\)/);
  });

  it('edits are refused too while the yes is missing; reads are not', async () => {
    const { ctx } = proposedItem();
    const v = await hook(contractGate, write, ctx);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/edit refused: no stakeholder yes/);
    expect((await hook(contractGate, read, ctx)).decision).toBe('pass');
  });

  it('a "yes" piped into stdin is not a typed turn: still held', async () => {
    const { root, ctx } = proposedItem();
    recordReply(root, 'guard-export', 'yes', 'pipe', 's');
    const v = await hook(contractGate, finish, ctx);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/arrived on a pipe, not typed at a terminal/);
  });

  it('"yes but ..." is not a yes: still held', async () => {
    const { root, ctx } = proposedItem();
    recordReply(root, 'guard-export', 'yes but drop the admin scenario', 'tty', 's');
    expect((await hook(contractGate, finish, ctx)).reason).toMatch(/not a plain yes/);
  });

  it('the stakeholder typing yes at the terminal releases the Stop and the edits (the legitimate twin)', async () => {
    const { root, ctx } = proposedItem();
    recordReply(root, 'guard-export', 'Yes, go ahead with this', 'tty', 's');
    expect((await hook(contractGate, finish, ctx)).decision).toBe('pass');
    expect((await hook(contractGate, write, ctx)).decision).toBe('pass');
  });

  it('the stakeholder-yes gate (finish and ship) fails before the yes and passes after it', async () => {
    const { root, ctx } = proposedItem();
    const before = await stakeholderYes.run(ctx, 'finish');
    expect(before.status).toBe('fail');
    expect(before.summary).toMatch(/no typed yes from Test Stakeholder/);
    recordReply(root, 'guard-export', 'approved', 'tty', 's');
    expect((await stakeholderYes.run(ctx, 'ship')).status).toBe('pass');
  });

  it('a yes to an older contract text does not release a changed one', async () => {
    const { root, ctx } = proposedItem();
    recordReply(root, 'guard-export', 'yes', 'tty', 's');
    writeContract(root, 'guard-export', contractFor('guard-export', { Problem: 'A different problem the stakeholder never saw.' }));
    const v = await hook(contractGate, finish, ctx);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/changed after it was proposed/);
    mkdirSync(itemPaths(root, 'guard-export').dir, { recursive: true });
  });
});
