import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { deserializeState, newRunId, newRunState, RunStore, serializeState } from '../../src/core/run-store.ts';
import type { RunEvent } from '../../src/core/types.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('runstore');
afterAll(() => tmp.cleanup());

describe('newRunId', () => {
  it('formats task-driver-date-time', () => {
    expect(newRunId('users-api', 'scripted', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('users-api-scripted-20260102-030405');
  });
});

describe('RunStore', () => {
  const runDir = join(tmp.dir, 'runs', 'r1');

  it('writes numbered logs and returns harness-relative POSIX paths', async () => {
    const store = new RunStore(runDir, HARNESS_ROOT);
    const p1 = await store.logs.write('vitest turn 3', 'raw output');
    const p2 = await store.logs.write('tsc/../../evil', 'x');
    expect(p1).toMatch(/^\.harness\/tmp\/.+\/runs\/r1\/logs\/001-vitest-turn-3\.txt$/);
    expect(p2).toMatch(/\/logs\/002-tsc-evil\.txt$/);
    expect(readFileSync(join(HARNESS_ROOT, p1), 'utf8')).toBe('raw output');
    // a new store over the same dir keeps counting
    const again = new RunStore(runDir, HARNESS_ROOT);
    expect(await again.logs.write('next', '')).toMatch(/\/003-next\.txt$/);
  });

  it('appends jsonl and reads/writes json + text', () => {
    const store = new RunStore(runDir, HARNESS_ROOT);
    store.appendTranscript({ turn: 1 });
    store.appendTranscript({ turn: 2 });
    const ev: RunEvent = { turn: 1, at: 'now', kind: 'note', source: 't', message: 'm' };
    store.appendEvent(ev);
    const lines = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ turn: 1 }, { turn: 2 }]);
    expect(JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8'))).toEqual(ev);
    store.writeJson('run.json', { status: 'done' });
    expect(store.readJson<{ status: string }>('run.json')).toEqual({ status: 'done' });
    expect(store.readJson('missing.json')).toBeNull();
    store.writeText('standards.txt', 'verdict 100%');
    expect(readFileSync(join(runDir, 'standards.txt'), 'utf8')).toBe('verdict 100%');
    expect(() => store.writeJson('../escape.json', {})).toThrow(/invalid/);
    expect(existsSync(join(runDir, '..', 'escape.json'))).toBe(false);
  });
});

describe('state serialisation', () => {
  it('round-trips Sets and Maps through JSON', () => {
    const s = newRunState();
    s.turn = 4;
    s.written.add('src/a.ts').add('test/a.test.ts');
    s.initialHashes.set('src/a.ts', 'h1');
    s.plan = ['one', 'two'];
    s.finishAttempts = 1;
    s.tests.push({ file: 'test/a.test.ts', hash: 'h', status: 'fail', collected: 2, failed: 1, validRed: true, reason: 'r', turn: 3, at: 'x' });
    s.events.push({ turn: 1, at: 'x', kind: 'hook', source: 'path-guard', decision: 'block', message: 'no' });
    s.scratch.set('contract-lock', { seen: new Set(['a']), byRoute: new Map([['GET /v1/x', 1]]), n: 2 });

    const back = deserializeState(JSON.parse(JSON.stringify(serializeState(s))));
    expect(back.turn).toBe(4);
    expect(back.written).toEqual(new Set(['src/a.ts', 'test/a.test.ts']));
    expect(back.initialHashes).toEqual(new Map([['src/a.ts', 'h1']]));
    expect(back.plan).toEqual(['one', 'two']);
    expect(back.tests).toEqual(s.tests);
    expect(back.events).toEqual(s.events);
    expect(back.finishAttempts).toBe(1);
    expect(back.scratch.get('contract-lock')).toEqual({ seen: new Set(['a']), byRoute: new Map([['GET /v1/x', 1]]), n: 2 });
  });

  it('rejects non-objects', () => {
    expect(() => deserializeState(null)).toThrow();
  });
});
