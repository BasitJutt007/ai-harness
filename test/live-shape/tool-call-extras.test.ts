/**
 * Real-model finding F2, end to end: an OpenAI-compatible endpoint that signs tool calls
 * (`extra_content` on the first call of each response) and rejects any later request that
 * replays a signed call without the identical field. The REAL harness run (executeRun with the
 * real openai driver over the real SDK, real tools, hooks, gates and compaction) must complete
 * the users-api trajectory with no rejected request.
 *
 * Also checked on the same run: the greenfield brief carries the scaffold API (finding F6).
 */
import OpenAI from 'openai';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_OPTIONS, createOpenAIDriver } from '../../plugins/drivers/openai.ts';
import { loadScript } from '../../plugins/drivers/scripted.ts';
import { executeRun, type RunSummary } from '../../src/core/run.ts';
import type { DriverPlugin } from '../../src/core/types.ts';
import { collector, execWithoutGh, SCRIPTS, tempRepo, USERS_TASK, type TempRepo } from '../e2e/helpers.ts';
import { fakeOpenAI, type FakeOpenAI, type FakeTurn } from './fake-providers.ts';

const script = loadScript(join(SCRIPTS, 'users-api.json'));
const TRAJECTORY: FakeTurn[] = script.turns.map((t) => ({ thinking: '', ...t }));

let tmp: TempRepo;
let fake: FakeOpenAI;
let summary: RunSummary;

beforeAll(async () => {
  tmp = tempRepo('tool-call-extras');
  fake = fakeOpenAI(TRAJECTORY, { signToolCalls: true });
  const plugin: DriverPlugin = {
    kind: 'driver',
    name: 'openai',
    description: 'openai driver over the real SDK with a signing in-process endpoint',
    create: (opts) => createOpenAIDriver({ ...opts, env: { OPENAI_API_KEY: 'test' } }, (apiKey) => new OpenAI({ apiKey, ...CLIENT_OPTIONS, fetch: fake.fetch })),
  };
  summary = await executeRun({
    taskFile: USERS_TASK,
    driver: 'openai',
    driverOptions: {},
    baseline: false,
    ship: false,
    maxTurns: TRAJECTORY.length + 2,
    repoBase: tmp.repo,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: collector().out,
    extraDrivers: [plugin],
  });
}, 600_000);

afterAll(() => tmp?.cleanup());

function chatRequests(): Array<Record<string, unknown>> {
  return fake.requests.filter((r) => r.url.pathname === '/v1/chat/completions').map((r) => r.body);
}

describe('a signing OpenAI-compatible endpoint through the real harness run', () => {
  it('no request was rejected, and the trajectory ran to the end', () => {
    expect(fake.rejections).toEqual([]);
    expect(fake.served()).toBe(TRAJECTORY.length);
    expect(summary.error).toBeUndefined();
    expect(summary.status).toBe('done');
  });

  it('signed calls were replayed with their exact extra field while they stayed in context, then dropped with their turn', () => {
    expect(fake.signed.size).toBe(TRAJECTORY.filter((t) => t.calls.length > 0).length);
    let echoed = 0;
    for (const body of chatRequests()) {
      const messages = Array.isArray(body['messages']) ? body['messages'] : [];
      for (const m of messages) {
        if (typeof m !== 'object' || m === null || !('tool_calls' in m) || !Array.isArray(m.tool_calls)) continue;
        for (const c of m.tool_calls) {
          if (typeof c !== 'object' || c === null || !('id' in c) || typeof c.id !== 'string') continue;
          const want = fake.signed.get(c.id);
          if (want === undefined) {
            expect('extra_content' in c).toBe(false); // unsigned calls get nothing invented
            continue;
          }
          expect('extra_content' in c ? JSON.stringify(c.extra_content) : null).toBe(want);
          echoed += 1;
        }
      }
    }
    // keepRecentTurns 2: each signed call is replayed in up to two later requests
    expect(echoed).toBeGreaterThanOrEqual(fake.signed.size);
  });

  it('the greenfield brief carries the scaffold API', () => {
    const first = chatRequests()[0];
    const messages = Array.isArray(first?.['messages']) ? first['messages'] : [];
    const brief = JSON.stringify(messages);
    expect(brief).toContain('Scaffold API (exported signatures; read_file a line range only when you need a body):');
    expect(brief).toMatch(/src\/routes\/index\.ts:\d+ {2}export function registerRoutes/);
  });
});
