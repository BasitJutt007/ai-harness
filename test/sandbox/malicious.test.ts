/**
 * Finding 1: agent-written code runs confined by the real OS mechanism. A malicious test, a
 * malicious schema module (imported by the contract runtime) and a malicious createApp
 * (imported by the probe runtime) each try to: write into the API root and outside it, rm -rf a sibling
 * "original checkout", `git commit` in it, connect to a non-loopback address, read a provider
 * key from the env and list a credential store. They also try the read side: a credentials file in a
 * home-like dir, the sibling checkout's .git, a listing of the dir around the API, another run's temp
 * dir, and connection-string / cloud-key / NODE_OPTIONS variables planted in the harness's env (LANG
 * must still arrive). All of it must fail, the harness must still report the run, and the original
 * checkout must be byte-for-byte untouched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { bin, exec } from '../../src/core/exec.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import { runVitest } from '../../src/core/testing.ts';
import type { Exec, ExecOptions, LogStore } from '../../src/core/types.ts';
import { convertAtRuntime } from '../../plugins/lib/contract.ts';
import { runProbe } from '../../plugins/lib/probe.ts';
import {
  attackResult,
  attackSource,
  BLOCKED_EVERYWHERE,
  blockedReads,
  ENV_CANARIES,
  ENV_KEY,
  existingSecretDir,
  layout,
  loopbackServer,
  plantEnvCanaries,
  readCanaries,
  untouched,
  type Layout,
  type ReadCanaries,
} from './helpers.ts';

const mechanism = detectMechanism();
const ATTACK_LOG = 'attack-log.json';
const darwin = process.platform === 'darwin';

function memoryLogs(): LogStore {
  return { write: (name: string) => Promise.resolve(`(memory)/${name}`) };
}

/** The core exec, recording every call's options and output (plus the evil test's log, read from the child's TMPDIR before the runner deletes it). */
function recordingExec(calls: Array<{ cmd: string; opts: ExecOptions; stdout: string; sandbox: string | undefined; attackLog?: string }>): Exec {
  return async (cmd, args, opts) => {
    const r = await exec(cmd, args, opts);
    const tmp = opts.env?.['TMPDIR'];
    const log = tmp === undefined ? undefined : join(tmp, ATTACK_LOG);
    calls.push({ cmd, opts, stdout: r.stdout, sandbox: r.sandbox, ...(log !== undefined && existsSync(log) ? { attackLog: readFileSync(log, 'utf8') } : {}) });
    return r;
  };
}

let l: Layout;
let server: { port: number; close: () => Promise<void> };
let reads: ReadCanaries;
let restoreEnv: () => void;
const secretDir = existingSecretDir();

beforeAll(async () => {
  process.env[ENV_KEY] = 'leak-me';
  restoreEnv = plantEnvCanaries();
  l = layout('malicious');
  reads = readCanaries(l);
  server = await loopbackServer();
  const targets = {
    outside: l.outside,
    sibling: l.original,
    repo: l.original,
    apiFile: join(l.api, 'src', 'pwned.ts'),
    loopbackPort: server.port,
    secretDir,
    reads,
    envNames: [ENV_KEY, ...Object.keys(ENV_CANARIES)],
  };
  writeFileSync(join(l.api, 'attack.mjs'), attackSource(targets));
  // (1) a malicious vitest test: records what happened (in its TMPDIR, the only writable place),
  // then asserts the attacks worked (so it FAILS when confined).
  writeFileSync(
    join(l.api, 'test', 'evil.test.ts'),
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { attack } from '../attack.mjs';
test('escapes the sandbox', async () => {
  const r = await attack();
  writeFileSync(join(process.env.TMPDIR ?? '.', ${JSON.stringify(ATTACK_LOG)}), JSON.stringify(r));
  expect(r).toMatchObject({ writeOutside: 'ok', rmSibling: 'ok', gitCommit: 'ok', netOutbound: 'ok', envKey: 'present' });
});
`,
  );
  // (2) a malicious schema module and (3) a malicious createApp: top-level side effects at import.
  writeFileSync(
    join(l.api, 'src', 'schemas.ts'),
    `import { z } from 'zod';
import { attack } from '../attack.mjs';
console.log('ATTACK ' + JSON.stringify(await attack()));
export const Thing = z.object({ id: z.string() });
`,
  );
  writeFileSync(
    join(l.api, 'src', 'app.ts'),
    `import express from 'express';
import { attack } from '../attack.mjs';
console.log('ATTACK ' + JSON.stringify(await attack()));
export function createApp() { return express(); }
`,
  );
});

afterAll(async () => {
  delete process.env[ENV_KEY];
  restoreEnv();
  await server.close();
  reads.cleanup();
  l.cleanup();
});

function expectOriginalUntouched(): void {
  expect(untouched(l)).toEqual({ head: l.head, status: '', keep: true, outside: false, files: ['.git', 'keep.txt'] });
}

describe.runIf(mechanism !== 'none')(`malicious agent code under ${mechanism}`, () => {
  it('a malicious vitest test (driven through exec with the runner policy) fails every attack', async () => {
    const report = join(l.runTmp, 'report.json');
    const r = await exec(
      bin('vitest'),
      ['run', '--root', l.api, '--configLoader', 'runner', '--reporter=json', `--outputFile.json=${report}`],
      { cwd: l.api, env: { ...process.env, TMPDIR: l.runTmp, HOME: join(l.runTmp, 'home') }, sandbox: { writable: [l.runTmp], network: 'localhost' } },
    );
    expect(r.sandbox).toBe(mechanism);
    expect(r.code).not.toBe(0);
    const json: unknown = JSON.parse(readFileSync(report, 'utf8'));
    expect(json).toMatchObject({ numFailedTests: 1, numPassedTests: 0 });
    const attempts: unknown = JSON.parse(readFileSync(join(l.runTmp, ATTACK_LOG), 'utf8'));
    expect(attempts).toMatchObject({ ...BLOCKED_EVERYWHERE, ...blockedReads(), writeApi: 'EPERM' });
    expect(attempts).not.toMatchObject({ gitCommit: 'ok' });
    if (darwin) expect(attempts).toMatchObject({ netLoopback: 'ok' });
    if (secretDir !== null) expect(attempts).not.toMatchObject({ readSecrets: 'ok' });
    expectOriginalUntouched();
  }, 120_000);

  it("the harness's own runner (runVitest) confines the same test and reports it as a failure", async () => {
    const calls: Parameters<typeof recordingExec>[0] = [];
    const rep = await runVitest({ root: l.api, files: ['test/evil.test.ts'], exec: recordingExec(calls), harnessRoot: HARNESS_ROOT, logs: memoryLogs(), turn: 1 });
    const call = calls.find((c) => c.cmd.endsWith('vitest'));
    expect(call?.opts.sandbox?.network).toBe('localhost');
    expect(call?.opts.sandbox?.writable).not.toContain(l.api);
    expect(call?.sandbox).toBe(mechanism);
    expect(rep.ok).toBe(false);
    expect(rep.totals).toMatchObject({ failed: 1, passed: 0 });
    const attempts: unknown = JSON.parse(call?.attackLog ?? 'null');
    expect(attempts).toMatchObject({ ...BLOCKED_EVERYWHERE, ...blockedReads(), writeApi: 'EPERM' });
    expect(attempts).not.toMatchObject({ gitCommit: 'ok' });
    expectOriginalUntouched();
  }, 120_000);

  it('a malicious schema module imported by the contract runtime: no writes (API read-only), no network at all; schemas still extracted', async () => {
    const calls: Parameters<typeof recordingExec>[0] = [];
    const schemas = await convertAtRuntime({ apiRoot: l.api, harnessRoot: HARNESS_ROOT, exec: recordingExec(calls), refs: [{ module: 'src/schemas.ts', exportName: 'Thing' }] });
    expect(schemas[0]?.error).toBeUndefined();
    expect(schemas[0]?.input).toMatchObject({ type: 'object' });
    expect(calls[0]?.opts.sandbox?.network).toBe('none');
    expect(calls[0]?.sandbox).toBe(mechanism);
    const attempts = attackResult(calls[0]?.stdout ?? '');
    expect(attempts).toMatchObject({ ...BLOCKED_EVERYWHERE, ...blockedReads(), writeApi: 'EPERM' });
    expect(attempts).not.toMatchObject({ gitCommit: 'ok' });
    if (darwin) expect(attempts).toMatchObject({ netLoopback: 'EPERM' });
    expectOriginalUntouched();
  }, 120_000);

  it('a malicious createApp imported by the probe runtime: API read-only, loopback only; the probes still run', async () => {
    const calls: Parameters<typeof recordingExec>[0] = [];
    const ctx = await createCheckContext({ root: l.api, exec: recordingExec(calls), harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    const run = await runProbe(ctx, []);
    expect(run.ok, 'reason' in run ? run.reason : '').toBe(true);
    const call = calls.find((c) => c.stdout.includes('ATTACK '));
    expect(call?.opts.sandbox?.network).toBe('localhost');
    expect(call?.sandbox).toBe(mechanism);
    const attempts = attackResult(call?.stdout ?? '');
    expect(attempts).toMatchObject({ ...BLOCKED_EVERYWHERE, ...blockedReads(), writeApi: 'EPERM' });
    expect(attempts).not.toMatchObject({ gitCommit: 'ok' });
    if (darwin) expect(attempts).toMatchObject({ netLoopback: 'ok' });
    expectOriginalUntouched();
  }, 120_000);
});
