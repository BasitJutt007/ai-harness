/**
 * The gates, not the model, decide DONE. A loop that never calls finish (the script simply ends, the
 * loop stalls) is DONE when the fresh final gate run is green, labelled as such and listed for a human;
 * the cheat run (test/e2e/cheat-agnostic.test.ts) stalls too, but its gates are not green: NOT DONE.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import { collector, execWithoutGh, readRunJson, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from './helpers.ts';

let tmp: TempRepo;
let summary: RunSummary;
let out: ReturnType<typeof collector>;

interface ScriptCall { name: string; input: unknown; contentFile?: string }
interface Script { description: string; turns: Array<{ text?: string; calls: ScriptCall[] }> }

beforeAll(async () => {
  tmp = tempRepo('gates-decide');
  out = collector();
  // The reference greenfield script without its final `finish` turn; contentFile paths made absolute.
  const script = JSON.parse(readFileSync(join(SCRIPTS, 'users-api.json'), 'utf8')) as Script;
  const turns = script.turns
    .filter((t) => !t.calls.some((c) => c.name === 'finish'))
    .map((t) => ({ ...t, calls: t.calls.map((c) => (c.contentFile === undefined || isAbsolute(c.contentFile) ? c : { ...c, contentFile: resolve(SCRIPTS, c.contentFile) })) }));
  const file = join(tmp.dir, 'users-api-no-finish.json');
  writeFileSync(file, JSON.stringify({ ...script, turns }));
  summary = await executeRun({
    taskFile: USERS_TASK,
    driver: 'scripted',
    driverOptions: { script: file },
    baseline: false,
    ship: false,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: out.out,
  });
}, 300_000);
afterAll(() => tmp.cleanup());

describe('green final gates decide DONE without a finish call', () => {
  it('the loop ended without finish, the fresh gates are green, the run is DONE and says why', () => {
    expect(summary.status).not.toBe('done');
    expect(summary.ok).toBe(true);
    const run = readRunJson(summary.runDir) as Record<string, unknown>;
    expect(String(run['verdict'])).toMatch(/^DONE \(the loop ended (stalled|max_turns) without finish; the fresh final gate run is green\)$/);
    expect(out.text()).toMatch(/verdict {4}DONE \(the loop ended/);
    const honesty = run['honesty'] as { humanMustVerify: string[] };
    expect(honesty.humanMustVerify[0]).toMatch(/the model did not call finish/);
  });
});
