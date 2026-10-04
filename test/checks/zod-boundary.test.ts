import { afterAll, describe, expect, it } from 'vitest';
import zodBoundary from '../../plugins/checks/zod-boundary.ts';
import { formatReport } from '../../src/core/checks.ts';
import { contextFor, lineOf, removeTempApi, runCheck, tempApi, totals, violationLines } from './_ctx.ts';
import { TEMPLATE } from './_variants.ts';

const USERS = 'src/routes/users.ts';

describe('zod-boundary', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await removeTempApi(r);
  });

  it('good: units are route handlers only; files without handlers or hand-written types have no finding', async () => {
    const findings = await runCheck(zodBoundary, 'good');
    expect(findings).toEqual([{ rule: 'zod-boundary', file: USERS, status: 'pass', units: { passed: 5, total: 5 }, violations: [] }]);
    expect(totals(findings)).toEqual({ passed: 5, total: 5 });
  });

  it('the empty template has nothing to prove: no findings, so the report says unproven 0/0 (never "7/7 handlers")', async () => {
    const ctx = await contextFor(TEMPLATE);
    const findings = await zodBoundary.run(ctx);
    expect(findings).toEqual([]);
    const report = formatReport(findings, [zodBoundary], ctx.root);
    expect(report.rules).toEqual([expect.objectContaining({ rule: 'zod-boundary', status: 'unproven', passed: 0, total: 0 })]);
    expect(report.verdict.status).not.toBe('pass');
  });

  it('bad-zod: unparsed body, unparsed response and hand-written interface at the right lines', async () => {
    const findings = await runCheck(zodBoundary, 'bad-zod');
    const users = findings.find((f) => f.file === USERS);
    expect(users?.status).toBe('fail');
    expect(users?.units).toEqual({ passed: 3, total: 5 });
    const bodyLine = lineOf('bad-zod', USERS, '{ ...req.body }');
    const postLine = lineOf('bad-zod', USERS, "usersRouter.post('/v1/users'");
    const resLine = lineOf('bad-zod', USERS, 'res.json(user);');
    expect(violationLines(findings, USERS).sort((a, b) => a - b)).toEqual([postLine, bodyLine, resLine].sort((a, b) => a - b));
    const msgs = users?.violations.map((v) => v.message) ?? [];
    expect(msgs.some((m) => m.startsWith('POST /v1/users: req.body is read without'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('POST /v1/users: request body is not parsed'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('GET /v1/users/:userId: response body is not parsed with a Zod schema'))).toBe(true);
    const store = findings.find((f) => f.file === 'src/store/users.ts');
    expect(store?.status).toBe('fail');
    expect(store?.units).toEqual({ passed: 0, total: 1 }); // one failing unit per hand-written type
    expect(store?.violations).toEqual([
      {
        location: `src/store/users.ts:${lineOf('bad-zod', 'src/store/users.ts', 'export interface UserStats')}:18`,
        message: 'interface UserStats: hand-written type: infer it from a Zod schema (z.infer)',
      },
    ]);
    expect(findings.filter((f) => f.status === 'fail').map((f) => f.file).sort()).toEqual(['src/routes/users.ts', 'src/store/users.ts']);
  });

  it('flags missing params/body parses, object type aliases, escaping res, and non-Zod parsers', async () => {
    const root = await tempApi({
      'src/routes.ts': `import { Router, type Response } from 'express';
import { z } from 'zod';
const Out = z.object({ id: z.string() });
export type Shape = { id: string };
export type Alias = z.infer<typeof Out>;
const validator = { parse: (v: unknown): { id: string } => ({ id: String(v) }) };
function sendOut(res: Response, v: unknown): void { res.json(v); }
export const r = Router();
r.put('/v1/things/:thingId', (_req, res) => {
  res.status(204).end();
});
r.patch('/v1/things/:thingId', (req, res) => {
  const p = validator.parse(req.params);
  sendOut(res, p);
});
r.get('/v1/things/:thingId', (req, res) => {
  let body = Out.parse(req.params);
  body = { id: 'x' };
  res.send(body);
});
`,
    });
    roots.push(root);
    const findings = await zodBoundary.run(await contextFor(root));
    const f = findings.find((x) => x.file === 'src/routes.ts');
    expect(f?.units).toEqual({ passed: 0, total: 4 });
    const msgs = (f?.violations ?? []).map((v) => `${v.location.split(':')[1] ?? ''} ${v.message}`);
    const has = (line: number, text: string): boolean => msgs.some((m) => m.startsWith(`${line} `) && m.includes(text));
    expect(has(4, 'type Shape: hand-written type')).toBe(true);
    expect(msgs.some((m) => m.includes('Alias'))).toBe(false);
    expect(has(9, 'PUT /v1/things/:thingId: path parameters are not parsed')).toBe(true);
    expect(has(9, 'PUT /v1/things/:thingId: request body is not parsed')).toBe(true);
    expect(has(13, 'PATCH /v1/things/:thingId: req.params is read without')).toBe(true);
    // sendOut(res, p) is followed: its raw send fails where it sends, naming the call
    expect(has(7, 'PATCH /v1/things/:thingId: response body is not parsed with a Zod schema; send ResponseSchema.parse(value) (sent by sendOut(), called at src/routes.ts:14:')).toBe(true);
    expect(msgs.some((m) => m.includes('`res` is passed along'))).toBe(false);
    expect(has(19, 'GET /v1/things/:thingId: response body is not parsed')).toBe(true); // `let` is not trusted
  });
});
