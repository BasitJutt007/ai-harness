import { describe, expect, it } from 'vitest';
import tscStrict from '../../plugins/checks/tsc-strict.ts';
import type { CheckContext, Exec } from '../../src/core/plugin-api.ts';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contextFor, fixtureContext, lineOf, memoryLogs, runCheck, tempApi } from './_ctx.ts';

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

  it('second review round (13): `any` laundered without the keyword is found by the type checker in src/', async () => {
    const root = await tempApi({
      'src/lib/loose.ts': [
        'export type Loose = ReturnType<typeof JSON.parse>;',
        'export function shout(input: Loose): string { return input.deeply.nested.call(42).toUpperCase(); }',
        'export const parsed = JSON.parse(\'{"a":1}\');',
        'export const typed: unknown = JSON.parse(\'{"a":1}\');',
        '',
      ].join('\n'),
    });
    try {
      const findings = await tscStrict.run(await contextFor(root));
      const loose = findings.find((f) => f.file === 'src/lib/loose.ts');
      expect(loose?.status).toBe('fail');
      const lines = (loose?.violations ?? []).map((v) => Number(v.location.split(':')[1]));
      expect(lines).toEqual([1, 2, 3]); // `unknown`-annotated JSON.parse (line 4) is the allowed pattern
      expect(loose?.violations[0]?.message).toContain('type Loose has type `any`');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs in-process: a broken exec changes nothing (no tsc binary to fail), and the run is logged', async () => {
    const real = await fixtureContext('bad-tsc');
    const broken: Exec = () => Promise.resolve({ code: null, stdout: '', stderr: 'spawn ENOENT', durationMs: 1, timedOut: false });
    const logs = memoryLogs();
    const ctx: CheckContext = { ...real, exec: broken, logs };
    const findings = await tscStrict.run(ctx);
    expect(findings.find((f) => f.file === '(project)')?.status).toBe('fail');
    expect(findings.reduce((n, f) => n + f.units.total - f.units.passed, 0)).toBe(5);
    const log = logs.entries.get('tsc-strict.txt') ?? '';
    expect(log).toContain('--strict --noImplicitAny --strictNullChecks');
    expect(log).toContain('project tsconfig.json (primary');
    expect(log).toContain('files: 12, errors: 5');
  });

  it('is UNPROVEN (skip, with the reason) when the tsconfig cannot be read, never a pass', async () => {
    const root = await tempApi({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await writeFile(join(root, 'tsconfig.json'), '{ "extends": "./missing-base.json" }');
      const findings = await tscStrict.run(await contextFor(root));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.status).toBe('skip');
      expect(findings[0]?.skipReason).toContain('unusable TypeScript configuration: tsconfig.json: TS5083');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
