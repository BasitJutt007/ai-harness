import { afterAll, describe, expect, it } from 'vitest';
import problemJson from '../../plugins/checks/problem-json.ts';
import { contextFor, lineOf, removeTempApi, runCheck, tempApi } from './_ctx.ts';

describe('problem-json', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await removeTempApi(r);
  });

  it('good: static error paths and all 10 runtime probes pass', async () => {
    const findings = await runCheck(problemJson, 'good');
    expect(findings.filter((f) => f.status !== 'pass')).toEqual([]);
    const runtime = findings.find((f) => f.file === '(runtime)');
    // 8 spec probes + collection success (GET /v1/users is JSON, not a problem) + injected internal error (500 problem, no leak)
    expect(runtime?.units).toEqual({ passed: 10, total: 10 });
    expect(findings.find((f) => f.file === 'src/app.ts')?.units).toEqual({ passed: 2, total: 2 });
    // every problem helper construction in lib/problem.ts is a unit
    expect(findings.find((f) => f.file === 'src/lib/problem.ts')?.units).toEqual({ passed: 5, total: 5 });
    // the three notFound(...) throws in the handlers
    expect(findings.find((f) => f.file === 'src/routes/users.ts')?.units).toEqual({ passed: 3, total: 3 });
  });

  it('bad-problem: ad-hoc body, missing error middleware, and the runtime probes all fail', async () => {
    const findings = await runCheck(problemJson, 'bad-problem');
    const users = findings.find((f) => f.file === 'src/routes/users.ts');
    expect(users?.status).toBe('fail');
    expect(users?.violations).toHaveLength(1);
    expect(users?.violations[0]?.location).toBe(`src/routes/users.ts:${lineOf('bad-problem', 'src/routes/users.ts', "res.status(404).json({ error")}:7`);
    expect(users?.violations[0]?.message).toContain('ad-hoc error body with "error"');
    const app = findings.find((f) => f.file === 'src/app.ts');
    expect(app?.units).toEqual({ passed: 1, total: 2 });
    expect(app?.violations.map((v) => v.message)).toEqual([
      'no error-handling middleware is registered; add app.use((err, req, res, next) => sendProblem(...)) after the routes',
    ]);
    const runtime = findings.find((f) => f.file === '(runtime)');
    expect(runtime?.status).toBe('fail');
    // only the collection GET (a 200 JSON success) is right; every error path, including the injected 500, is not problem+json
    expect(runtime?.units).toEqual({ passed: 1, total: 10 });
    expect(runtime?.violations.some((v) => v.message.includes('expected application/problem+json'))).toBe(true);
  });

  it('runtime is UNPROVEN (skip) when the app cannot start, never pass', async () => {
    const root = await tempApi(
      {
        'src/app.ts': `import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/errors.js';
export function createApp(): Express {
  const app = express();
  app.use(notFoundHandler);
  app.use(errorHandler);
  throw new Error('database unavailable');
}
`,
      },
      { withLib: true },
    );
    roots.push(root);
    const findings = await problemJson.run(await contextFor(root));
    const runtime = findings.find((f) => f.file === '(runtime)');
    expect(runtime?.status).toBe('skip');
    expect(runtime?.skipReason).toContain('database unavailable');
    expect(runtime?.units).toEqual({ passed: 0, total: 0 });
  });

  it('runtime is UNPROVEN when there is no src/app.ts', async () => {
    const root = await tempApi({ 'src/index.ts': 'export const x = 1;\n' });
    roots.push(root);
    const findings = await problemJson.run(await contextFor(root));
    const runtime = findings.find((f) => f.file === '(runtime)');
    expect(runtime?.status).toBe('skip');
    expect(runtime?.skipReason).toContain('src/app.ts');
  });

  it('flags error statuses without problem bodies and problems missing fields', async () => {
    const root = await tempApi(
      {
        'src/app.ts': `import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { HttpProblem, PROBLEM_BASE } from './lib/problem.js';
import { errorHandler } from './lib/errors.js';
const problem = (status: number, title: string) => ({ title, status });
export function createApp(): Express {
  const app = express();
  app.get('/v1/a', (_req, res) => {
    res.status(500).send('boom');
  });
  app.get('/v1/b', (_req, res) => {
    res.sendStatus(403);
  });
  app.get('/v1/c', () => {
    throw problem(409, 'Conflict');
  });
  app.get('/v1/d', () => {
    throw new HttpProblem({ type: PROBLEM_BASE + 'gone', title: 'Gone', status: 404, detail: 'x' });
  });
  app.use((_req: Request, res: Response, _next: NextFunction) => {
    res.status(404).json({ message: 'not here' });
  });
  app.use(errorHandler);
  return app;
}
`,
      },
      { withLib: true },
    );
    roots.push(root);
    const findings = await problemJson.run(await contextFor(root));
    const app = findings.find((f) => f.file === 'src/app.ts');
    const msgs = (app?.violations ?? []).map((v) => `${v.location.split(':')[1] ?? ''} ${v.message}`);
    const has = (line: number, text: string): boolean => msgs.some((m) => m.startsWith(`${line} `) && m.includes(text));
    expect(has(8, 'status 500 is sent with a non-problem body')).toBe(true);
    expect(has(11, 'status 403 is sent with a non-problem body')).toBe(true);
    expect(has(14, 'problem(...) does not supply type')).toBe(true);
    expect(msgs.some((m) => m.startsWith('17 '))).toBe(false); // HttpProblem with type/title/status passes
    expect(has(20, 'ad-hoc error body with "message"')).toBe(true);
    expect(has(19, 'not-found handler')).toBe(false);
  });
});
