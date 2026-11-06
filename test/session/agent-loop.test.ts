/**
 * The agent loop of a session on a repository with debt (the real standards gate, baseline mode, over two
 * content-driven lint rules; every other required gate a stand-in). Each case with its twin:
 *   - the verdict block says what blocks first (the finding the run introduced, wrapped, never clipped
 *     away), and "a human must verify" counts the pre-existing findings per rule instead of listing them;
 *     with nothing introduced, no standards reason at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import standardsGate from '../../plugins/gates/standards.ts';
import type { CheckFinding, CheckPlugin, GateStatus, RegistryView } from '../../src/core/types.ts';
import { WORK_COMPLETED } from '../../src/session/ui.ts';
import { calls, proposal, realRegistry, REQUIRED_STANDINS, gate, runScripted, TEST_BODY, text, webRepo, type WebRepo } from './helpers.ts';

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
