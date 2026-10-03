/**
 * False-fail hunt: realistic, compliant users APIs written the way different models write
 * them (async handlers, safeParse, mounted routers, default exports, controllers, handler
 * factories, toDto helpers, route chains, problem subclasses, custom problem middleware …),
 * each assembled on the greenfield template. Every one must read 100% on all four rules,
 * runtime probes included.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatReport } from '../../src/core/checks.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';
import { contextFor } from './_ctx.ts';
import { STANDARD_CHECKS, assembleVariant, removeVariant, variantNames } from './_variants.ts';

const COMPLIANT = variantNames('ok-');

describe('compliant variants', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await removeVariant(r);
  });

  it('there are at least 8 of them', () => {
    expect(COMPLIANT.length).toBeGreaterThanOrEqual(8);
  });

  it.concurrent.each(COMPLIANT)('%s reads 100% on every standards rule', async (name) => {
    const root = await assembleVariant(name);
    roots.push(root);
    const ctx = await contextFor(root);
    const findings: CheckFinding[] = [];
    for (const c of STANDARD_CHECKS) findings.push(...(await c.run(ctx)));
    const report = formatReport(findings, STANDARD_CHECKS, root);
    expect(findings.filter((f) => f.status !== 'pass'), report.compact).toEqual([]);
    expect(report.verdict, report.compact).toEqual({ status: 'pass', percent: 100 });
    const byRule = new Map(report.rules.map((r) => [r.rule, r]));
    // the users resource: 5 handlers and 5 routes, and the runtime probes really ran
    expect(byRule.get('zod-boundary')).toMatchObject({ status: 'pass', passed: 5, total: 5 });
    expect(byRule.get('rest-conventions')).toMatchObject({ status: 'pass', passed: 5, total: 5 });
    // 11 probes: the 10 of before plus POST /v1/users without Idempotency-Key (must still be a problem)
    expect(findings.find((f) => f.rule === 'problem-json' && f.file === '(runtime)')?.units).toEqual({ passed: 11, total: 11 });
  });
});
