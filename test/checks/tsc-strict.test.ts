import { describe, expect, it } from 'vitest';
import tscStrict, { parseTscOutput } from '../../plugins/checks/tsc-strict.ts';
import type { CheckContext, Exec } from '../../src/core/plugin-api.ts';
import { fixtureContext, lineOf, runCheck } from './_ctx.ts';

const FORMAT = 'src/util/format.ts';

describe('tsc-strict', () => {
  it('good: a single passing (project) finding, 0 errors', async () => {
    const findings = await runCheck(tscStrict, 'good');
    expect(findings).toEqual([{ rule: 'tsc-strict', file: '(project)', status: 'pass', units: { passed: 1, total: 1 }, violations: [] }]);
  });

  it('bad-tsc: type error, any, non-null assertion and @ts-ignore in src, `as any` in test', async () => {
    const findings = await runCheck(tscStrict, 'bad-tsc');
    const format = findings.find((f) => f.file === FORMAT);
    expect(format?.status).toBe('fail');
    const byLine = new Map((format?.violations ?? []).map((v) => [Number(v.location.split(':')[1]), v.message]));
    expect(byLine.get(lineOf('bad-tsc', FORMAT, 'input: any'))).toContain('`any` type');
    expect(byLine.get(lineOf('bad-tsc', FORMAT, 'items[0]!'))).toContain('non-null assertion');
    expect(byLine.get(lineOf('bad-tsc', FORMAT, '@ts-ignore'))).toContain('@ts-ignore');
    expect(byLine.get(lineOf('bad-tsc', FORMAT, "broken: number = 'also"))).toContain('TS2322');
    // the line suppressed by @ts-ignore is not a tsc diagnostic (the directive itself is the violation)
    expect(byLine.has(lineOf('bad-tsc', FORMAT, 'suppressed: number'))).toBe(false);
    expect(format?.violations).toHaveLength(4);
    expect(format?.units).toEqual({ passed: 0, total: 4 });
    const test = findings.find((f) => f.file === 'test/format.test.ts');
    expect(test?.violations.map((v) => v.location)).toEqual([`test/format.test.ts:${lineOf('bad-tsc', 'test/format.test.ts', 'as any')}:26`]);
    const project = findings.find((f) => f.file === '(project)');
    expect(project?.status).toBe('fail');
    // sum(total - passed) == number of errors
    expect(findings.reduce((n, f) => n + f.units.total - f.units.passed, 0)).toBe(5);
  });

  it('is UNPROVEN (skip) when tsc cannot run', async () => {
    const real = await fixtureContext('good');
    const broken: Exec = () => Promise.resolve({ code: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false });
    const ctx: CheckContext = { ...real, exec: broken };
    const findings = await tscStrict.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('skip');
    expect(findings[0]?.skipReason).toContain('tsc could not run');
  });

  it('parses tsc --pretty false output into file and project diagnostics', () => {
    const out = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      '  continuation line',
      '../outside.ts(1,1): error TS1005: x',
      "error TS5058: The specified path does not exist: 'nope'.",
    ].join('\n');
    expect(parseTscOutput(out, '/api')).toEqual([
      { file: 'src/a.ts', location: 'src/a.ts:3:7', message: "TS2322: Type 'string' is not assignable to type 'number'." },
      { file: null, location: '../outside.ts:1:1', message: 'TS1005: x' },
      { file: null, location: '(project)', message: "TS5058: The specified path does not exist: 'nope'." },
    ]);
  });
});
