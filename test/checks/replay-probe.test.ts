/**
 * The runtime replay probe of rest-conventions (replay-probe.ts): independent evidence next to the static
 * idempotency analysis. The harness serves the app (confined), sends the same keyed request twice and judges
 * the two responses itself. A retry that is not replayed fails the route even when the static analysis
 * accepted it; an inconclusive probe (no body can be generated) leaves the static verdict as it is.
 */
import { afterAll, describe, expect, it } from 'vitest';
import restConventions from '../../plugins/checks/rest-conventions.ts';
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

async function check(source: string): Promise<{ findings: CheckFinding[]; text: string; log: string }> {
  const root = await tempApi({ 'src/app.ts': APP, 'src/routes.ts': source });
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

  it('no valid body can be generated (a regex the probe cannot satisfy): inconclusive, the static pass stands', async () => {
    const { findings, text, log } = await check(routes({ name: 'z.string().regex(/^[a-z]+-[0-9]{4}$/)', replay: '{ id: `${hit.id}-again`, name: hit.name }' }));
    expect(findings, text).toEqual([expect.objectContaining({ status: 'pass', units: { passed: 1, total: 1 } })]);
    expect(log).toMatch(/POST \/v1\/items: inconclusive: no valid body can be generated/);
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
