/**
 * diff-budget (docs/workflow.md, Where I lose time 2: review round-trips on large PRs). A change over
 * the changed-lines budget is refused; the small twin, and a budget the task raised on purpose, pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import diffBudget, { DEFAULT_MAX_DIFF_LINES } from '../../plugins/gates/diff-budget.ts';
import type { BrownfieldTask, GateResult } from '../../src/core/plugin-api.ts';
import { brownfieldTask, greenfieldTask, makeHarness, realExec, removeTmp } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await realExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const lines = (n: number, tag = 'x'): string => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

/** A committed API root `api/` with one source file of 100 lines; then `edits` are written on top. */
async function setup(edits: Record<string, string>, task: BrownfieldTask = brownfieldTask()) {
  const h = await makeHarness({ label: 'diff-budget', task, files: { 'src/app.ts': lines(100) } });
  dirs.push(h.dir);
  await git(h.dir, 'init', '-q');
  await git(h.dir, 'add', '-A');
  await git(h.dir, 'commit', '-q', '-m', 'base');
  (h.ctx.run as { baseSha: string }).baseSha = await git(h.dir, 'rev-parse', 'HEAD');
  for (const [rel, content] of Object.entries(edits)) await h.ws.write(rel, content);
  return h;
}

const run = async (h: Awaited<ReturnType<typeof setup>>): Promise<GateResult> => diffBudget.run(h.ctx, 'finish');

describe('diff-budget: a change stays small enough to review', () => {
  it('passes a small change, counting a changed file (added + deleted) and a new file whole', async () => {
    const h = await setup({ 'src/app.ts': lines(100).replace('x0 = 0', 'x0 = 1'), 'test/app.test.ts': lines(30, 't') });
    const r = await run(h);
    expect(r.status).toBe('pass');
    expect(r.summary).toBe(`32 changed lines in 2 file(s), within the budget of ${DEFAULT_MAX_DIFF_LINES}`);
  });

  it(`refuses a change over the default budget of ${DEFAULT_MAX_DIFF_LINES} lines, naming the largest files`, async () => {
    const h = await setup({ 'src/big.ts': lines(390, 'b'), 'test/big.test.ts': lines(20, 't') });
    const r = await run(h);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/^410 changed lines in 2 file\(s\), over the budget of 400: split the item, or raise limits\.maxDiffLines/);
    expect(r.details?.[0]).toBe('api/src/big.ts: 390 changed lines');
  });

  it('a budget the task file raised on purpose holds instead', async () => {
    const task = { ...brownfieldTask(), limits: { maxTurns: 10, maxOutputTokens: 1000, maxDiffLines: 500 } };
    const h = await setup({ 'src/big.ts': lines(390, 'b'), 'test/big.test.ts': lines(20, 't') }, task);
    expect((await run(h)).status).toBe('pass');
  });

  it('dependency trees are never counted', async () => {
    const h = await setup({ 'node_modules/pkg/index.ts': lines(900, 'n') });
    const r = await run(h);
    expect(r.status).toBe('pass');
    expect(r.summary).toMatch(/^0 changed lines/);
  });

  it('is n/a for greenfield (a new API is all new lines) and UNPROVEN when git cannot say what changed', async () => {
    const g = await makeHarness({ label: 'diff-budget-g', task: greenfieldTask() });
    dirs.push(g.dir);
    expect((await diffBudget.run(g.ctx, 'finish')).status).toBe('n/a');
    const h = await setup({});
    (h.ctx.run as { baseSha: string }).baseSha = 'f'.repeat(40);
    expect((await run(h)).status).toBe('unproven');
  });
});
