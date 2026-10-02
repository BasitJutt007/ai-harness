/**
 * Honesty boundary of the run summary: an n/a rule (nothing to check) is listed under
 * notApplicable, never proven; the standards line prints its status as n/a.
 */
import { describe, expect, it } from 'vitest';
import { formatReport } from '../../src/core/checks.ts';
import { formatHonesty, honesty, standardsLine } from '../../src/core/run.ts';
import type { CheckFinding, CheckPlugin } from '../../src/core/types.ts';
import { GREENFIELD } from './fakes.ts';

const check = (id: string, category: string, unit = 'units'): CheckPlugin => ({ kind: 'check', id, category, unit, run: async () => [] });
const pass = (rule: string, n: number): CheckFinding => ({ rule, file: 'src/a.ts', status: 'pass', units: { passed: n, total: n }, violations: [] });

describe('honesty and n/a rules', () => {
  const checks = [check('zod-boundary', 'standards', 'handlers'), check('orm-users-select', 'orm', 'queries'), check('no-console', 'lint', 'files')];
  const report = { root: '/x', findings: [pass('zod-boundary', 3), pass('no-console', 1)], ...formatReport([pass('zod-boundary', 3), pass('no-console', 1)], checks, '/x') };

  it('the rule summary carries status n/a, and the verdict ignores it', () => {
    expect(report.rules.map((r) => [r.rule, r.status])).toEqual([['zod-boundary', 'pass'], ['orm-users-select', 'n/a'], ['no-console', 'pass']]);
    expect(report.verdict).toEqual({ status: 'pass', percent: 100 });
  });

  it('honesty lists an n/a rule under notApplicable, never proven', () => {
    const h = honesty(GREENFIELD, [{ gate: 'standards', status: 'pass', summary: 'ok' }, { gate: 'contract-lock', status: 'n/a', summary: 'n/a' }], report);
    expect(h.proven).toEqual(['gate:standards', 'check:zod-boundary', 'check:no-console']);
    expect(h.notApplicable).toEqual(['gate:contract-lock', 'check:orm-users-select (nothing to check)']);
    expect(h.proven.join(' ')).not.toContain('orm-users-select');
    expect(formatHonesty(h).join('\n')).toMatch(/n\/a\s+gate:contract-lock\n\s+check:orm-users-select \(nothing to check\)/);
  });

  it('the run summary standards line prints n/a for it', () => {
    expect(standardsLine(report, false)).toBe('pass 100%  zod-boundary pass, orm-users-select n/a, no-console pass');
  });

  it('a failing verdict caused only by non-standards rules says the gate is diff-aware for them', () => {
    const fail: CheckFinding = { rule: 'no-console', file: 'src/server.ts', status: 'fail', units: { passed: 0, total: 1 }, violations: [] };
    const r = { root: '/x', findings: [pass('zod-boundary', 3), fail], ...formatReport([pass('zod-boundary', 3), fail], checks, '/x') };
    expect(standardsLine(r, false)).toMatch(/^FAIL 75% {2}zod-boundary pass, orm-users-select n\/a, no-console fail {2}\(only non-standards rules fail/);
  });

  it('a standards rule with 0 units stays unproven (never n/a)', () => {
    const empty = { root: '/x', findings: [], ...formatReport([], [check('zod-boundary', 'standards', 'handlers')], '/x') };
    expect(empty.rules[0]?.status).toBe('unproven');
    expect(honesty(GREENFIELD, [], empty).unproven).toEqual(['check:zod-boundary (0/0 handlers)']);
  });
});
