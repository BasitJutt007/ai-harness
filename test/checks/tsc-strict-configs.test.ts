/**
 * tsc-strict over many tsconfig shapes and API layouts (property-style tables).
 *
 * Every row is a small generated API. A planted violation must FAIL (or be UNPROVEN when the
 * configuration is unusable); the same API without it must pass. For the strict sub-flag table a
 * control compile with the API's OWN options proves the tsconfig really relaxes the rule, so the FAIL
 * comes from the forced flags and not from the tsconfig.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import tscStrict from '../../plugins/checks/tsc-strict.ts';
import { formatReport } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { FORCED_STRICT } from '../../src/core/typecheck.ts';
import type { CheckContext, CheckFinding, RuleSummary } from '../../src/core/plugin-api.ts';
import { contextFor, memoryLogs } from './_ctx.ts';

type Files = Record<string, string>;

const BASE = join(HARNESS_ROOT, '.harness', 'tmp', `tsc-configs-${process.pid}-${randomBytes(4).toString('hex')}`);
let n = 0;
afterAll(async () => {
  await rm(BASE, { recursive: true, force: true });
});

async function api(files: Files): Promise<string> {
  const root = join(BASE, `api-${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content, 'utf8');
  }
  return root;
}

interface Outcome {
  status: RuleSummary['status'];
  findings: CheckFinding[];
  /** "file  message" for every violation. */
  lines: string[];
  reason: string;
  log: string;
}

async function check(files: Files): Promise<Outcome> {
  const root = await api(files);
  const logs = memoryLogs();
  const ctx = { ...(await contextFor(root)), logs };
  const findings = await tscStrict.run(ctx);
  const report = formatReport(findings, [tscStrict], root);
  return {
    status: report.rules[0]?.status ?? 'n/a',
    findings,
    lines: findings.flatMap((f) => f.violations.map((v) => `${v.location}  ${v.message}`)),
    reason: findings.find((f) => f.status === 'skip')?.skipReason ?? '',
    log: logs.entries.get('tsc-strict.txt') ?? '',
  };
}

const OPTIONS = {
  target: 'ES2023',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  lib: ['ES2023'],
  types: [],
  strict: true,
  noUncheckedIndexedAccess: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
};
const tsconfig = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = { include: ['src', 'test'] }): string =>
  JSON.stringify({ compilerOptions: { ...OPTIONS, ...extra }, ...top }, null, 2);
const pkg = (extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'variant', private: true, type: 'module', ...extra });

/** A clean API: every row adds a config and/or a planted file to it. */
const CLEAN: Files = {
  'package.json': pkg(),
  'tsconfig.json': tsconfig(),
  'src/index.ts': "import { label } from './util/label.ts';\nexport function describeAll(items: ReadonlyArray<{ name: string }>): string {\n  return items.map((i) => label(i.name)).join(',');\n}\n",
  'src/util/label.ts': 'export function label(name: string): string {\n  return name.toUpperCase();\n}\n',
  'test/index.test.ts': "import { describeAll } from '../src/index.ts';\nexport const out: string = describeAll([{ name: 'a' }]);\n",
};

/** Planted violations. */
const INDEX = 'export function firstName(xs: ReadonlyArray<{ name: string }>): string {\n  const x = xs[0];\n  return x.name;\n}\n';
const WRONG = "export const count: number = 'not a number';\n";
const ANY = 'export function loose(v: any): unknown {\n  return v;\n}\n';

describe('tsc-strict: every strict sub-flag is forced, whatever the tsconfig says', () => {
  const rows: Array<{ flag: string; code: string; snippet: string; extra?: Record<string, unknown> }> = [
    { flag: 'strict', code: 'TS18048', snippet: INDEX },
    { flag: 'strictNullChecks', code: 'TS18048', snippet: INDEX },
    { flag: 'noUncheckedIndexedAccess', code: 'TS18048', snippet: INDEX },
    { flag: 'noImplicitAny', code: 'TS7006', snippet: 'export function echo(a) {\n  return a;\n}\n' },
    { flag: 'strictFunctionTypes', code: 'TS2322', snippet: 'export const h: (x: string | number) => void = (x: string): void => {\n  void x;\n};\n' },
    { flag: 'strictBindCallApply', code: 'TS2345', snippet: "function k(a: number): number {\n  return a;\n}\nexport const r = k.call(undefined, 'x');\n" },
    { flag: 'strictPropertyInitialization', code: 'TS2564', snippet: 'export class Named {\n  name: string;\n}\n' },
    { flag: 'noImplicitThis', code: 'TS2683', snippet: 'export function self(): unknown {\n  return this;\n}\n' },
    { flag: 'useUnknownInCatchVariables', code: 'TS18046', snippet: "export function msg(): string {\n  try {\n    return 'a';\n  } catch (e) {\n    return e.message;\n  }\n}\n" },
    { flag: 'strictBuiltinIteratorReturn', code: 'TS2322', snippet: 'export function next(): number {\n  const r = [1].values().next();\n  const v: number = r.value;\n  return v;\n}\n' },
    // A script (no import/export, legacy module detection) is sloppy mode unless alwaysStrict is on.
    { flag: 'alwaysStrict', code: 'TS1212', snippet: 'var implements = 1;\nvoid implements;\n', extra: { moduleDetection: 'legacy' } },
  ];

  it('the forced set covers every strict-family option of the installed TypeScript', () => {
    const declarations = (ts as unknown as { optionDeclarations?: ReadonlyArray<{ name: string; strictFlag?: boolean }> }).optionDeclarations ?? [];
    const strictFamily = declarations.filter((o) => o.strictFlag === true).map((o) => o.name);
    expect(strictFamily.length).toBeGreaterThan(5);
    expect(Object.keys(FORCED_STRICT)).toEqual(expect.arrayContaining([...strictFamily, 'strict', 'alwaysStrict', 'noUncheckedIndexedAccess']));
  });

  for (const row of rows) {
    const off = row.flag === 'strict' ? { strict: false, noUncheckedIndexedAccess: false } : { [row.flag]: false };
    const files = (planted: boolean): Files => ({
      ...CLEAN,
      'tsconfig.json': tsconfig({ ...off, ...row.extra, ignoreDeprecations: '6.0' }),
      ...(planted ? { 'src/planted.ts': row.snippet } : {}),
    });

    it(`"${row.flag}": false in tsconfig → the planted ${row.code} still FAILs; the clean API passes`, async () => {
      // Control: the API's own options accept the planted code, so only the forced flag can catch it.
      const root = await api(files(true));
      const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
      const own = ts.createProgram({ rootNames: parsed?.fileNames ?? [], options: parsed?.options ?? {} });
      const ownCodes = ts.getPreEmitDiagnostics(own).filter((d) => d.file?.fileName.endsWith('planted.ts')).map((d) => `TS${d.code}`);
      expect(ownCodes).not.toContain(row.code);

      const bad = await check(files(true));
      expect(bad.status).toBe('fail');
      expect(bad.lines.filter((l) => l.startsWith('src/planted.ts:')).join('\n')).toContain(row.code);
      const good = await check(files(false));
      expect(good.lines).toEqual([]);
      expect(good.status).toBe('pass');
    });
  }

  it('"noCheck": true cannot switch the type checker off', async () => {
    const r = await check({ ...CLEAN, 'tsconfig.json': tsconfig({ noCheck: true }), 'src/planted.ts': WRONG });
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringMatching(/^src\/planted\.ts:1:14 {2}TS2322/));
  });

  it('a failing run prints the real count on the (project) row and UNPROVEN rows say UNPROVEN', async () => {
    const r = await check({ ...CLEAN, 'tsconfig.json': tsconfig({ strictNullChecks: false }), 'src/planted.ts': `${INDEX}${ANY}` });
    const text = formatReport(r.findings, [tscStrict], '/').text;
    expect(text).toMatch(/tsc-strict {8}FAIL {2}\(project\) +2 errors/);
    expect(text).not.toMatch(/\(project\) +0 errors/);
    const u = await check({ ...CLEAN, 'tsconfig.json': '{ "compilerOptions": { "strict": true, } oops' });
    expect(formatReport(u.findings, [tscStrict], '/').text).toMatch(/tsc-strict {8}UNPROVEN {2}\(project\) +skipped: unusable TypeScript configuration/);
  });
});

describe('tsc-strict: the checked file set is every TypeScript file of the API, not the tsconfig include', () => {
  const rows: Array<{ name: string; files: Files; planted: string; at: string; expect: string }> = [
    { name: 'include: ["src"] hides the tests', files: { 'tsconfig.json': tsconfig({}, { include: ['src'] }) }, planted: 'test/planted.test.ts', at: 'test/planted.test.ts', expect: '`any` type' },
    { name: 'exclude drops *.test.ts', files: { 'tsconfig.json': tsconfig({}, { include: ['src', 'test'], exclude: ['**/*.test.ts'] }) }, planted: 'test/planted.test.ts', at: 'test/planted.test.ts', expect: '`any` type' },
    { name: '"files" lists one entry point', files: { 'tsconfig.json': tsconfig({}, { files: ['src/index.ts'] }) }, planted: 'src/extra.ts', at: 'src/extra.ts', expect: '`any` type' },
    { name: 'include points at a folder that does not exist', files: { 'tsconfig.json': tsconfig({}, { include: ['app'] }) }, planted: 'src/extra.ts', at: 'src/extra.ts', expect: '`any` type' },
    { name: 'source under lib/ instead of src/', files: {}, planted: 'lib/extra.ts', at: 'lib/extra.ts', expect: '`any` type' },
    { name: 'tests under tests/ instead of test/', files: {}, planted: 'tests/extra.test.ts', at: 'tests/extra.test.ts', expect: '`any` type' },
    { name: 'a root config file (vitest.config.ts style)', files: {}, planted: 'tool.config.ts', at: 'tool.config.ts', expect: '`any` type' },
    { name: '.mts module', files: {}, planted: 'src/extra.mts', at: 'src/extra.mts', expect: '`any` type' },
    { name: '.cts module', files: {}, planted: 'src/extra.cts', at: 'src/extra.cts', expect: '`any` type' },
    { name: 'rootDir: "src" (no TS6059 false failure; tests still checked)', files: { 'tsconfig.json': tsconfig({ rootDir: 'src' }) }, planted: 'test/planted.test.ts', at: 'test/planted.test.ts', expect: '`any` type' },
  ];
  for (const row of rows) {
    it(`${row.name}: a planted \`any\` FAILs, the clean API passes`, async () => {
      const good = await check({ ...CLEAN, ...row.files });
      expect(good.lines).toEqual([]);
      expect(good.status).toBe('pass');
      const bad = await check({ ...CLEAN, ...row.files, [row.planted]: ANY });
      expect(bad.status).toBe('fail');
      expect(bad.lines).toContainEqual(expect.stringContaining(`${row.at}:1:26  ${row.expect}`));
    });
  }

  it('a type error in a file no tsconfig lists is a type error (checked with the primary options)', async () => {
    const r = await check({ ...CLEAN, 'tsconfig.json': tsconfig({}, { include: ['src'] }), 'test/planted.test.ts': INDEX });
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringMatching(/^test\/planted\.test\.ts:3:10 {2}TS18048/));
    expect(r.log).toContain('listed by no tsconfig, checked with the primary project\'s options: test/index.test.ts, test/planted.test.ts');
  });

  it('a file in a build folder is skipped unless the API imports it; then it is checked wherever it lives', async () => {
    const unused = await check({ ...CLEAN, 'build/gen.ts': ANY });
    expect(unused.status).toBe('pass');
    const imported = await check({
      ...CLEAN,
      'build/gen.ts': ANY,
      'src/uses.ts': "import { loose } from '../build/gen.ts';\nexport const y: unknown = loose(1);\n",
    });
    expect(imported.status).toBe('fail');
    expect(imported.lines).toContainEqual(expect.stringContaining('build/gen.ts:1:26  `any` type'));
  });

  it('`any` without the keyword is found outside src/ too, but not in test code', async () => {
    const r = await check({
      ...CLEAN,
      'scripts/seed.ts': "export const seed = JSON.parse('{}');\n",
      'tests/helpers.ts': "export const fixture = JSON.parse('{}');\n",
    });
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringContaining('scripts/seed.ts:1:14  `seed` has type `any`'));
    expect(r.lines.filter((l) => l.startsWith('tests/'))).toEqual([]);
  });
});

describe('tsc-strict: declaration files', () => {
  it('`any` in the API\'s own .d.ts FAILs (it was never scanned before)', async () => {
    const r = await check({ ...CLEAN, 'src/types/global.d.ts': 'declare global {\n  var cache: any;\n}\nexport {};\n' });
    expect(r.status).toBe('fail');
    expect(r.lines).toEqual(['src/types/global.d.ts:2:14  `any` type: use unknown and narrow, or a precise type']);
  });

  it('a type error in the API\'s own .d.ts FAILs even with skipLibCheck: true', async () => {
    const r = await check({ ...CLEAN, 'src/types/env.d.ts': 'declare const settings: MissingType;\n' });
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringMatching(/^src\/types\/env\.d\.ts:1:25 {2}TS2304: Cannot find name 'MissingType'/));
  });

  it('`any` in a non-null or ts-ignore form in a .d.ts is found too', async () => {
    const r = await check({ ...CLEAN, 'types/shim.d.ts': '// @ts-nocheck\ndeclare const loose: Array<any>;\n' });
    expect(r.lines).toEqual(['types/shim.d.ts:1:4  @ts-nocheck comment: fix the type error instead of suppressing it', 'types/shim.d.ts:2:28  `any` type: use unknown and narrow, or a precise type']);
  });

  it('a .d.ts that describes a sibling file (build output, vendored JS) is not the API\'s own code', async () => {
    const r = await check({
      ...CLEAN,
      'src/util/label.d.ts': 'export declare function label(name: any): string;\n',
      'vendor/legacy.js': 'export function legacy(x) { return x; }\n',
      'vendor/legacy.d.ts': 'export declare function legacy(x: any): any;\n',
    });
    expect(r.lines).toEqual([]);
    expect(r.status).toBe('pass');
  });
});

describe('tsc-strict: tsconfig shapes', () => {
  const solution = (app: Record<string, unknown> = {}, testOpts: Record<string, unknown> = {}): Files => ({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tests-project' }] }),
    'tsconfig.app.json': tsconfig(app, { include: ['src'] }),
    'tests-project/tsconfig.json': JSON.stringify({ compilerOptions: { ...OPTIONS, ...testOpts }, include: ['../test'] }),
  });
  const rows: Array<{ name: string; files: Files; planted: Files; at: RegExp }> = [
    { name: 'solution style (files: [] + references), violation in the app project', files: solution(), planted: { 'src/planted.ts': WRONG }, at: /^src\/planted\.ts:1:14 {2}TS2322/ },
    { name: 'solution style, the test project relaxes strict', files: solution({}, { strict: false, noUncheckedIndexedAccess: false }), planted: { 'test/planted.test.ts': INDEX }, at: /^test\/planted\.test\.ts:3:10 {2}TS18048/ },
    {
      name: 'extends a base file that turns strict off',
      files: { 'configs/base.json': tsconfig({ strict: false, strictNullChecks: false }), 'tsconfig.json': JSON.stringify({ extends: './configs/base.json', include: ['src', 'test'] }) },
      planted: { 'src/planted.ts': INDEX },
      at: /^src\/planted\.ts:3:10 {2}TS18048/,
    },
    {
      name: 'paths alias (@/…) without baseUrl',
      files: { 'tsconfig.json': tsconfig({ paths: { '@/*': ['./src/*'] } }), 'src/aliased.ts': "import { label } from '@/util/label.ts';\nexport const l: string = label('x');\n" },
      planted: { 'src/util/label.ts': 'export function label(name: string): string {\n  return name.toUpperCase();\n}\nexport const n: number = label(\'x\');\n' },
      at: /^src\/util\/label\.ts:4:14 {2}TS2322/,
    },
    {
      name: 'paths alias with baseUrl and moduleResolution "node" (deprecated in TypeScript 6: no false failure)',
      files: {
        'package.json': pkg({ type: 'commonjs' }),
        'tsconfig.json': tsconfig({ module: 'CommonJS', moduleResolution: 'node', baseUrl: '.', paths: { '~/*': ['src/*'] } }),
        'src/aliased.ts': "import { label } from '~/util/label.ts';\nexport const l: string = label('x');\n",
      },
      planted: { 'src/planted.ts': INDEX },
      at: /^src\/planted\.ts:3:10 {2}TS18048/,
    },
    {
      name: 'an unreferenced side config (tsconfig.spec.json) owns the tests with its own types',
      files: {
        'tsconfig.json': tsconfig({}, { include: ['src'] }),
        'tsconfig.spec.json': JSON.stringify({ extends: './tsconfig.json', compilerOptions: { types: ['node'] }, include: ['test'] }),
        'test/env.test.ts': 'export const cwd: string = process.cwd();\n',
      },
      planted: { 'test/planted.test.ts': INDEX },
      at: /^test\/planted\.test\.ts:3:10 {2}TS18048/,
    },
    {
      name: 'no `types` field: the visible @types packages are loaded (pre-6.0 default)',
      files: { 'tsconfig.json': JSON.stringify({ compilerOptions: { ...OPTIONS, types: undefined }, include: ['src', 'test'] }), 'src/env.ts': 'export const cwd: string = process.cwd();\n' },
      planted: { 'src/planted.ts': WRONG },
      at: /^src\/planted\.ts:1:14 {2}TS2322/,
    },
  ];
  for (const row of rows) {
    it(`${row.name}: clean passes, planted FAILs`, async () => {
      const good = await check({ ...CLEAN, ...row.files });
      expect(good.lines).toEqual([]);
      expect(good.status).toBe('pass');
      const bad = await check({ ...CLEAN, ...row.files, ...row.planted });
      expect(bad.status).toBe('fail');
      expect(bad.lines).toContainEqual(expect.stringMatching(row.at));
    });
  }

  it('solution style: each referenced project is checked with its own options (log names them)', async () => {
    const r = await check({ ...CLEAN, ...solution(), 'test/env.test.ts': 'export const cwd: string = process.cwd();\n' });
    // The test project has no node types, the app project neither: process is a real error in the test project.
    expect(r.lines).toContainEqual(expect.stringMatching(/^test\/env\.test\.ts:1:28 {2}TS2591/));
    expect(r.log).toContain('project tsconfig.app.json (primary');
    expect(r.log).toContain('project tests-project/tsconfig.json: 2 files checked');
  });

  it('without the side config the same test file is a real error (the side config is what made it pass)', async () => {
    const r = await check({ ...CLEAN, 'tsconfig.json': tsconfig({}, { include: ['src'] }), 'test/env.test.ts': 'export const cwd: string = process.cwd();\n' });
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringMatching(/^test\/env\.test\.ts:1:28 {2}TS2591/));
  });
});

describe('tsc-strict: an unusable configuration is UNPROVEN, never a pass and never blamed on the code', () => {
  const rows: Array<{ name: string; files: Files; reason: string }> = [
    { name: 'unparsable tsconfig.json', files: { 'tsconfig.json': '{ "compilerOptions": { "strict": true, } oops' }, reason: 'tsconfig.json: TS1136' },
    { name: 'extends a missing file', files: { 'tsconfig.json': JSON.stringify({ extends: './nope/base.json', include: ['src'] }) }, reason: 'tsconfig.json: TS5083' },
    { name: 'unknown compiler option', files: { 'tsconfig.json': tsconfig({ strictt: true }) }, reason: "Unknown compiler option 'strictt'" },
    { name: 'option removed in this TypeScript', files: { 'tsconfig.json': tsconfig({ keyofStringsOnly: true }) }, reason: "TS5102 Option 'keyofStringsOnly' has been removed" },
    { name: 'references a project that does not exist', files: { 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.gone.json' }] }) }, reason: 'tsconfig.gone.json: not found' },
    { name: 'a referenced project is broken', files: { 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './app' }] }), 'app/tsconfig.json': '{ "include": [' }, reason: 'app/tsconfig.json' },
  ];
  for (const row of rows) {
    it(`${row.name} → UNPROVEN with the reason; syntactic violations are still reported`, async () => {
      const r = await check({ ...CLEAN, ...row.files, 'src/planted.ts': `${ANY}${WRONG}` });
      expect(r.status).toBe('unproven');
      expect(r.reason).toContain('unusable TypeScript configuration');
      expect(r.reason).toContain(row.reason);
      // the `any` needs no configuration; the TS2322 does, so it is not claimed
      expect(r.lines).toEqual(['src/planted.ts:1:26  `any` type: use unknown and narrow, or a precise type']);
    });
  }

  it('a broken side config that nothing references is ignored (logged), not fatal', async () => {
    const r = await check({ ...CLEAN, 'tsconfig.old.json': '{ broken' });
    expect(r.status).toBe('pass');
    expect(r.log).toContain('ignored side configs: tsconfig.old.json');
  });

  it('an API without TypeScript files is UNPROVEN (nothing was type-checked), not a pass', async () => {
    const r = await check({ 'package.json': pkg(), 'README.md': '# empty\n' });
    expect(r.status).toBe('unproven');
    expect(r.reason).toContain('no TypeScript files');
  });

  it('the type check crashing is UNPROVEN with the reason, and the syntactic scan still runs', async () => {
    const root = await api({ ...CLEAN, 'src/planted.ts': ANY, 'test/globals.test.ts': "describe('x', () => undefined);\nexport {};\n" });
    const real = await contextFor(root);
    // A context of its own (not the shared type check), whose dependency lookup blows up mid-check.
    const ctx: CheckContext = {
      ...real,
      logs: memoryLogs(),
      program: () => real.program(),
      dependencies: () => {
        throw new Error('checker exploded');
      },
    };
    const findings = await tscStrict.run(ctx);
    const skip = findings.find((f) => f.status === 'skip');
    expect(skip?.skipReason).toContain('the type check could not run: checker exploded');
    expect(findings.flatMap((f) => f.violations.map((v) => `${v.location}  ${v.message}`))).toEqual(['src/planted.ts:1:26  `any` type: use unknown and narrow, or a precise type']);
    expect(formatReport(findings, [tscStrict], root).rules[0]?.status).toBe('unproven');
  });
});

describe('tsc-strict: no tsconfig.json', () => {
  const esm = (planted: Files = {}): Files => ({
    'package.json': pkg(),
    'src/index.ts': "import { label } from './util/label';\nexport const out: string = label('a');\n",
    'src/util/label.ts': 'export function label(name: string): string {\n  return name.toUpperCase();\n}\n',
    'test/index.test.ts': "import { out } from '../src/index';\nexport const again: string = out;\n",
    ...planted,
  });
  const cjs = (planted: Files = {}): Files => ({ ...esm(planted), 'package.json': pkg({ type: 'commonjs' }) });
  const explicit = (planted: Files = {}): Files => ({
    ...esm(planted),
    'src/index.ts': "import { label } from './util/label.ts';\nexport const out: string = label('a');\n",
    'test/index.test.ts': "import { out } from '../src/index.ts';\nexport const again: string = out;\n",
  });

  for (const [name, make] of [['ESM with extensionless imports', esm], ['CommonJS with extensionless imports', cjs], ['ESM with .ts imports', explicit]] as const) {
    it(`${name}: clean passes (no false failure); a type error and an \`any\` FAIL`, async () => {
      const good = await check(make());
      expect(good.lines).toEqual([]);
      expect(good.status).toBe('pass');
      expect(good.log).toContain('no usable tsconfig.json: harness defaults');
      const bad = await check(make({ 'src/planted.ts': `${WRONG}${ANY}` }));
      expect(bad.status).toBe('fail');
      expect(bad.lines).toEqual([
        "src/planted.ts:1:14  TS2322: Type 'string' is not assignable to type 'number'.",
        'src/planted.ts:2:26  `any` type: use unknown and narrow, or a precise type',
      ]);
    });
  }

  it('the forced flags apply to the defaults too', async () => {
    const r = await check(esm({ 'src/planted.ts': INDEX }));
    expect(r.lines).toContainEqual(expect.stringMatching(/^src\/planted\.ts:3:10 {2}TS18048/));
  });

  it('an import no default can resolve is UNPROVEN (it may be the missing tsconfig), with the first error named', async () => {
    const r = await check(esm({ 'src/broken.ts': "import { gone } from './nowhere';\nexport const g: string = gone;\n" }));
    expect(r.status).toBe('unproven');
    expect(r.reason).toContain('no tsconfig.json');
    expect(r.reason).toContain('src/broken.ts:1:22 TS2307');
  });
});

describe('tsc-strict: the environment, not the code', () => {
  it('a dependency package.json declares but nobody installed is UNPROVEN; an undeclared one is a code error', async () => {
    const use = { 'src/db.ts': "import { connect } from 'harness-not-installed-pkg';\nexport const c: unknown = connect;\n" };
    const declared = await check({ ...CLEAN, ...use, 'package.json': pkg({ dependencies: { 'harness-not-installed-pkg': '1.0.0' } }) });
    expect(declared.status).toBe('unproven');
    expect(declared.reason).toContain("'harness-not-installed-pkg' is declared in package.json but the type checker cannot resolve it (src/db.ts:1:25)");
    expect(declared.lines).toEqual([]);
    const undeclared = await check({ ...CLEAN, ...use });
    expect(undeclared.status).toBe('fail');
    expect(undeclared.lines).toContainEqual(expect.stringMatching(/^src\/db\.ts:1:25 {2}TS2307/));
  });

  it('globals of a declared but missing @types package are not judged (UNPROVEN); undeclared they are errors', async () => {
    const use = { 'test/globals.test.ts': "describe('x', () => undefined);\nexport {};\n" };
    const declared = await check({ ...CLEAN, ...use, 'package.json': pkg({ devDependencies: { '@types/harness-missing-runner': '1.0.0' } }) });
    expect(declared.status).toBe('unproven');
    expect(declared.reason).toContain('@types/harness-missing-runner declared in package.json but not installed, so 1 "cannot find name" errors are not judged');
    const undeclared = await check({ ...CLEAN, ...use });
    expect(undeclared.status).toBe('fail');
    expect(undeclared.lines).toContainEqual(expect.stringMatching(/^test\/globals\.test\.ts:1:1 {2}TS25(82|93)/));
  });
});
