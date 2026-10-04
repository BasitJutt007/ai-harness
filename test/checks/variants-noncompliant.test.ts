/**
 * False-pass hunt: subtly non-compliant users APIs, each assembled on the greenfield template.
 * Each must fail exactly the expected rules, with a violation at the right API-relative
 * file:line (and a message that says why). Runtime-only defects are pinned by message.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatReport } from '../../src/core/checks.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';
import { contextFor } from './_ctx.ts';
import { STANDARD_CHECKS, VARIANTS, assembleVariant, removeVariant, variantNames } from './_variants.ts';

type Rule = 'zod-boundary' | 'problem-json' | 'tsc-strict' | 'rest-conventions';

interface Expected {
  rule: Rule;
  /** [API-relative file, substring of the offending line]; omitted for runtime findings. */
  at?: [string, string];
  message: string;
}

const ROUTES = 'src/routes/users.ts';

const MATRIX: Record<string, { fails: Rule[]; expect: Expected[]; exactViolations?: Partial<Record<Rule, number>> }> = {
  'bad-res-send-helper': {
    // respond(res, status: number, body: unknown) can send any status with any body: a non-constant status is an error path.
    // The helper is followed: the raw user it sends with 200 is an unparsed 2xx body, reported at its send.
    fails: ['zod-boundary', 'problem-json'],
    expect: [
      { rule: 'zod-boundary', at: ['src/http/respond.ts', 'res.status(status).send(body)'], message: 'GET /v1/users/:userId: response body is not parsed with a Zod schema; send ResponseSchema.parse(value) (sent by respond(), called at src/routes/users.ts:24:' },
      { rule: 'problem-json', at: ['src/http/respond.ts', 'res.status(status).send(body)'], message: 'status status is not a constant, so this may be an error response' },
    ],
  },
  'bad-body-spread': {
    fails: ['zod-boundary', 'problem-json'],
    expect: [
      { rule: 'zod-boundary', at: [ROUTES, '...req.body'], message: 'POST /v1/users: req.body is read without <ZodSchema>.parse()' },
      { rule: 'zod-boundary', at: [ROUTES, "usersRouter.post('/v1/users'"], message: 'request body is not parsed' },
      // runtime: the unvalidated invalid body of the first probe is stored, so the second one (no Idempotency-Key) is not a 4xx validation problem
      { rule: 'problem-json', message: 'POST /v1/users (missing Idempotency-Key): expected status 400 or 422 or 428, got' },
    ],
  },
  'bad-senderror-helper': {
    // sendError(res, 404, …) is followed: the routes do have a 404 path (rest-conventions) and send no unparsed
    // 2xx body (zod-boundary); its ad-hoc error body is what is wrong, and problem-json says so.
    fails: ['problem-json'],
    expect: [
      { rule: 'problem-json', at: ['src/http/errors.ts', 'res.status(status).json({ message })'], message: 'ad-hoc error body with "message"' },
      { rule: 'problem-json', message: 'GET /v1/users/00000000-0000-4000-8000-000000000000 (unknown id): Content-Type is "application/json' },
    ],
  },
  'bad-error-middleware-json': {
    fails: ['problem-json'],
    expect: [
      { rule: 'problem-json', at: ['src/app.ts', 'res.status(status).json({ error: message })'], message: 'ad-hoc error body with "error"' },
      { rule: 'problem-json', message: 'POST /v1/users (malformed JSON body): expected status 400, got 500' },
    ],
  },
  'bad-next-generic-error': {
    fails: ['problem-json', 'rest-conventions'],
    expect: [
      { rule: 'problem-json', at: [ROUTES, 'next(new Error('], message: 'GET /v1/users/:userId: new Error(...) is not a problem' },
      { rule: 'problem-json', at: [ROUTES, "throw new Error('not found');\n  res.json"], message: 'PATCH /v1/users/:userId: new Error(...) is not a problem' },
      { rule: 'problem-json', message: '(unknown id): expected status 404 or 422, got 500' },
      { rule: 'rest-conventions', at: [ROUTES, "usersRouter.delete('/v1/users/:userId'"], message: 'no 404 path' },
    ],
  },
  'bad-no-error-middleware': {
    fails: ['problem-json'],
    expect: [
      { rule: 'problem-json', at: ['src/app.ts', 'import express'], message: 'no error-handling middleware is registered' },
      { rule: 'problem-json', message: 'Content-Type is "text/html' },
    ],
  },
  'bad-validation-400': {
    fails: ['problem-json', 'rest-conventions'],
    expect: [
      { rule: 'rest-conventions', at: [ROUTES, 'throw badRequest('], message: 'POST /v1/users: literal 400 in a handler' },
      { rule: 'problem-json', message: 'POST /v1/users (invalid body): expected status 422, got 400' },
    ],
  },
  'bad-page-offset': {
    fails: ['rest-conventions'],
    expect: [
      { rule: 'rest-conventions', at: [ROUTES, 'ListUsersQuerySchema.parse(req.query)'], message: 'GET /v1/users: offset/page pagination' },
      { rule: 'rest-conventions', at: [ROUTES, 'res.json(UserPageSchema.parse(store.list(query)))'], message: 'collection response must be a page schema' },
    ],
  },
  'bad-singular-mount': {
    fails: ['rest-conventions'],
    expect: [
      { rule: 'rest-conventions', at: [ROUTES, "usersRouter.get('/:userId'"], message: 'GET /v1/user/:userId: segment "user" is not a plural noun' },
      { rule: 'rest-conventions', at: [ROUTES, "usersRouter.post('/'"], message: 'POST /v1/user: segment "user" is not a plural noun' },
    ],
  },
  'bad-post-no-idempotency': {
    fails: ['rest-conventions'],
    expect: [{ rule: 'rest-conventions', at: [ROUTES, "usersRouter.post('/v1/users'"], message: 'POST /v1/users: no idempotency' }],
    exactViolations: { 'rest-conventions': 1 },
  },
  'bad-idempotency-noop': {
    // the middleware validates Idempotency-Key and calls next(): nothing is stored or replayed
    fails: ['rest-conventions'],
    expect: [
      { rule: 'rest-conventions', at: [ROUTES, "usersRouter.post('/v1/users'"], message: 'POST /v1/users: no idempotency: the chain reads the Idempotency-Key header but only tests it' },
      { rule: 'rest-conventions', at: [ROUTES, "usersRouter.patch('/v1/users/:userId'"], message: 'PATCH /v1/users/:userId: no idempotency: the chain reads the Idempotency-Key header but only tests it' },
    ],
    exactViolations: { 'rest-conventions': 2 },
  },
  'bad-create-no-location': {
    fails: ['rest-conventions'],
    expect: [{ rule: 'rest-conventions', at: [ROUTES, "usersRouter.post('/v1/users'"], message: 'POST /v1/users: creating a resource must set the Location header' }],
    exactViolations: { 'rest-conventions': 1 },
  },
  'bad-delete-200': {
    fails: ['rest-conventions'],
    expect: [{ rule: 'rest-conventions', at: [ROUTES, 'res.status(200).json(UserSchema.parse(user))'], message: 'DELETE must respond res.status(204).end()' }],
    exactViolations: { 'rest-conventions': 1 },
  },
  'bad-any-forms': {
    fails: ['tsc-strict'],
    expect: [
      { rule: 'tsc-strict', at: ['src/util/casts.ts', 'Array<any>'], message: '`any` type' },
      { rule: 'tsc-strict', at: ['src/util/casts.ts', 'Record<string, any>'], message: '`any` type' },
      { rule: 'tsc-strict', at: ['src/util/casts.ts', '<any>raw'], message: '`any` type' },
    ],
    // `raw as unknown as User` is allowed: the three any forms, plus `v` (typed any by Array<any>; type checker)
    exactViolations: { 'tsc-strict': 4 },
  },
  'bad-types-file': {
    fails: ['zod-boundary'],
    expect: [{ rule: 'zod-boundary', at: ['src/types.ts', 'export type UserResponse'], message: 'type UserResponse: hand-written type' }],
    exactViolations: { 'zod-boundary': 1 }, // `type UserId = string` is not a DTO shape
  },
  'bad-lib-interface': {
    fails: ['zod-boundary'],
    expect: [{ rule: 'zod-boundary', at: ['src/lib/audit.ts', 'export interface AuditEntry'], message: 'interface AuditEntry: hand-written type' }],
  },
  'bad-todto-unparsed': {
    fails: ['zod-boundary'],
    expect: [{ rule: 'zod-boundary', at: [ROUTES, 'res.json(toDto(user))'], message: 'GET /v1/users/:userId: response body is not parsed with a Zod schema' }],
  },
  'bad-middleware-unparsed-success': {
    // a middleware of the route chain answers 200 before the handler with an unparsed body
    fails: ['zod-boundary'],
    expect: [{ rule: 'zod-boundary', at: [ROUTES, 'res.json(hit)'], message: 'GET /v1/users/:userId: response body is not parsed with a Zod schema; send ResponseSchema.parse(value) (sent by a middleware/helper in the route chain)' }],
    exactViolations: { 'zod-boundary': 1 },
  },
  'bad-parsed-then-mutated': {
    // parsed, then changed before the send: through Object.assign, an alias, and a for-of element
    // (the changed page is no longer a parsed page schema either: rest-conventions)
    fails: ['zod-boundary', 'rest-conventions'],
    expect: [
      { rule: 'rest-conventions', at: [ROUTES, 'res.json(page)'], message: 'GET /v1/users: collection response must be a page schema' },
      { rule: 'zod-boundary', at: [ROUTES, 'res.json(body)'], message: 'GET /v1/users/:userId: response body body is changed after its Zod parse (at src/routes/users.ts:26:' },
      { rule: 'zod-boundary', at: [ROUTES, 'res.json(shown)'], message: 'PATCH /v1/users/:userId: response body shown is changed after its Zod parse (at src/routes/users.ts:36:' },
      { rule: 'zod-boundary', at: [ROUTES, 'res.json(page)'], message: 'GET /v1/users: response body page is changed after its Zod parse (at src/routes/users.ts:12:' },
    ],
    exactViolations: { 'zod-boundary': 3 },
  },
  'bad-problem-no-content-type': {
    // a typed problem body (ProblemSchema.parse) sent without Content-Type application/problem+json
    fails: ['problem-json'],
    expect: [{ rule: 'problem-json', at: [ROUTES, 'res.status(409).json(ProblemSchema.parse('], message: "status 409 is sent with a non-problem body (missing .type('application/problem+json'))" }],
    exactViolations: { 'problem-json': 1 },
  },
  'bad-zod-any-schema': {
    fails: ['zod-boundary', 'tsc-strict', 'problem-json'],
    expect: [
      { rule: 'zod-boundary', at: [ROUTES, 'z.any().parse(req.body)'], message: 'z.any() accepts anything' },
      // the parsed value is `any` without the keyword: the type checker finds it
      { rule: 'tsc-strict', at: [ROUTES, 'z.any().parse(req.body)'], message: '`input` has type `any`' },
      // runtime: z.any() stores the invalid body of the first probe, so the second one (no Idempotency-Key) is not a 4xx validation problem
      { rule: 'problem-json', message: 'POST /v1/users (missing Idempotency-Key): expected status 400 or 422 or 428, got' },
    ],
  },
  'bad-error-leak': {
    fails: ['problem-json'],
    expect: [{ rule: 'problem-json', message: 'GET /__harness_probe__/internal-error (internal error): body leaks the internal error message; body leaks a stack trace' }],
  },
  'bad-notfound-before-routes': {
    fails: ['problem-json'],
    expect: [{ rule: 'problem-json', message: 'GET /v1/users (collection success): expected status 200 or 401 or 403, got 404' }],
  },
};

/** 1-based line of the first line containing `needle` (which may span lines with \n). */
function lineIn(variant: string, file: string, needle: string): number {
  const text = readFileSync(join(VARIANTS, variant, file), 'utf8');
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" not found in ${variant}/${file}`);
  return text.slice(0, at).split('\n').length;
}

describe('non-compliant variants', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await removeVariant(r);
  });

  it('the matrix covers every bad-* variant (at least 8)', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(variantNames('bad-'));
    expect(Object.keys(MATRIX).length).toBeGreaterThanOrEqual(8);
  });

  it.concurrent.each(Object.keys(MATRIX))('%s fails the right rules at the right locations', async (name) => {
    const spec = MATRIX[name];
    if (spec === undefined) throw new Error(`no matrix entry for ${name}`);
    const root = await assembleVariant(name);
    roots.push(root);
    const ctx = await contextFor(root);
    const all: CheckFinding[] = [];
    for (const c of STANDARD_CHECKS) all.push(...(await c.run(ctx)));
    // A planted defect (a 404 for every route, an unparsed body, a rejected create) also keeps the runtime
    // replay probe from confirming a statically accepted replay: that route is UNPROVEN, by design, and is
    // set aside here; every other skip and every failure is still asserted exactly.
    const unconfirmed = all.filter((f) => f.rule === 'rest-conventions' && f.status === 'skip' && /its replay looks right in the code, but it was not confirmed at runtime/.test(f.skipReason ?? ''));
    const findings = all.filter((f) => !unconfirmed.includes(f));
    const report = formatReport(findings, STANDARD_CHECKS, root);
    expect(findings.some((f) => f.status === 'skip'), report.compact).toBe(false);
    expect(report.verdict.status, report.compact).toBe('fail');
    const failing = report.rules.filter((r) => r.status !== 'pass').map((r) => r.rule).sort();
    expect(failing, report.compact).toEqual([...spec.fails].sort());
    for (const e of spec.expect) {
      const violations = findings.filter((f) => f.rule === e.rule).flatMap((f) => f.violations);
      const hit = violations.some((v) => {
        if (!v.message.includes(e.message)) return false;
        if (e.at === undefined) return true;
        const [file, needle] = e.at;
        return v.location.startsWith(`${file}:${lineIn(name, file, needle)}:`);
      });
      expect(hit, `${e.rule} ${e.at?.join(' @ ') ?? '(runtime)'}: ${e.message}\n${report.compact}`).toBe(true);
    }
    for (const [rule, n] of Object.entries(spec.exactViolations ?? {})) {
      expect(findings.filter((f) => f.rule === rule).flatMap((f) => f.violations), report.compact).toHaveLength(n);
    }
  });
});
