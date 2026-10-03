import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from '../../src/core/exec.ts';
import { capBytes, checkFileArgs, MAX_CONSOLE_BYTES, missingSourceModule, parseReport, runnerEnv, runVitest } from '../../src/core/testing.ts';
import type { Exec, ExecOptions, LogStore, TestObservation } from '../../src/core/types.ts';

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(HARNESS_ROOT, '.harness', 'tmp', `core-quality-testing-${randomBytes(4).toString('hex')}`);
const api = join(base, 'api');
const logDir = join(base, 'logs');

const logs: LogStore = {
  async write(name, content) {
    await mkdir(logDir, { recursive: true });
    const p = join(logDir, `${name}.txt`);
    await writeFile(p, content);
    return p;
  },
};

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'probe-api', type: 'module', private: true }),
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
  'src/ok.ts': 'export const one = 1;\n',
  'src/a.ts': "export { b } from './b.js';\n",
  'test/pass.test.ts': "import { it, expect } from 'vitest';\nimport { one } from '../src/ok.js';\nit('one', () => { expect(one).toBe(1); });\nit('two', () => { expect(2).toBe(2); });\n",
  'test/fail.test.ts': "import { describe, it, expect } from 'vitest';\ndescribe('POST /v1/users', () => {\n  it('returns 409 on duplicate', () => { expect(201).toBe(409); });\n  it('passes', () => { expect(1).toBe(1); });\n});\n",
  'test/missing.test.ts': "import { it, expect } from 'vitest';\nimport { thing } from '../src/missing.js';\nit('thing', () => { expect(thing).toBe(1); });\n",
  'test/nested.test.ts': "import { it, expect } from 'vitest';\nimport { b } from '../src/a.js';\nit('b', () => { expect(b).toBe(1); });\n",
  'test/syntax.test.ts': "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1);\nconst = ;\n",
  'test/helper-missing.test.ts': "import { it } from 'vitest';\nimport { h } from './helpers/nope.js';\nit('h', () => { void h; });\n",
  'test/pkg-missing.test.ts': "import { it } from 'vitest';\nimport x from 'not-a-real-package-xyz';\nit('x', () => { void x; });\n",
};

beforeAll(async () => {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(api, rel)), { recursive: true });
    await writeFile(join(api, rel), content);
  }
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function byFile(obs: TestObservation[], file: string): TestObservation {
  const o = obs.find((x) => x.file === file);
  if (o === undefined) throw new Error(`no observation for ${file}: ${obs.map((x) => x.file).join(', ')}`);
  return o;
}

describe('runVitest (real vitest runs)', () => {
  it('classifies pass, fail, missing-src-module, syntax error and non-src missing modules', async () => {
    const report = await runVitest({ root: api, exec, harnessRoot: HARNESS_ROOT, logs, turn: 3 });
    const obs = report.observations;
    expect(obs).toHaveLength(7);

    const pass = byFile(obs, 'test/pass.test.ts');
    expect(pass).toMatchObject({ status: 'pass', collected: 2, failed: 0, validRed: false, turn: 3 });
    const content = await readFile(join(api, 'test/pass.test.ts'));
    expect(pass.hash).toBe(createHash('sha256').update(content).digest('hex'));

    // expect(201).toBe(409) asserts constants only and uses nothing from src/: a failure, but not a red.
    const fail = byFile(obs, 'test/fail.test.ts');
    expect(fail).toMatchObject({ status: 'fail', collected: 2, failed: 1, validRed: false });
    expect(fail.reason).toBe('1 of 2 tests failed; red rejected: the failing cases only assert constants');
    expect(fail.cases?.map((c) => [c.name, c.status, c.exercisesSource, c.constantOnly])).toEqual([
      ['POST /v1/users > returns 409 on duplicate', 'fail', false, true],
      ['POST /v1/users > passes', 'pass', false, true],
    ]);

    const missing = byFile(obs, 'test/missing.test.ts');
    expect(missing).toMatchObject({ status: 'error', collected: 0, validRed: true });
    expect(missing.reason).toContain('src/missing.ts');
    expect(missing.cases).toEqual([expect.objectContaining({ name: 'thing', status: 'error', exercisesSource: true, constantOnly: false })]);
    expect(pass.cases?.map((c) => [c.name, c.status, c.exercisesSource, c.constantOnly])).toEqual([['one', 'pass', true, false], ['two', 'pass', false, true]]);

    const nested = byFile(obs, 'test/nested.test.ts');
    expect(nested).toMatchObject({ status: 'error', validRed: true });
    expect(nested.reason).toContain('src/b.ts');

    expect(byFile(obs, 'test/syntax.test.ts')).toMatchObject({ status: 'error', validRed: false });
    expect(byFile(obs, 'test/helper-missing.test.ts')).toMatchObject({ status: 'error', validRed: false });
    expect(byFile(obs, 'test/pkg-missing.test.ts')).toMatchObject({ status: 'error', validRed: false });

    expect(report.ok).toBe(false);
    expect(report.totals).toEqual({ files: 7, tests: 4, passed: 3, failed: 1 });
    const lines = report.summary.split('\n');
    expect(lines[0]).toBe('tests: 1 failed, 3 passed (4) in 7 files, 5 failed to load');
    expect(report.summary).toContain('FAIL test/fail.test.ts > POST /v1/users > returns 409 on duplicate: expected 201 to be 409');
    expect(report.summary).not.toContain('log: ');
    expect(report.logPath).toMatch(/vitest/);
    const raw = await readFile(report.logPath, 'utf8');
    expect(raw).toContain('"testResults"');
  });

  it('runs only the requested files and reports ok when green', async () => {
    const report = await runVitest({ root: api, files: ['test/pass.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(report.ok).toBe(true);
    expect(report.observations.map((o) => o.file)).toEqual(['test/pass.test.ts']);
    expect(report.summary.split('\n')[0]).toBe('tests: 0 failed, 2 passed (2) in 1 files');
  });
});

describe('runVitest: green semantics, argument safety, isolation, console', () => {
  const api2 = join(base, 'api2');
  const extra: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'probe-api-2', type: 'module', private: true }),
    'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
    'test/skipped.test.ts': "import { it } from 'vitest';\nit.skip('later', () => {});\nit.todo('someday');\n",
    'test/mixed.test.ts': "import { it, expect } from 'vitest';\nit('runs', () => { expect(1).toBe(1); });\nit.skip('later', () => {});\n",
    'test/home.test.ts': [
      "import { it, expect } from 'vitest';",
      "import { homedir } from 'node:os';",
      "it('home is isolated', () => {",
      "  console.log('HOME_SEEN=' + process.env.HOME);",
      "  expect(homedir()).toBe(process.env.HOME);",
      "  expect(process.env.HOME).toContain('harness-vitest-');",
      "  expect(process.env.XDG_CONFIG_HOME?.startsWith(process.env.HOME ?? '-')).toBe(true);",
      "  expect(process.env.USERPROFILE).toBe(process.env.HOME);",
      "});",
      '',
    ].join('\n'),
  };
  beforeAll(async () => {
    for (const [rel, content] of Object.entries(extra)) {
      await mkdir(dirname(join(api2, rel)), { recursive: true });
      await writeFile(join(api2, rel), content);
    }
  });

  it('all-skipped/todo is not green', async () => {
    const report = await runVitest({ root: api2, files: ['test/skipped.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(report.totals.passed).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/skipped\/todo/);
  });

  it('a skipped test next to a passing one is not green either (passed must equal collected)', async () => {
    const report = await runVitest({ root: api2, files: ['test/mixed.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(report.totals).toEqual({ files: 1, tests: 2, passed: 1, failed: 0 });
    expect(report.ok).toBe(false);
  });

  it('runs with an isolated HOME/XDG under a per-run OS temp dir that is removed afterwards; console holds the real output', async () => {
    const report = await runVitest({ root: api2, files: ['test/home.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(report.ok).toBe(true);
    const out = report.console ?? '';
    const seen = /HOME_SEEN=(\S+)/.exec(out)?.[1] ?? '';
    expect(seen.startsWith(join(tmpdir(), 'harness-vitest-'))).toBe(true);
    expect(seen).not.toBe(process.env['HOME']);
    await expect(readFile(seen)).rejects.toThrow(); // removed after the run
    // the default reporter's console output, without colour and without our JSON-file notice
    expect(out).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(out).toMatch(/Tests\s+1 passed \(1\)/);
    expect(out).not.toMatch(/\u001b\[/);
    expect(out).not.toContain('JSON report written to');
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_CONSOLE_BYTES);
  });

  it('runs the runner sandboxed: writable = only a per-run tmp dir holding TMPDIR (API root read-only), JSON report over the fd-3 channel; network localhost', async () => {
    const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
    const spy: Exec = (cmd, args, opts) => {
      calls.push({ args, opts });
      return exec(cmd, args, opts);
    };
    const report = await runVitest({ root: api2, files: ['test/mixed.test.ts'], exec: spy, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(report.totals.tests).toBe(2);
    const call = calls[0];
    const tmp = call?.opts.sandbox?.writable[0] ?? '';
    expect(call?.opts.sandbox).toEqual({ writable: [tmp], network: 'localhost' });
    expect(tmp.startsWith(join(tmpdir(), 'harness-vitest-'))).toBe(true);
    expect(call?.opts.env).toMatchObject({ TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    // The JSON report goes over the private fd-3 channel, never to a file the confined child can write.
    expect(call?.args).toContain('--outputFile.json=/dev/fd/3');
    expect(call?.args).toContain('--pool=forks');
    expect(call?.opts.channel).toBe(true);
  });

  it('rejects option-looking, absolute and escaping file entries before running anything', async () => {
    const run = (files: string[]): Promise<unknown> => runVitest({ root: api2, files, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    await expect(run(['--config=/etc/evil.ts'])).rejects.toThrow(/looks like an option/);
    await expect(run(['-t'])).rejects.toThrow(/looks like an option/);
    await expect(run([join(api2, 'test/mixed.test.ts')])).rejects.toThrow(/absolute/);
    await expect(run(['../api/test/pass.test.ts'])).rejects.toThrow(/escapes the API root/);
    await expect(run(['test/../../x.test.ts'])).rejects.toThrow(/escapes the API root/);
    expect(checkFileArgs(api2, ['test/mixed.test.ts', 'mixed'])).toEqual(['test/mixed.test.ts', 'mixed']);
  });

  it('runnerEnv points HOME/USERPROFILE/XDG_* at the given dir and drops config pointers', () => {
    expect(runnerEnv('/tmp/h', '/tmp/run')).toMatchObject({ TMPDIR: '/tmp/run', TMP: '/tmp/run', TEMP: '/tmp/run' });
    const env = runnerEnv('/tmp/h');
    expect(env['HOME']).toBe('/tmp/h');
    expect(env['USERPROFILE']).toBe('/tmp/h');
    expect(env['XDG_CONFIG_HOME']).toBe(join('/tmp/h', '.config'));
    expect(env['XDG_DATA_HOME']).toBe(join('/tmp/h', '.local', 'share'));
    expect(env['XDG_CACHE_HOME']).toBe(join('/tmp/h', '.cache'));
    expect(env['NO_COLOR']).toBe('1');
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(env['npm_config_userconfig']).toBeUndefined();
  });

  it('capBytes keeps head and tail within the cap', () => {
    const text = `HEAD${'x'.repeat(200_000)}TAIL`;
    const capped = capBytes(text, MAX_CONSOLE_BYTES);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(MAX_CONSOLE_BYTES);
    expect(capped.startsWith('HEAD')).toBe(true);
    expect(capped.endsWith('TAIL')).toBe(true);
    expect(capped).toContain('bytes of console output omitted');
    expect(capBytes('short', MAX_CONSOLE_BYTES)).toBe('short');
  });
});

describe('parseReport / missingSourceModule', () => {
  it('rejects non-JSON and tolerates partial shapes', () => {
    expect(parseReport('nope')).toBeNull();
    expect(parseReport('{}')).toBeNull();
    expect(parseReport('{"testResults":[{"name":"/x/test/a.test.ts"}]}')).toEqual([
      { name: '/x/test/a.test.ts', status: 'unknown', message: '', assertionResults: [] },
    ]);
  });

  it('only counts missing relative modules under src/ that do not exist', () => {
    const msg = (spec: string, from: string): string => `Cannot find module '${spec}' imported from ${join(api, from)}`;
    expect(missingSourceModule(api, msg('../src/missing.js', 'test/x.test.ts'))).toBe('src/missing.ts');
    expect(missingSourceModule(api, msg('../src/deep/c', 'test/x.test.ts'))).toBe('src/deep/c.ts');
    expect(missingSourceModule(api, msg('../src/ok.js', 'test/x.test.ts'))).toBeNull();
    expect(missingSourceModule(api, msg('./helpers.js', 'test/x.test.ts'))).toBeNull();
    expect(missingSourceModule(api, `Cannot find package 'zzz' imported from ${join(api, 'test/x.test.ts')}`)).toBeNull();
    expect(missingSourceModule(api, 'SyntaxError: Unexpected token')).toBeNull();
  });
});
