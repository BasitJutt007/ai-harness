/**
 * spec-coverage gate, end to end on the express-zod scaffold: the app runs in the OS sandbox and the
 * harness sends and judges every request.
 *  (a) the audit's two-resource case: users + teams complete passes; teams (or one operation) missing
 *      fails naming exactly the missing endpoints;
 *  (c) a free-text-only greenfield task is n/a and the honesty block lists the human check;
 *  (d) an app that answers 401 to everything is UNPROVEN, never pass.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import specGate, { FREE_TEXT_NOTE } from '../../plugins/gates/spec-coverage.ts';
import { honesty } from '../../src/core/run.ts';
import { runGates } from '../../src/core/gates.ts';
import { exec } from '../../src/core/exec.ts';
import type { GateResult, GreenfieldTask } from '../../src/core/plugin-api.ts';
import { brownfieldTask, HARNESS_ROOT, makeHarness, removeTmp } from './helpers.ts';
import { refSources, TEAMS, USERS } from './spec-ref-api.ts';

const TEMPLATE = join(HARNESS_ROOT, 'templates', 'express-zod');

function templateFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      if (n === 'node_modules') continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(TEMPLATE, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(TEMPLATE);
  return out;
}

const TASK: GreenfieldTask = {
  kind: 'greenfield', id: 'users-teams', title: 'Users and teams', behaviours: [], limits: { maxTurns: 1, maxOutputTokens: 256 },
  output: 'api', template: 'express-zod', basePath: '/v1', resources: [USERS, TEAMS],
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map(removeTmp));
});

async function gate(files: Record<string, string>, task: GreenfieldTask | ReturnType<typeof brownfieldTask> = TASK): Promise<GateResult> {
  const h = await makeHarness({ label: 'spec', task, files: { ...templateFiles(), ...files }, exec });
  dirs.push(h.dir);
  return specGate.run(h.ctx, 'finish');
}

describe('spec-coverage gate (sandboxed runtime probes)', () => {
  it('(a) users + teams fully built: pass', async () => {
    const r = await gate(refSources(TASK.resources, '/v1'));
    expect(r.status, [r.summary, ...(r.details ?? [])].join('\n')).toBe('pass');
    expect(r.summary).toMatch(/^(\d+)\/\1 units passed \(2 resource\(s\), 10 endpoint\(s\)\)/);
  }, 180_000);

  it('(a) teams not built: fail, naming exactly the five missing endpoints', async () => {
    const r = await gate(refSources(TASK.resources, '/v1', ['team']));
    expect(r.status).toBe('fail');
    const missing = (r.details ?? []).filter((d) => d.includes('missing endpoint')).map((d) => /missing endpoint (\S+ \S+)/.exec(d)?.[1]);
    expect(missing).toEqual(['GET /v1/teams', 'GET /v1/teams/:id', 'POST /v1/teams', 'PATCH|PUT /v1/teams/:id', 'DELETE /v1/teams/:id']);
    expect(r.summary).toContain('5 missing');
    // the users part still passes: only team units fail
    expect((r.details ?? []).filter((d) => d.startsWith('FAIL') && !d.includes(' team '))).toEqual([]);
  }, 180_000);

  it('(a) one operation missing (users delete): fail on exactly that endpoint', async () => {
    const r = await gate(refSources(TASK.resources, '/v1', ['user:delete']));
    expect(r.status).toBe('fail');
    const fails = (r.details ?? []).filter((d) => d.startsWith('FAIL'));
    expect(fails[0]).toContain('missing endpoint DELETE /v1/users/:id');
    expect(fails.every((d) => d.includes('user route DELETE') || d.includes('user delete'))).toBe(true);
  }, 180_000);

  it('(d) an app that answers 401 to everything: UNPROVEN, never pass', async () => {
    const auth = "import type { Router } from 'express';\nimport { HttpProblem, typeUri } from '../lib/problem.ts';\n";
    const files = refSources(TASK.resources, '/v1');
    const index = files['src/routes/index.ts'] ?? '';
    files['src/routes/index.ts'] = index
      .replace("import type { Router } from 'express';\n", auth)
      .replace('export function registerRoutes(app: Router): void {\n', "export function registerRoutes(app: Router): void {\n  app.use(() => {\n    throw new HttpProblem({ type: typeUri('unauthorized'), title: 'Unauthorized', status: 401, detail: 'credentials required' });\n  });\n");
    const r = await gate(files);
    expect(r.status, r.summary).toBe('unproven');
    expect(r.details?.join('\n')).toContain('answered 401');
  }, 180_000);

  it('(c) free-text-only greenfield without the opt-out: unproven (nothing compared the API with the brief), never DONE', async () => {
    const task: GreenfieldTask = { ...TASK, resources: [], brief: 'A todo API with tags.' };
    const h = await makeHarness({ label: 'spec-free-unproven', task, exec });
    dirs.push(h.dir);
    const out = await runGates([{ plugin: specGate, file: 'plugins/gates/spec-coverage.ts', sha256: 'x' }], h.ctx, 'finish');
    expect(out.results[0]).toMatchObject({ gate: 'spec-coverage', status: 'unproven' });
    expect(out.ok).toBe(false);
  });

  it('(c) free-text-only greenfield with specCoverage: human: n/a, and the honesty block lists the human check', async () => {
    const task: GreenfieldTask = { ...TASK, resources: [], brief: 'A todo API with tags.', specCoverage: 'human' };
    const h = await makeHarness({ label: 'spec-free', task, exec });
    dirs.push(h.dir);
    const out = await runGates([{ plugin: specGate, file: 'plugins/gates/spec-coverage.ts', sha256: 'x' }], h.ctx, 'finish');
    expect(out.results[0]).toMatchObject({ gate: 'spec-coverage', status: 'n/a', humanMustVerify: [FREE_TEXT_NOTE] });
    expect(out.results[0]?.summary).toContain('verified by a human');
    const hon = honesty(task, out.results, null);
    expect(hon.notApplicable).toContain('gate:spec-coverage');
    expect(hon.humanMustVerify).toContain(`gate:spec-coverage: ${FREE_TEXT_NOTE}`);
  });

  it('brownfield: n/a (contract-lock covers contracts)', async () => {
    const h = await makeHarness({ label: 'spec-brown', task: brownfieldTask(), exec });
    dirs.push(h.dir);
    const out = await runGates([{ plugin: specGate, file: 'plugins/gates/spec-coverage.ts', sha256: 'x' }], h.ctx, 'finish');
    expect(out.results[0]?.status).toBe('n/a');
  });
});
