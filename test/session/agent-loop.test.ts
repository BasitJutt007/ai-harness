/**
 * The agent loop of a session on a repository with debt (the real standards gate, baseline mode, over two
 * content-driven lint rules; every other required gate a stand-in). Each case with its twin:
 *   - the verdict block says what blocks first (the finding the run introduced, wrapped, never clipped
 *     away), and "a human must verify" counts the pre-existing findings per rule instead of listing them;
 *     with nothing introduced, no standards reason at all;
 *   - a turn that ends without finish on a NOT DONE the agent can act on continues by itself with the
 *     verdict's reasons, and the agent's fix ends in "Work completed"; never on UNPROVEN, with a proposal
 *     pending, without progress, past the limit (read-only, Ctrl-C, the budget and the spend cap: the
 *     decision's own twins);
 *   - the same pre-tool refusal four times in one owner message ends the turn and tells the owner the
 *     agent is stuck; three and then progress goes on; refusals for other paths or reasons never add up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import standardsGate from '../../plugins/gates/standards.ts';
import type { CheckFinding, CheckPlugin, GateStatus, RegistryView, RunEvent } from '../../src/core/types.ts';
import { AUTO_CONTINUE_LIMIT, autoContinue, continueMessage, preToolRefusal, RefusalCounter, STUCK_REFUSALS, type ContinueState } from '../../src/session/session.ts';
import { WORK_COMPLETED } from '../../src/session/ui.ts';
import { calls, proposal, realRegistry, registryWithGates, REQUIRED_STANDINS, gate, runScripted, TEST_BODY, text, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo | undefined;
afterEach(() => r?.cleanup());

const TEST_FILE = 'test/greeting-name.test.ts';

/** A lint rule over every source and test file: each line containing `marker` is a violation. */
function markerRule(id: string, marker: string, message: string): CheckPlugin {
  return {
    kind: 'check', id, category: 'lint', unit: 'files',
    async run(ctx) {
      const out: CheckFinding[] = [];
      for (const file of [...ctx.sourceFiles, ...ctx.testFiles]) {
        const violations = (await ctx.read(file)).split('\n').flatMap((line, i) =>
          line.includes(marker) ? [{ location: `${file}:${i + 1}:${line.indexOf(marker) + 1}`, message }] : []);
        out.push({ rule: id, file, status: violations.length > 0 ? 'fail' : 'pass', units: { passed: violations.length > 0 ? 0 : 1, total: 1 }, violations });
      }
      return out;
    },
  };
}

const RULES = [markerRule('no-todo', 'TODO', 'TODO comment'), markerRule('no-debugger', 'debugger', 'debugger statement')];

/** Debt the session finds and never touches: 30 TODO comments in three files, 4 debugger statements in two. */
const DEBT: Record<string, string> = {
  'src/legacy/a.ts': `${Array.from({ length: 12 }, (_, i) => `// TODO: legacy item a${i}`).join('\n')}\nexport function a(): void {\n  debugger;\n  debugger;\n}\n`,
  'src/legacy/b.ts': `${Array.from({ length: 10 }, (_, i) => `// TODO: legacy item b${i}`).join('\n')}\nexport function b(): void {\n  debugger;\n  debugger;\n}\n`,
  'src/legacy/c.ts': `${Array.from({ length: 8 }, (_, i) => `// TODO: legacy item c${i}`).join('\n')}\nexport const c = 1;\n`,
};

/** The real tools and hooks, the real standards gate over RULES, and stand-ins for the other required gates. */
async function registry(statuses: Record<string, GateStatus> = {}): Promise<RegistryView> {
  const real = await realRegistry();
  return {
    ...real,
    gates: REQUIRED_STANDINS.map((g) => (g === 'standards' ? { plugin: standardsGate, file: 'plugins/gates/standards.ts', sha256: '0'.repeat(64) } : gate(g, statuses[g] ?? 'pass'))),
    checks: RULES.map((plugin) => ({ plugin, file: `test/${plugin.id}.ts`, sha256: '0'.repeat(64) })),
  };
}

const WITH_TODO = `${TEST_BODY}// TODO: cover an empty name\n`;

describe('a verdict the owner can read', () => {
  it('one introduced finding among 34 pre-existing ones: the reason names it first and wraps; one count line per rule, no pre-existing finding listed', async () => {
    r = webRepo({ extra: DEBT });
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: WITH_TODO }]),
      text('Test written.'),
      text('I will leave it there.'),
    ], ['fix the greeting', 'yes'], { registry: await registry() });
    const block = ran.out.slice(ran.out.indexOf('the turn changed the working tree'));
    expect(block).toMatch(/✗ NOT DONE: the gates, not the model, decide/);
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.startsWith('  - gate standards failed: '));
    expect(at).toBeGreaterThan(-1);
    // What blocks comes first, then the rest of the reason on indented continuation rows: nothing that matters is clipped.
    expect(lines[at]).toMatch(/^ {2}- gate standards failed: 2 introduced by this run: no-todo test\/greeting-name\.test\.ts:8:4/);
    const rows = [lines[at] ?? ''];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith('    ') || l.startsWith('    · ')) break;
      rows.push(l);
    }
    expect(rows.length).toBeGreaterThan(1);
    const reason = rows.map((l) => l.trim()).join(' ');
    expect(reason).toMatch(/^- gate standards failed: 2 introduced by this run: no-todo test\/greeting-name\.test\.ts:8:4 TODO comment; baseline mode: below 100% allowed; verdict \d+% over the whole API \(brownfield: 34 pre-existing violation\(s\) in untouched files; base commit \d+%\)$/);
    for (const l of lines.filter((x) => x.startsWith('  - ') || x.startsWith('    '))) expect(l.length, l).toBeLessThanOrEqual(100);
    // A human must verify: one line per rule with its count, none per finding.
    expect(block).toContain('    · gate:standards: pre-existing (not blocking): no-todo 30 in 3 files');
    expect(block).toContain('    · gate:standards: pre-existing (not blocking): no-debugger 4 in 2 files');
    expect(block).not.toMatch(/pre-existing \(not blocking[^)]*\): no-todo src\/legacy/);
    expect(block).not.toMatch(/pre-existing \(not blocking[^)]*\): no-debugger src\/legacy/);
    // The records keep every finding: run.json's honesty still lists them one by one.
    const v = (ran.runJson['verdicts'] as Array<{ honesty: { humanMustVerify: string[] } }>).at(-1);
    expect(v?.honesty.humanMustVerify.filter((h) => h.startsWith('gate:standards: pre-existing (not blocking): no-todo src/legacy/')).length).toBeGreaterThan(10);
  });

  it('twin: nothing introduced: no standards reason, and the pre-existing findings are still one count line per rule', async () => {
    r = webRepo({ extra: DEBT });
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
      text('Test written.'),
    ], ['fix the greeting', 'yes'], { registry: await registry({ scope: 'fail' }) });
    const block = ran.out.slice(ran.out.indexOf('the turn changed the working tree'));
    expect(block).toMatch(/✗ NOT DONE/);
    expect(block).toContain('  - gate scope failed: scope says fail (test stand-in)');
    expect(block).not.toMatch(/gate standards (failed|UNPROVEN)/);
    expect(block).toMatch(/standards\s+pass\s+baseline mode: below 100% allowed; verdict/);
    expect(block).toContain('    · gate:standards: pre-existing (not blocking): no-todo 30 in 3 files');
    expect(block).not.toMatch(/pre-existing \(not blocking[^)]*\): no-todo src\/legacy/);
    expect(block).not.toContain(WORK_COMPLETED);
  });
});

/** The model's requests, as text: what it was told. */
const told = (requests: Array<{ messages: unknown }>, i: number): string => JSON.stringify(requests[i]?.messages ?? []);
const CONTINUED = (n: number): string => `↻ the gates said NOT DONE: the agent continues (${n}/${AUTO_CONTINUE_LIMIT})`;

describe('a bounded auto-continue', () => {
  it('an introduced lint finding: the turn continues by itself with what blocks; the agent fixes it and calls finish: "Work completed"', async () => {
    r = webRepo({ extra: DEBT });
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: WITH_TODO }]),
      text('Test written.'),
      calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
      calls(['finish', { summary: 'test added, TODO removed' }]),
      text('never asked'),
    ], ['fix the greeting', 'yes'], { registry: await registry() });
    expect(ran.out).toContain(CONTINUED(1));
    expect(ran.out.indexOf(CONTINUED(1))).toBeLessThan(ran.out.indexOf(WORK_COMPLETED));
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.driver.used).toBe(5);
    // The model heard the verdict's reasons and the finding itself, in the same owner message (no new owner line).
    const continued = told(ran.driver.requests, 3);
    expect(continued).toContain('[harness] You ended your turn without calling finish, and the fresh run of every required gate says NOT DONE:');
    expect(continued).toContain('- gate standards failed: 2 introduced by this run: no-todo test/greeting-name.test.ts:8:4 TODO comment');
    expect(continued).toContain('  introduced (in a file this run changed): no-todo test/greeting-name.test.ts:8:4 TODO comment');
    expect(continued).toContain('Fix these and call finish, or tell the owner plainly why you cannot.');
    expect(continued).not.toMatch(/pre-existing \(not blocking[^)]*\): no-todo src\/legacy/);
    const verdicts = ran.runJson['verdicts'] as Array<Record<string, unknown>>;
    expect(verdicts.map((v) => [v['trigger'], v['kind']])).toEqual([['turn', 'NOT DONE'], ['finish', 'DONE']]);
    expect(ran.runJson['lastVerdict']).toBe('DONE');
  });

  it('twin: an UNPROVEN verdict never continues (the prompt comes back)', async () => {
    r = webRepo({ extra: DEBT });
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
      text('Test written.'),
      text('never asked'),
    ], ['fix the greeting', 'yes'], { registry: await registry({ 'observed-red': 'unproven' }) });
    expect(ran.out).toMatch(/\? UNPROVEN: the gates, not the model, decide/);
    expect(ran.out).not.toContain('↻');
    expect(ran.driver.used).toBe(3);
  });

  it('twin: a NOT DONE with a proposal awaiting its reply never continues; the reply prompt comes back', async () => {
    r = webRepo({ extra: DEBT });
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: WITH_TODO }], ['propose_contract', proposal({ problem: 'The greeting ignores names with spaces too.' })]),
      text('never asked'),
    ], ['fix the greeting', 'yes'], { registry: await registry() });
    expect(ran.out).toMatch(/✗ NOT DONE/);
    expect(ran.out).toContain('gate standards failed: 2 introduced by this run');
    expect(ran.out).not.toContain('↻');
    expect(ran.driver.used).toBe(2);
    expect(ran.input.prompts.at(-1)).toBe('reply › ');
  });

  it('twin: the same reasons after a continue (no progress): it stops after one, and says why', async () => {
    r = webRepo();
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
      text('Test written.'),
      calls(['write_file', { path: 'test/greeting-again.test.ts', content: TEST_BODY.replace('Ada by name', 'Ada again') }]),
      text('Another test written.'),
      text('never asked'),
    ], ['fix the greeting', 'yes'], { registry: await registry({ 'tests-green': 'fail' }) });
    expect(ran.out.split(CONTINUED(1))).toHaveLength(2);
    expect(ran.out).not.toContain(CONTINUED(2));
    expect(ran.out).toContain('↻ not continued: the gates give the same reasons as before the last continue (no progress); back to you');
    expect(ran.driver.used).toBe(5);
    expect(existsSync(join(r.repo, 'test/greeting-again.test.ts'))).toBe(true);
  });

  it(`twin: past ${AUTO_CONTINUE_LIMIT} continues it stops, though the reasons change each time; the prompt comes back with the verdict`, async () => {
    r = webRepo();
    const reg = await registry();
    let runs = 0;
    const moving = gate('tests-green');
    moving.plugin.run = async () => ({ status: 'fail', summary: `${(runs += 1)} test(s) failing (test stand-in)` });
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
      text('Test written.'),
      calls(['write_file', { path: 'test/a.test.ts', content: TEST_BODY }]),
      text('Second try.'),
      calls(['write_file', { path: 'test/b.test.ts', content: TEST_BODY }]),
      text('Third try.'),
      text('never asked'),
    ], ['fix the greeting', 'yes'], { registry: { ...reg, gates: reg.gates.map((g) => (g.plugin.name === 'tests-green' ? moving : g)) } });
    expect(ran.out).toContain(CONTINUED(1));
    expect(ran.out).toContain(CONTINUED(2));
    expect(ran.out).not.toContain('(3/2)');
    expect(ran.out).toContain(`↻ not continued: the gates still say NOT DONE after ${AUTO_CONTINUE_LIMIT} automatic continues; back to you`);
    expect(ran.driver.used).toBe(7);
    expect((ran.runJson['verdicts'] as unknown[]).length).toBe(3);
    expect(ran.runJson['lastVerdict']).toBe('NOT DONE');
  });
});

describe('when a message continues by itself (the decision)', () => {
  const failing = { gate: 'standards', status: 'fail' as const, summary: '1 introduced by this run: no-todo x.ts:1:1 TODO comment' };
  const verdict: NonNullable<ContinueState['verdict']> = { kind: 'NOT DONE', trigger: 'turn', reasons: [`gate standards failed: ${failing.summary}`], gates: [failing, { gate: 'scope', status: 'pass', summary: 'ok' }] };
  const go: ContinueState = { status: 'yielded', verdict, pending: false, writable: true, stopped: false, interrupted: false, done: 0, previous: null, turnsLeft: 30, spend: null };

  it('an actionable NOT DONE after a turn that changed the tree continues', () => {
    expect(autoContinue(go)).toEqual({ go: true, key: `gate standards failed: ${failing.summary}` });
    expect(autoContinue({ ...go, done: AUTO_CONTINUE_LIMIT - 1, previous: 'other reasons' }).go).toBe(true);
    for (const g of ['tests-green', 'observed-red']) {
      expect(autoContinue({ ...go, verdict: { ...verdict, reasons: [`gate ${g} failed: x`], gates: [{ gate: g, status: 'fail', summary: 'x' }] } }).go, g).toBe(true);
    }
  });

  it('each twin that must never continue', () => {
    const twins: Array<[string, Partial<ContinueState>, RegExp, boolean]> = [
      ['finish was called', { status: 'done' }, /turn ended done/, false],
      ['the turn budget ran out in the loop', { status: 'max_turns' }, /turn ended max_turns/, false],
      ['the spend cap stopped the loop', { status: 'spend_cap' }, /turn ended spend_cap/, false],
      ['Ctrl-C', { status: 'aborted' }, /turn ended aborted/, false],
      ['Ctrl-C during the gates', { interrupted: true }, /Ctrl-C/, false],
      ['a proposal awaits its reply', { pending: true }, /proposal awaits/, false],
      ['read-only', { writable: false }, /read-only/, false],
      ['the harness ended the turn', { stopped: true }, /harness ended the turn/, false],
      ['no verdict (nothing changed)', { verdict: null }, /changed nothing/, false],
      ['a verdict the owner asked for', { verdict: { ...verdict, trigger: 'gates' } }, /changed nothing/, false],
      ['UNPROVEN', { verdict: { ...verdict, kind: 'UNPROVEN', gates: [{ gate: 'standards', status: 'unproven', summary: 'x' }], reasons: ['gate standards UNPROVEN: x'] } }, /verdict is UNPROVEN/, false],
      ['NOT DONE with an UNPROVEN gate too (a missing runner)', { verdict: { ...verdict, reasons: [...verdict.reasons, 'gate tests-green UNPROVEN: no runner'], gates: [failing, { gate: 'tests-green', status: 'unproven', summary: 'no runner' }] } }, /cannot act on/, false],
      ['NOT DONE with the environment (no sandbox)', { verdict: { ...verdict, reasons: [...verdict.reasons, 'isolation: none'] } }, /cannot act on/, false],
      ['a gate the agent does not fix by itself', { verdict: { ...verdict, reasons: ['gate scope failed: x'], gates: [{ gate: 'scope', status: 'fail', summary: 'x' }] } }, /gate scope failed/, false],
      ['the limit', { done: AUTO_CONTINUE_LIMIT, previous: 'other' }, /after 2 automatic continues/, true],
      ['no progress', { done: 1, previous: `gate standards failed: ${failing.summary}` }, /same reasons/, true],
      ['no turn left', { turnsLeft: 0 }, /turn budget/, true],
      ['the spend cap', { spend: 'spend cap: the next request could pass the cap' }, /spend cap/, true],
    ];
    for (const [what, over, why, tell] of twins) {
      const d = autoContinue({ ...go, ...over });
      expect(d.go, what).toBe(false);
      if (d.go) continue;
      expect(d.why, what).toMatch(why);
      expect(d.tell, what).toBe(tell);
    }
  });

  it('the message hands over the reasons and what blocks, never the pre-existing findings', () => {
    const m = continueMessage({
      reasons: ['gate standards failed: 1 introduced by this run: no-todo x.ts:1:1 TODO comment'],
      gates: [
        { gate: 'standards', status: 'fail', summary: 's', details: ['introduced (in a file this run changed): no-todo x.ts:1:1  TODO comment', 'pre-existing (not blocking): no-todo old.ts:1:1  TODO comment', '… 40 more (see the log)'] },
        { gate: 'scope', status: 'pass', summary: 'ok', details: ['passing detail'] },
      ],
    }, 1);
    expect(m).toContain('- gate standards failed: 1 introduced by this run');
    expect(m).toContain('gate standards:\n  introduced (in a file this run changed): no-todo x.ts:1:1 TODO comment');
    expect(m).not.toContain('old.ts');
    expect(m).not.toContain('40 more');
    expect(m).not.toContain('passing detail');
    expect(m).toMatch(/Fix these and call finish, or tell the owner plainly why you cannot\. \(The harness continued this message by itself: 1 of at most 2\.\)$/);
  });
});

const refuse = (path: string) => calls(['write_file', { path, content: '{}\n' }]);
const STUCK = /⚠ the agent is stuck: path-guard refused package\.json 4 times: package\.json is harness-owned in place \(supply chain: [^\n]*\)\. Tell it what to do differently, or \/exit\./;

describe('a stuck detector', () => {
  it(`the same refusal (hook, path, reason) ${STUCK_REFUSALS} times ends the turn; the owner is told, and the model hears it with the next message`, async () => {
    r = webRepo();
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      refuse('package.json'), refuse('package.json'), refuse('package.json'), refuse('package.json'),
      text('I keep hitting the same refusal.'),
    ], ['fix the greeting', 'yes', 'what happened?'], { registry: await registryWithGates() });
    expect(ran.out).toMatch(STUCK);
    expect(ran.out.split('✗ BLOCKED by path-guard: package.json is harness-owned in place')).toHaveLength(5);
    // The turn ended at the fourth: the next request is the owner's next message, with the harness note.
    expect(ran.driver.used).toBe(6);
    const next = told(ran.driver.requests, 5);
    expect(next).toContain('what happened?');
    expect(next).toContain('[harness] Your last turn was ended by the harness: path-guard refused package.json 4 times with the same reason');
    expect(readFileSync(join(ran.dir, 'events.jsonl'), 'utf8')).toContain('"source":"stuck"');
  });

  it('twin: three identical refusals, then progress: the turn goes on', async () => {
    r = webRepo();
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      refuse('package.json'), refuse('package.json'), refuse('package.json'),
      calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
      text('Wrote the test instead.'),
    ], ['fix the greeting', 'yes'], { registry: await registryWithGates() });
    expect(ran.out).not.toContain('the agent is stuck');
    expect(ran.driver.used).toBe(6);
    expect(existsSync(join(r.repo, TEST_FILE))).toBe(true);
  });

  it('twin: refusals for different paths (so different reasons) do not add up, though the hook is the same', async () => {
    r = webRepo();
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      refuse('package.json'), refuse('tsconfig.json'), refuse('package.json'), refuse('tsconfig.json'), refuse('package.json'),
      text('Both are off limits.'),
    ], ['fix the greeting', 'yes'], { registry: await registryWithGates() });
    expect(ran.out.split('✗ BLOCKED by path-guard:')).toHaveLength(6);
    expect(ran.out).not.toContain('the agent is stuck');
    expect(ran.driver.used).toBe(7);
  });

  it('twin: the count is per owner message: two refusals in one message and two in the next are not stuck', async () => {
    r = webRepo();
    const ran = await runScripted(r, [
      calls(['propose_contract', proposal()]),
      refuse('package.json'), refuse('package.json'), text('That file is off limits.'),
      refuse('package.json'), refuse('package.json'), text('Still off limits.'),
    ], ['fix the greeting', 'yes', 'try once more'], { registry: await registryWithGates() });
    expect(ran.out.split('✗ BLOCKED by path-guard: package.json')).toHaveLength(5);
    expect(ran.out).not.toContain('the agent is stuck');
    expect(ran.driver.used).toBe(7);
  });

  it('the count is per key: another path or another reason counts on its own and resets nothing; only pre-tool hook blocks count', () => {
    const c = new RefusalCounter();
    const a = { hook: 'observed-red', path: 'src/a.tsx', reason: 'edit refused: no observed red for src/a.tsx' };
    expect([c.add(a), c.add(a), c.add(a)]).toEqual([1, 2, 3]);
    expect(c.add({ ...a, reason: 'edit refused: another reason' })).toBe(1);
    expect(c.add({ ...a, path: 'src/b.tsx' })).toBe(1);
    expect(c.add({ ...a, hook: 'path-guard' })).toBe(1);
    expect(c.add(a)).toBe(4);
    c.clear();
    expect(c.add(a)).toBe(1);
    const ev = (e: Partial<RunEvent>): RunEvent => ({ turn: 1, at: '', kind: 'hook', source: 'path-guard', decision: 'block', message: 'path-guard: x is harness-owned', data: { event: 'pre_tool', tool: 'write_file', callId: 'c', paths: ['x'] }, ...e });
    expect(preToolRefusal(ev({}))).toEqual({ hook: 'path-guard', path: 'x', reason: 'x is harness-owned' });
    expect(preToolRefusal(ev({ data: { event: 'pre_tool', paths: [] } }))?.path).toBe('(no path)');
    expect(preToolRefusal(ev({ decision: 'record' }))).toBeNull();
    expect(preToolRefusal(ev({ data: { event: 'post_tool', paths: ['x'] } }))).toBeNull();
    expect(preToolRefusal(ev({ kind: 'tool' }))).toBeNull();
  });
});
