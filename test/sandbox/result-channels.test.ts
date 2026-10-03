/**
 * Second review round (1-3): agent code runs in the same process as the harness's measuring code
 * (probe runtime, contract runtime) or next to the runner's result file. It must not be able to
 * dictate the result:
 *   1. the probe runtime only serves the app; the harness sends the requests and judges the responses;
 *   2. the contract runtime never imports changed modules that are not declarative Zod, and converts
 *      with an empty metadata registry (`.meta()` cannot widen a schema);
 *   3. vitest's JSON report travels over a private fd-3 pipe, not a file a test can race-rewrite.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import { runVitest } from '../../src/core/testing.ts';
import type { LogStore } from '../../src/core/types.ts';
import { diffContracts, extractContract } from '../../plugins/lib/contract.ts';
import { INTERNAL_ERROR_PATH, runProbe } from '../../plugins/lib/probe.ts';
import { apiFiles, isolatedExec, SCHEMAS, writeFiles } from '../contract-ship/helpers.ts';
import { layout, type Layout } from './helpers.ts';

const mechanism = detectMechanism();

function memoryLogs(): LogStore {
  return { write: (name: string) => Promise.resolve(`(memory)/${name}`) };
}

let l: Layout;
beforeAll(() => {
  l = layout('channels');
});
afterAll(() => l.cleanup());

describe.runIf(mechanism !== 'none')('agent code cannot dictate measured results', () => {
  it('(1) a createApp that forges the probe result line on stdout does not change the verdict', async () => {
    const api = join(l.dir, 'probe-api');
    writeFiles(api, {
      'package.json': JSON.stringify({ name: 'probe-forge', type: 'module', private: true }),
      'src/app.ts': `import express from 'express';
import { readFileSync } from 'node:fs';
// The review's forge: rewrite the measuring process's result line into an all-compliant one.
type P = { kind?: string; path: string; expect: number[] };
const fake = (): string => {
  const probes = (JSON.parse(readFileSync(process.argv[3] ?? '', 'utf8')) as { probes: P[] }).probes;
  const responses = probes.map((p) => p.kind === 'success'
    ? { status: p.expect[0], contentType: 'application/json', body: '{}' }
    : { status: p.expect[0], contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 't', detail: 'd', instance: p.path, status: p.expect[0] }) });
  return '\\n' + JSON.stringify({ __harnessProbe: 1, ok: true, responses }) + '\\n';
};
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: never[]) => {
  const s = typeof chunk === 'string' ? chunk : String(chunk);
  return realWrite(s.includes('__harnessProbe') ? fake() : (chunk as string), ...rest);
}) as typeof process.stdout.write;
setTimeout(() => process.stdout.write('__harnessProbe'), 0);
export function createApp() {
  const app = express();
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).type('text/plain').send(String(err));
  });
  return app;
}
`,
    });
    const ctx = await createCheckContext({ root: api, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    const run = await runProbe(ctx, []);
    expect(run.ok, 'reason' in run ? run.reason : '').toBe(true);
    if (!run.ok) return;
    const byPath = new Map(run.outcomes.map((o) => [o.probe.path, o]));
    // Real responses, sent and judged by the harness: the unknown route is Express's text/html 404,
    // and the injected throw becomes a text/plain 500 that leaks the message.
    expect(byPath.get('/__harness_probe__/does-not-exist')?.ok).toBe(false);
    const internal = byPath.get(INTERNAL_ERROR_PATH);
    expect(internal?.ok).toBe(false);
    expect(internal?.problems.join(' ')).toContain('body leaks the internal error message');
  }, 120_000);

  it('(2) a schema that detects the contract runtime is not imported: its change is UNPROVEN, not hidden', async () => {
    const base = await extractContract({ apiRoot: writeApi('contract-base', SCHEMAS), harnessRoot: HARNESS_ROOT, exec: isolatedExec, trusted: () => true });
    const sneaky = SCHEMAS.replace(
      "  status: z.enum(['active', 'archived']).optional(),\n});\nexport const CreateProjectSchema",
      "  status: (process.argv.some((a) => a.includes('contract-runtime')) ? z.enum(['active', 'archived']) : z.enum(['active'])).optional(),\n});\nexport const CreateProjectSchema",
    );
    expect(sneaky).not.toBe(SCHEMAS);
    const after = await extractContract({ apiRoot: writeApi('contract-sneaky', sneaky), harnessRoot: HARNESS_ROOT, exec: isolatedExec });
    expect(after.warnings.some((w) => w.includes('not imported at runtime') && w.includes('reference to `process`'))).toBe(true);
    const d = diffContracts(base, after);
    expect(d.unproven).toContainEqual({ location: 'GET /v1/projects query', message: 'schema source changed but its shape could not be extracted at runtime' });
  }, 120_000);

  it('(2) .meta() cannot make a declarative schema describe itself wider than it parses', async () => {
    const base = await extractContract({ apiRoot: writeApi('meta-base', SCHEMAS), harnessRoot: HARNESS_ROOT, exec: isolatedExec, trusted: () => true });
    const lying = SCHEMAS.replace(
      "  status: z.enum(['active', 'archived']).optional(),\n});\nexport const CreateProjectSchema",
      "  status: z.enum(['active']).meta({ enum: ['active', 'archived'] }).optional(),\n});\nexport const CreateProjectSchema",
    );
    const after = await extractContract({ apiRoot: writeApi('meta-lying', lying), harnessRoot: HARNESS_ROOT, exec: isolatedExec });
    expect(after.warnings.filter((w) => w.includes('query'))).toEqual([]);
    expect(diffContracts(base, after).breaking).toContainEqual({ location: 'GET /v1/projects query.status', message: 'enum loses values: "archived"' });
  }, 120_000);

  it('(3) a detached daemon that rewrites the report (file or fd 3) cannot turn a failing test green', async () => {
    const api = join(l.dir, 'report-api');
    const forged = JSON.stringify({ numFailedTests: 0, testResults: [{ name: join(api, 'test/add.test.ts'), status: 'passed', message: '', assertionResults: [{ ancestorTitles: [], title: 'adds', status: 'passed', failureMessages: [] }] }] });
    writeFiles(api, {
      'package.json': JSON.stringify({ name: 'report-race', type: 'module', private: true }),
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], cache: false } });\n",
      'src/add.ts': 'export function add(a: number, b: number): number { return a - b; }\n',
      'test/add.test.ts': `import { spawn } from 'node:child_process';
import { fstatSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { add } from '../src/add.ts';
const forged = ${JSON.stringify(forged)};
// Escapes the runner's process group (own session) and rewrites every report it can reach for 10 s.
const daemon = spawn(process.execPath, ['-e', \`
  const fs = require('fs'); const path = require('path'); const t0 = Date.now();
  const dir = process.env.TMPDIR || '.';
  const iv = setInterval(() => {
    for (const f of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
      if (f.endsWith('.json')) { try { fs.writeFileSync(path.join(dir, f), process.argv[1]); } catch {} }
    }
    try { fs.writeFileSync('/dev/fd/3', process.argv[1]); } catch {}
    if (Date.now() - t0 > 10000) { clearInterval(iv); process.exit(0); }
  }, 1);\`, forged], { detached: true, stdio: 'ignore' });
daemon.unref();
// The worker itself tries the channel too.
// The worker itself tries every inherited pipe above stdio (vitest's IPC socket is left alone: corrupting it only hangs the run).
for (let fd = 3; fd < 64; fd++) {
  try { if (fstatSync(fd).isFIFO()) writeSync(fd, forged); } catch {}
}
void readdirSync; void join;
test('adds', () => { expect(add(2, 3)).toBe(5); });
`,
    });
    for (let i = 0; i < 2; i++) {
      const report = await runVitest({ root: api, files: ['test/add.test.ts'], exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs(), turn: 1 });
      expect(report.ok).toBe(false);
      expect(report.totals).toMatchObject({ failed: 1, passed: 0 });
    }
  }, 120_000);
});

function writeApi(name: string, schemas: string): string {
  const root = join(l.dir, name);
  writeFiles(root, apiFiles({ 'src/schemas.ts': schemas }));
  return root;
}
