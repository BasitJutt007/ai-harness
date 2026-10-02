/**
 * Every fixture against every standards check: the good fixtures are 100% green,
 * and each bad fixture fails ONLY the rule it targets.
 */
import { describe, expect, it } from 'vitest';
import problemJson from '../../plugins/checks/problem-json.ts';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import tscStrict from '../../plugins/checks/tsc-strict.ts';
import zodBoundary from '../../plugins/checks/zod-boundary.ts';
import { formatReport } from '../../src/core/checks.ts';
import type { CheckFinding, CheckPlugin } from '../../src/core/plugin-api.ts';
import { fixtureContext, runCheck } from './_ctx.ts';

const CHECKS: CheckPlugin[] = [zodBoundary, problemJson, tscStrict, restConventions];
const TARGET: Record<string, string> = {
  'bad-zod': 'zod-boundary',
  'bad-problem': 'problem-json',
  'bad-tsc': 'tsc-strict',
  'bad-rest': 'rest-conventions',
};

async function all(fixture: string): Promise<CheckFinding[]> {
  const out: CheckFinding[] = [];
  for (const c of CHECKS) out.push(...(await runCheck(c, fixture)));
  return out;
}

describe('standards checks: plugin shape', () => {
  it.each(CHECKS.map((c) => [c.id, c] as const))('%s is a well-formed standards check', (_id, c) => {
    expect(c.kind).toBe('check');
    expect(c.category).toBe('standards');
    const description = c.description ?? '';
    const doc = c.doc ?? '';
    expect(description.length).toBeGreaterThan(20);
    expect(description).not.toContain('\n');
    const lines = doc.split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(10);
    expect(lines).toBeLessThanOrEqual(32);
    expect(doc.toLowerCase()).toContain('passing example');
    expect(doc).not.toMatch(/claude|anthropic|openai|gpt/i);
  });
});

describe.each(['good', 'mounted'])('fixture %s', (fixture) => {
  it('passes every standards rule at 100%', async () => {
    const findings = await all(fixture);
    const failing = findings.filter((f) => f.status !== 'pass');
    expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
    const ctx = await fixtureContext(fixture);
    const report = formatReport(findings, CHECKS, ctx.root);
    expect(report.verdict).toEqual({ status: 'pass', percent: 100 });
    for (const r of report.rules) expect(r.status).toBe('pass');
  });
});

describe.each(Object.entries(TARGET))('fixture %s', (fixture, target) => {
  it(`fails ${target} and nothing else`, async () => {
    const findings = await all(fixture);
    const byRule = new Map<string, CheckFinding[]>();
    for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    for (const c of CHECKS) {
      const fs = byRule.get(c.id) ?? [];
      const bad = fs.filter((f) => f.status !== 'pass');
      if (c.id === target) {
        expect(bad.length, `${c.id} should fail on ${fixture}`).toBeGreaterThan(0);
        expect(bad.every((f) => f.status === 'fail')).toBe(true);
      } else {
        expect(bad, `${c.id} should pass on ${fixture}: ${JSON.stringify(bad)}`).toEqual([]);
      }
    }
    const ctx = await fixtureContext(fixture);
    const report = formatReport(findings, CHECKS, ctx.root);
    expect(report.verdict.status).toBe('fail');
    expect(report.rules.filter((r) => r.status !== 'pass').map((r) => r.rule)).toEqual([target]);
  });
});
