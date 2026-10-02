/**
 * Red team: generated tests run arbitrary code under the harness's runner. They
 * must never see credentials from the harness's environment, and nothing they
 * start may outlive the run that started it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exec } from '../../src/core/exec.ts';
import { runVitest } from '../../src/core/testing.ts';
import { HARNESS_ROOT, makeTmp, removeTmp } from './helpers.ts';

const KEYS = {
  ANTHROPIC_API_KEY: ['sk', 'ant', 'redteam-0000000000000000000000'].join('-'), // assembled at runtime: no key-shaped literal in the repo
  OPENAI_API_KEY: 'sk-redteam-00000000000000000000000000',
  GITHUB_TOKEN: ['ghp', 'redteam000000000000000000000000'].join('_'),
  GH_TOKEN: ['ghp', 'redteam111111111111111111111111'].join('_'),
  AWS_SECRET_ACCESS_KEY: 'redteam',
  NPM_TOKEN: 'redteam',
};
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];

beforeAll(() => {
  for (const [k, v] of Object.entries(KEYS)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

describe('provider and forge credentials never reach generated code', () => {
  it('a generated test run by the harness runner sees every credential unset', async () => {
    const root = await makeTmp('redteam-env');
    dirs.push(root);
    mkdirSync(path.join(root, 'test'), { recursive: true });
    writeFileSync(
      path.join(root, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], cache: false } });\n",
    );
    const names = JSON.stringify(Object.keys(KEYS));
    writeFileSync(
      path.join(root, 'test', 'env.test.ts'),
      [
        "import { expect, it } from 'vitest';",
        `const NAMES: string[] = ${names};`,
        "it('cannot read credentials', () => {",
        '  for (const n of NAMES) expect(process.env[n], n).toBeUndefined();',
        "  const leaked = Object.values(process.env).filter((v) => typeof v === 'string' && v.includes('redteam'));",
        '  expect(leaked).toEqual([]);',
        '});',
        '',
      ].join('\n'),
    );
    const logs = { write: async (name: string) => `logs/${name}` };
    const report = await runVitest({ root, exec, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(report.summary).toContain('1 passed');
    expect(report.ok).toBe(true);
  }, 120_000);

  it('exec strips them even when the caller passes the parent environment explicitly', async () => {
    const r = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
      cwd: HARNESS_ROOT,
      env: { ...process.env, ...KEYS },
    });
    const seen: unknown = JSON.parse(r.stdout);
    expect(Array.isArray(seen)).toBe(true);
    for (const k of Object.keys(KEYS)) expect(seen, k).not.toContain(k);
  });

  it('arguments are never shell-interpreted', async () => {
    const r = await exec(process.execPath, ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '$(id)', '`id`', ';id', '&&', '$GITHUB_TOKEN'], { cwd: HARNESS_ROOT });
    expect(r.stdout).toBe('$(id)|`id`|;id|&&|$GITHUB_TOKEN');
  });
});

describe('nothing a command starts outlives it', () => {
  it('reaps a background process left in the command’s process group', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
      'c.unref();',
      'process.stdout.write(String(c.pid));',
    ].join('\n');
    const r = await exec(process.execPath, ['-e', script], { cwd: HARNESS_ROOT });
    const pid = Number(r.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
