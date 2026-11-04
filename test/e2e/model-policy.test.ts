/**
 * Habit 9 through the real run path: a driver whose model is not on the allowlist (here the claude
 * driver's own default, claude-opus-5-5) is refused before the first model turn: no worktree, no
 * request, no tokens. The twin on the allowlisted model runs and reports what it spent.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { executeRun } from '../../src/core/run.ts';
import type { Driver, DriverPlugin } from '../../src/core/types.ts';
import { collector, execWithoutGh, readRunJson, SCRIPTS, tempRepo, USERS_TASK } from './helpers.ts';

const tmp = tempRepo('model-policy');
afterAll(() => tmp.cleanup());

/** The scripted replay under another driver name and model id; counts the requests it is sent. */
async function namedAs(name: string, model: string, sent: { n: number }): Promise<DriverPlugin> {
  const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
  const scripted = reg.drivers.find((d) => d.plugin.name === 'scripted')?.plugin;
  if (scripted === undefined) throw new Error('scripted driver not registered');
  return {
    kind: 'driver',
    name,
    description: `the scripted replay reporting model ${model}`,
    create(opts): Driver {
      const inner = scripted.create(opts);
      return {
        name,
        model,
        tokenCounter: inner.tokenCounter,
        async complete(req, signal) {
          sent.n += 1;
          return { ...(await inner.complete(req, signal)), model };
        },
        countTokens: (req) => inner.countTokens(req),
      };
    },
  };
}

function worktrees(): string[] {
  const dir = join(HARNESS_ROOT, loadConfig(HARNESS_ROOT).worktreeDir);
  return existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith('users-api-claude-')) : [];
}

describe('model allowlist on the run path', () => {
  it('refuses the claude driver default before the first model turn: no worktree, no request', async () => {
    const sent = { n: 0 };
    const before = worktrees();
    await expect(executeRun({
      taskFile: USERS_TASK,
      driver: 'claude',
      driverOptions: { script: join(SCRIPTS, 'users-api.json') },
      baseline: false,
      ship: false,
      maxTurns: 2,
      repoBase: tmp.repo,
      runsDir: tmp.runsDir,
      tokensDir: tmp.tokensDir,
      exec: execWithoutGh(),
      log: collector().out,
      extraDrivers: [await namedAs('claude', 'claude-opus-5-5', sent)],
    })).rejects.toThrow(/refused before the first model turn \(no tokens spent\): model "claude-opus-5-5" on the claude driver is not on the allowlist/);
    expect(sent.n).toBe(0);
    expect(worktrees()).toEqual(before);
  });

  it('the allowlisted model runs, and run.json records the spend against the cap', async () => {
    const sent = { n: 0 };
    const out = collector();
    const s = await executeRun({
      taskFile: USERS_TASK,
      driver: 'claude',
      driverOptions: { script: join(SCRIPTS, 'users-api.json') },
      baseline: false,
      ship: false,
      maxTurns: 2,
      repoBase: tmp.repo,
      runsDir: tmp.runsDir,
      tokensDir: tmp.tokensDir,
      exec: execWithoutGh(),
      log: out.out,
      extraDrivers: [await namedAs('claude', 'claude-haiku-4-5-20251001', sent)],
    });
    expect(sent.n).toBeGreaterThan(0);
    // The replay reports no provider usage, so nothing was spent; the cap and the price are on record.
    expect(readRunJson(s.runDir)).toMatchObject({ spend: { model: 'claude-haiku-4-5-20251001', spentUsd: 0, capUsd: 2, price: { input: 1.25, cachedInput: 0.1, output: 5 } } });
    expect(out.text()).toMatch(/spend {6}\$0\.0000 of the \$2\.00 cap \(claude-haiku-4-5-20251001;/);
  });
});
