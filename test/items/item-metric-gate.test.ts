/**
 * item-metric gate: a run is DONE only when the item's own metric, read by the harness on the run's
 * tree, differs from the before value read at proposal. Paired: the moved metric passes; the same
 * tree with the metric unmoved fails; every way of not having a comparable reading is UNPROVEN.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import gate from '../../plugins/gates/item-metric.ts';
import { exec } from '../../src/core/exec.ts';
import { parseContract, proposeItem, recordReply } from '../../src/core/items.ts';
import type { MetricReading } from '../../src/core/items.ts';
import type { RunContext } from '../../src/core/types.ts';
import { contractFor, writeContract } from '../support/items.ts';

const SLUG = 'metric-gate';
const SCRIPT = "import { readFileSync } from 'node:fs';\nconsole.log('reading value.txt');\nconsole.log(readFileSync('value.txt', 'utf8').trim());\n";
const sha = (t: string): string => createHash('sha256').update(t).digest('hex');

let dir: string;
let harness: string;
let items: string;
let tree: string;

function before(value: number, script = SCRIPT): MetricReading {
  return { value, sha: 'a'.repeat(40), ref: 'origin/main', command: 'node metrics/value.mjs', scriptSha256: sha(script), stdoutSha256: '', excerpt: String(value), confinement: 'test' };
}

function setup(beforeValue: MetricReading | null, treeValue: string): RunContext {
  const contract = contractFor(SLUG, { Measure: 'node metrics/value.mjs' });
  writeContract(items, SLUG, contract);
  proposeItem(items, SLUG, { session: 't', before: beforeValue });
  recordReply(items, SLUG, 'yes', 'tty', 't');
  writeFileSync(join(tree, 'value.txt'), treeValue);
  return {
    run: { harnessRoot: harness },
    task: { kind: 'brownfield' },
    workspace: { repoRoot: tree },
    item: { slug: SLUG, root: items, contractHash: parseContract(contract).hash },
    exec,
  } as unknown as RunContext;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'item-metric-'));
  harness = join(dir, 'harness');
  items = join(dir, 'items-root');
  tree = join(dir, 'tree');
  for (const d of [join(harness, 'metrics'), items, tree]) mkdirSync(d, { recursive: true });
  writeFileSync(join(harness, 'metrics', 'value.mjs'), SCRIPT);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('item-metric gate', () => {
  it('passes when the run tree reads a different value from the before value', async () => {
    const r = await gate.run(setup(before(4), '0'), 'finish');
    expect(r.status).toBe('pass');
    expect(r.summary).toMatch(/before 4 .*this run's tree 0/);
  }, 30_000);

  it('fails when the run tree reads the before value: the change has not reached the problem', async () => {
    const r = await gate.run(setup(before(4), '4'), 'finish');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/did not move: .*before 4 .*this run's tree 4/);
    expect(r.details).toContain('reading value.txt');
  }, 30_000);

  it('is unproven without a before value', async () => {
    const r = await gate.run(setup(null, '0'), 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toMatch(/no before value/);
  }, 30_000);

  it('is unproven when the Measure script changed since the before value was read', async () => {
    const r = await gate.run(setup(before(4, `${SCRIPT}// edited\n`), '0'), 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toMatch(/changed since the before value was read/);
  }, 30_000);

  it('is unproven when the metric cannot be read on the run tree (no number, no pass)', async () => {
    const r = await gate.run(setup(before(4), 'not a number'), 'finish');
    expect(r.status).toBe('unproven');
    expect(r.summary).toMatch(/could not be read on the run tree: Measure printed no number/);
  }, 30_000);

  it('is n/a for a run bound to no item (stakeholder-yes refuses that run)', async () => {
    const ctx = setup(before(4), '0');
    const r = await gate.run({ ...ctx, item: undefined } as RunContext, 'finish');
    expect(r.status).toBe('n/a');
  }, 30_000);
});
