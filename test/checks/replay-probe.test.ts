/**
 * The runtime replay probe of rest-conventions (replay-probe.ts): independent evidence next to the static
 * idempotency analysis. The harness serves the app (confined), sends the same keyed request twice and judges
 * the two responses itself. A retry that is not replayed fails the route even when the static analysis
 * accepted it. A replay the probe could not run (no body can be generated) is not evidence: a statically
 * accepted route is then UNPROVEN, not a pass, until a person supplies a valid body in harness.probe.json.
 */
import { afterAll, describe, expect, it } from 'vitest';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import { extractRouteTable } from '../../plugins/lib/api-ast.ts';
import { instanceOf } from '../../plugins/lib/replay-probe.ts';
import { createCheckContext } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';
import { memoryLogs, removeTempApi, tempApi } from './_ctx.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTempApi(r);
});

const APP = `import express, { type Express } from 'express';
import { r } from './routes.js';
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(r);
  return app;
}
`;

/** One POST whose idempotency the static analysis accepts; `replay` is what the replay branch sends. */
function routes(opts: { name: string; replay: string; store?: string; before?: string }): string {
  return `import { Router } from 'express';
import { z } from 'zod';
const Item = z.object({ name: ${opts.name}, tags: z.array(z.string()).optional() });
const Created = z.object({ id: z.string(), name: z.string() });
type CreatedT = z.infer<typeof Created>;
const Headers = z.object({ 'idempotency-key': z.string().min(1).max(255).optional() });
${opts.store ?? 'const done = new Map<string, CreatedT>();'}
let next = 0;
export const r = Router();
r.post('/v1/items', (req, res) => {
${opts.before ?? ''}
  const key = Headers.parse(req.headers)['idempotency-key'];
  const hit = key !== undefined ? done.get(key) : undefined;
  if (hit !== undefined) {
    res.status(201).location(\`/v1/items/\${hit.id}\`).json(Created.parse(${opts.replay}));
    return;
  }
  const body = Item.parse(req.body);
  next += 1;
  const item: CreatedT = { id: String(next), name: body.name };
  if (key !== undefined) done.set(key, item);
  res.status(201).location(\`/v1/items/\${item.id}\`).json(Created.parse(item));
});
`;
}

async function check(source: string, extra: Record<string, string> = {}): Promise<{ findings: CheckFinding[]; text: string; log: string }> {
  const root = await tempApi({ 'src/app.ts': APP, 'src/routes.ts': source, ...extra });
  roots.push(root);
  const logs = memoryLogs();
  const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs });
  const findings = await restConventions.run(ctx);
  const text = findings.map((f) => `${f.status} ${f.units.passed}/${f.units.total} ${f.skipReason ?? ''} ${f.violations.map((v) => v.message).join(' | ')}`).join('\n');
  return { findings, text, log: logs.entries.get('rest-conventions-replay.txt') ?? '' };
}

describe('runtime replay probe', () => {
  it('statically accepted but the retry is not replayed (it re-labels the stored id): FAIL', async () => {
    const { findings, text, log } = await check(routes({ name: 'z.string().min(1).max(40)', replay: '{ id: `${hit.id}-again`, name: hit.name }' }));
    expect(log, text).toMatch(/POST \/v1\/items: not-replayed: keyed retry was not replayed: 201 then 201 with a different body/);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: 'fail', units: { passed: 0, total: 1 } });
    expect(text).toMatch(/POST \/v1\/items: keyed retry was not replayed: 201 then 201 with a different body \(runtime probe/);
  }, 60_000);

  it('the same route replaying the stored response: passes, and the probe saw the replay', async () => {
    const { findings, text, log } = await check(routes({ name: 'z.string().min(1).max(40)', replay: 'hit' }));
    expect(findings, text).toEqual([expect.objectContaining({ status: 'pass', units: { passed: 1, total: 1 } })]);
    expect(log).toMatch(/POST \/v1\/items: replayed: the retry replayed 201/);
  }, 60_000);

  const REGEX = 'z.string().regex(/^[a-z]+-[0-9]{4}$/)';
  const SUPPLIED = { 'harness.probe.json': JSON.stringify({ 'POST /v1/items': { body: { name: 'audit-1234' } } }) };

  it('an exact replay the probe cannot run (no valid body can be generated): UNPROVEN, never a pass', async () => {
    const { findings, text, log } = await check(routes({ name: REGEX, replay: 'hit' }));
    expect(log).toMatch(/POST \/v1\/items: inconclusive: no valid body can be generated/);
    expect(findings.some((f) => f.status === 'pass'), text).toBe(false);
    expect(text).toMatch(/POST \/v1\/items: its replay looks right in the code, but it was not confirmed at runtime \(no valid body can be generated[^)]*\), so its idempotency is unproven; add a valid request body for "POST \/v1\/items" to harness\.probe\.json/);
  }, 60_000);

  it('a replay that sends a value built from the stored one is not an exact replay statically, and never passes', async () => {
    const { findings, text } = await check(routes({ name: REGEX, replay: '{ id: `${hit.id}-again`, name: hit.name }' }));
    expect(findings.some((f) => f.status === 'pass'), text).toBe(false);
  }, 60_000);

  it('a person-supplied valid body (harness.probe.json) lets the probe run: the altered replay is a definite FAIL', async () => {
    const { findings, text, log } = await check(routes({ name: REGEX, replay: '{ id: `${hit.id}-again`, name: hit.name }' }), SUPPLIED);
    expect(log, text).toMatch(/POST \/v1\/items: not-replayed: keyed retry was not replayed: 201 then 201 with a different body/);
    expect(findings).toEqual([expect.objectContaining({ status: 'fail' })]);
  }, 60_000);

  it('a person-supplied valid body and an exact replay: passes, and the probe saw the replay', async () => {
    const { findings, text, log } = await check(routes({ name: REGEX, replay: 'hit' }), SUPPLIED);
    expect(findings, text).toEqual([expect.objectContaining({ status: 'pass', units: { passed: 1, total: 1 } })]);
    expect(log).toMatch(/POST \/v1\/items: replayed: the retry replayed 201/);
  }, 60_000);

  it('a malformed harness.probe.json is reported, and the unrun replay stays UNPROVEN', async () => {
    const { findings, text } = await check(routes({ name: REGEX, replay: 'hit' }), { 'harness.probe.json': '{ "POST /v1/items": ' });
    expect(findings.some((f) => f.status === 'pass'), text).toBe(false);
    expect(text).toMatch(/harness\.probe\.json is not valid JSON/);
  }, 60_000);

  it('statically UNPROVEN (the store replaced through an alias) and not replayed at runtime: a definite FAIL', async () => {
    const source = routes({
      name: 'z.string().min(1)',
      replay: 'hit',
      store: 'const holder = { store: new Map<string, CreatedT>() };\nlet done = holder.store;',
      before: '  const alias = holder;\n  alias.store = new Map<string, CreatedT>();\n  done = holder.store;',
    });
    const { findings, text } = await check(source);
    expect(findings.some((f) => f.status === 'pass'), text).toBe(false);
    expect(text).toMatch(/fail 0\/1 .*POST \/v1\/items: keyed retry was not replayed: 201 then 201 with a different body/);
  }, 60_000);
});

describe('request bodies for the probe', () => {
  it('a valid instance of every property, optional ones included (formats and bounds respected)', () => {
    const schema = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        name: { type: 'string', minLength: 3, maxLength: 5 },
        role: { enum: ['admin', 'member'] },
        age: { type: 'integer', minimum: 18, maximum: 30 },
        nick: { anyOf: [{ type: 'string', pattern: '^x$' }, { type: 'null' }] },
      },
      required: ['email', 'name'],
    };
    const v = instanceOf(schema, schema, 'n1');
    expect(v).toMatchObject({ email: 'probe-n1@example.com', role: 'admin', age: 18, nick: null });
    const name = (v as { name: string }).name;
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(5);
  });
  it('nothing for a required value it cannot satisfy', () => {
    expect(instanceOf({ type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['code'] }, {}, 'n')).toBeUndefined();
  });
});

describe('static exact replay: only the stored value, sent as the body, counts', () => {
  /** The replay branch: `send` is the whole response statement, with `hit` the looked-up record. */
  const source = (send: string, setup = ''): string => `import { Router } from 'express';
import { z } from 'zod';
const Created = z.object({ id: z.string(), name: z.string() });
type CreatedT = z.infer<typeof Created>;
const Headers = z.object({ 'idempotency-key': z.string().min(1).optional() });
const done = new Map<string, { status: number; body: CreatedT }>();
export const r = Router();
r.post('/v1/items', (req, res) => {
  const key = Headers.parse(req.headers)['idempotency-key'];
  const hit = key !== undefined ? done.get(key) : undefined;
  if (hit !== undefined) {
${setup}
    ${send}
    return;
  }
  const item = Created.parse({ id: '1', name: z.object({ name: z.string() }).parse(req.body).name });
  if (key !== undefined) done.set(key, { status: 201, body: item });
  res.status(201).location(\`/v1/items/\${item.id}\`).json(Created.parse(item));
});
`;
  const use = async (code: string): Promise<string> => {
    const root = await tempApi({ 'src/routes.ts': code });
    roots.push(root);
    const ctx = await createCheckContext({ root, exec, harnessRoot: HARNESS_ROOT, logs: memoryLogs() });
    const post = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).all.find((x) => x.method === 'post');
    return post?.idempotencyUse ?? 'missing';
  };
  it.each([
    ['the stored body', 'res.status(hit.status).json(Created.parse(hit.body));', ''],
    ['the stored body through a destructured name', 'res.status(201).json(Created.parse(body));', '    const { body } = hit;'],
    ['the stored body through a conditional with a nullish branch', 'res.status(201).json(Created.parse(again ?? hit.body));', '    const again = Math.random() > 2 ? hit.body : undefined;'],
  ])('replays: %s', async (_label, send, setup) => {
    expect(await use(source(send, setup))).toBe('replays');
  });
  it.each([
    ['a status from the stored record, a body built fresh', "res.status(hit.status).json(Created.parse({ id: 'x', name: 'y' }));", ''],
    ['a spread of the stored body with a changed field', 'res.status(201).json(Created.parse({ ...hit.body, name: `again-${hit.body.name}` }));', ''],
    ['a value built from the stored body, bound to a name first', 'res.status(201).json(Created.parse(copy));', '    const copy = { ...hit.body, id: `${hit.body.id}-again` };'],
    ['a name bound once to the stored body and once to something else', 'res.status(201).json(Created.parse(v));', "    let v = hit.body;\n    if (Math.random() > 2) v = { id: 'x', name: 'y' };"],
  ])('does not replay: %s', async (_label, send, setup) => {
    expect(await use(source(send, setup))).not.toBe('replays');
  });
});
