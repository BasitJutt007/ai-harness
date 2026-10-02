/**
 * A driver may downgrade mid-run (a compat suffix, a fallback model). The final run.json,
 * the summary and tokens/<id>.json report the model actually in use; the transcript keeps
 * each turn's response.model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import type { Driver, DriverPlugin } from '../../src/core/types.ts';
import { collector, execWithoutGh, readRunJson, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from './helpers.ts';

let tmp: TempRepo;
let summary: RunSummary;
let out: ReturnType<typeof collector>;

/** Wraps the scripted driver; after the first completion its model becomes "<model> (compat)". */
async function downgradingDriver(): Promise<DriverPlugin> {
  const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
  const scripted = reg.drivers.find((d) => d.plugin.name === 'scripted')?.plugin;
  if (scripted === undefined) throw new Error('scripted driver not registered');
  return {
    kind: 'driver',
    name: 'downgrading',
    description: 'test driver that downgrades after the first turn',
    create(opts): Driver {
      const inner = scripted.create(opts);
      let downgraded = false;
      return {
        name: 'downgrading',
        get model() {
          return downgraded ? `${inner.model} (compat)` : inner.model;
        },
        tokenCounter: inner.tokenCounter,
        async complete(req, signal) {
          const res = await inner.complete(req, signal);
          const served = downgraded ? `${inner.model} (compat)` : inner.model;
          downgraded = true;
          return { ...res, model: served };
        },
        countTokens: (req) => inner.countTokens(req),
      };
    },
  };
}

beforeAll(async () => {
  tmp = tempRepo('downgrade');
  out = collector();
  summary = await executeRun({
    taskFile: USERS_TASK,
    driver: 'downgrading',
    driverOptions: { script: join(SCRIPTS, 'users-api.json') },
    baseline: false,
    ship: false,
    maxTurns: 2,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: out.out,
    extraDrivers: [await downgradingDriver()],
  });
}, 240_000);
afterAll(() => tmp.cleanup());

describe('final model re-read', () => {
  it('run.json, the summary and the token report carry the downgraded model', () => {
    expect(summary.model).toMatch(/^scripted:users-api\.json \(compat\)$/);
    const run = readRunJson(summary.runDir) as Record<string, unknown>;
    expect(run['model']).toBe(summary.model);
    expect(run['initialModel']).toBe('scripted:users-api.json');
    expect(out.text()).toContain(`model ${summary.model}`);
    const tokens: unknown = JSON.parse(readFileSync(summary.tokensPath, 'utf8'));
    expect(tokens).toMatchObject({ model: summary.model });
  });

  it('the transcript records each turn\'s response.model', () => {
    const turns = readFileSync(join(summary.runDir, 'transcript.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { turn: number; model?: string });
    expect(turns.map((t) => t.model)).toEqual(['scripted:users-api.json', 'scripted:users-api.json (compat)']);
  });
});
