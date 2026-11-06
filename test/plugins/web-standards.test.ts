/**
 * The standards gate on the generic web profile (stack web, in place): its standards are the repository's own
 * type check and lint. When neither is counted (every one n/a) the gate stays UNPROVEN, fail closed, and says
 * why: "this repository configures no type check or lint the harness can run; a human must verify standards".
 * Paired with the twins that pass (a counted lint or type check), the failure that stays a failure, and the
 * other stacks (file mode), whose all-n/a message is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import standardsGate, { WEB_NO_STANDARDS, WEB_NOTHING_CHECKED } from '../../plugins/gates/standards.ts';
import type { CheckReport, RuleSummary, RunContext, Stack } from '../../src/core/plugin-api.ts';
import { brownfieldTask, makeHarness, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const rule = (id: string, category: string, status: RuleSummary['status']): RuleSummary => ({
  rule: id, category, unit: 'units', status, passed: status === 'pass' ? 1 : 0, total: status === 'n/a' ? 0 : 1, files: status === 'n/a' ? 0 : 1,
});

function report(rules: RuleSummary[]): CheckReport {
  const counted = rules.filter((r) => r.status !== 'n/a');
  const failing = counted.some((r) => r.status === 'fail');
  const findings = counted.filter((r) => r.status === 'fail').map((r) => ({
    rule: r.rule, file: '(project)', status: 'fail' as const, units: { passed: 0, total: 1 }, violations: [{ location: '(project):0:0', message: `${r.rule} failed` }],
  }));
  return {
    root: '/x', findings, rules,
    verdict: { status: counted.length === 0 ? 'unproven' : failing ? 'fail' : 'pass', percent: failing ? 0 : 100 },
    text: 'report', compact: 'report',
  };
}

async function gate(stack: Stack, rules: RuleSummary[], files: Record<string, string> = {}) {
  const h = await makeHarness({ label: 'web-standards', task: brownfieldTask(), files, services: { runChecks: async () => report(rules) } });
  dirs.push(h.dir);
  const ctx: RunContext = { ...h.ctx, stack };
  return standardsGate.run(ctx, 'finish');
}

const NA = [rule('web-typecheck', 'typecheck', 'n/a'), rule('repo-lint', 'lint', 'n/a')];

describe('standards gate, stack web', () => {
  it('every rule n/a in a repository without a tsconfig.json or ESLint config: UNPROVEN with the message', async () => {
    const r = await gate('web', NA, { 'src/a.js': 'export {};\n' });
    expect(r).toMatchObject({ status: 'unproven', summary: WEB_NO_STANDARDS });
    expect(r.humanMustVerify?.[0]).toBe(WEB_NO_STANDARDS);
  });

  it('a build that passes does not stand in for a type check or lint: still UNPROVEN', async () => {
    const r = await gate('web', [...NA, rule('web-build', 'build', 'pass')], { 'src/a.js': 'export {};\n' });
    expect(r).toMatchObject({ status: 'unproven', summary: WEB_NO_STANDARDS });
  });

  it('a repository that configures lint, which had nothing to check in this change: UNPROVEN, saying so', async () => {
    const r = await gate('web', NA, { 'eslint.config.js': 'export default [];\n' });
    expect(r).toMatchObject({ status: 'unproven', summary: WEB_NOTHING_CHECKED });
  });

  it('the twin: a counted lint (or type check) that passes is a pass', async () => {
    expect(await gate('web', [rule('web-typecheck', 'typecheck', 'n/a'), rule('repo-lint', 'lint', 'pass')])).toMatchObject({ status: 'pass' });
    expect(await gate('web', [rule('web-typecheck', 'typecheck', 'pass'), rule('repo-lint', 'lint', 'n/a')])).toMatchObject({ status: 'pass' });
  });

  it('a failing build stays a failure, whatever the lint did', async () => {
    expect((await gate('web', [...NA, rule('web-build', 'build', 'fail')])).status).toBe('fail');
  });

  it('other stacks (file mode) keep their every-rule-n/a message (the twin)', async () => {
    expect(await gate('react-vite', NA)).toMatchObject({ status: 'unproven', summary: 'every rule was n/a (2): nothing is proven' });
    expect(await gate('express', [rule('tsc-strict', 'standards', 'pass'), rule('repo-lint', 'lint', 'n/a')])).toMatchObject({ status: 'pass' });
  });
});
