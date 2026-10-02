import { afterEach, describe, expect, it } from 'vitest';
import type { CheckFinding, CheckPlugin, CheckReport, GatePlugin, RunContext } from '../../src/core/plugin-api.ts';
import { runChecks } from '../../src/core/checks.ts';
import observedRedGate from '../../plugins/gates/observed-red.ts';
import scopeGate from '../../plugins/gates/scope.ts';
import secretsGate from '../../plugins/gates/secrets.ts';
import standardsGate from '../../plugins/gates/standards.ts';
import testsGreen from '../../plugins/gates/tests-green.ts';
import { recordUnlocked } from '../../plugins/lib/red.ts';
import { brownfieldTask, HARNESS_ROOT, makeHarness, realExec, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

async function harness(opts: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = await makeHarness({ label: 'gates', ...opts });
  dirs.push(h.dir);
  return h;
}

const run = (g: GatePlugin, ctx: RunContext, phase: 'finish' | 'ship' = 'finish') => g.run(ctx, phase);

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await realExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

describe('tests-green gate', () => {
  it('passes when all tests pass, fails on failures', async () => {
    const h = await harness({ files: { 'test/a.test.ts': 'x', 'test/b.test.ts': 'y' } });
    expect(await run(testsGreen, h.ctx)).toMatchObject({ status: 'pass', summary: '2/2 tests passed in 2 files' });
    h.outcomes.set('test/b.test.ts', 'fail');
    const r = await run(testsGreen, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toContain('1 failed');
    expect(r.logPath).toBe('runs/x/logs/001-vitest.txt');
    h.outcomes.set('test/b.test.ts', 'error');
    h.outcomes.set('test/a.test.ts', 'error');
    expect((await run(testsGreen, h.ctx)).status).toBe('fail');
  });

  it('is unproven when nothing ran or the runner crashed', async () => {
    const empty = await harness();
    expect((await run(testsGreen, empty.ctx)).status).toBe('unproven');
    const crash = await harness({ services: { runTests: async () => { throw new Error('vitest missing'); } } });
    expect(await run(testsGreen, crash.ctx)).toMatchObject({ status: 'unproven', summary: 'test runner failed: vitest missing' });
  });
});

describe('observed-red gate', () => {
  const files = {
    'test/items.test.ts': "import { x } from '../src/items.ts';\n",
    'src/items.ts': 'export const x = 1;\n',
    'src/other.ts': 'export const y = 1;\n',
  };

  it('fails without any red, and when a changed file has no red test', async () => {
    const h = await harness({ files });
    expect((await run(observedRedGate, h.ctx)).summary).toBe('no observed red in this run');

    h.outcomes.set('test/items.test.ts', 'fail');
    await h.services.runTests();
    // Greenfield: nothing in initialHashes, so both src files count as changed; other.ts has no test.
    recordUnlocked(h.ctx.state, 'src/items.ts');
    recordUnlocked(h.ctx.state, 'src/other.ts');
    const r = await run(observedRedGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details).toEqual(['src/other.ts: no covering test']);
  });

  it('passes when every changed src file has a red-observed covering test (brownfield)', async () => {
    const h = await harness({ files, task: brownfieldTask() });
    h.ctx.state.initialHashes.set('src/items.ts', sha('export const x = 0;\n'));
    h.ctx.state.initialHashes.set('src/other.ts', sha(files['src/other.ts']));
    h.outcomes.set('test/items.test.ts', 'fail');
    await h.services.runTests();
    recordUnlocked(h.ctx.state, 'src/items.ts');
    expect(await run(observedRedGate, h.ctx)).toMatchObject({ status: 'pass' });
  });

  it('is unproven when the test map cannot be built', async () => {
    const h = await harness({ files, services: { testMap: async () => { throw new Error('parse error'); } } });
    h.ctx.state.tests.push({ file: 'test/items.test.ts', hash: 'h', status: 'fail', collected: 1, failed: 1, validRed: true, reason: '', turn: 1, at: '' });
    expect((await run(observedRedGate, h.ctx)).status).toBe('unproven');
  });
});

describe('standards gate', () => {
  const report = (status: 'pass' | 'fail' | 'unproven'): CheckReport => ({
    root: '/x',
    findings: [],
    rules: [{ rule: 'zod-boundary', category: 'standards', unit: 'handlers', status, passed: 1, total: 1, files: 1 }],
    verdict: { status, percent: status === 'pass' ? 100 : 50 },
    text: 'full',
    compact: 'zod-boundary      FAIL  src/a.ts  1/2 handlers\nverdict 50%',
  });

  it('maps verdicts to gate statuses', async () => {
    for (const [verdict, expected] of [['pass', 'pass'], ['fail', 'fail'], ['unproven', 'unproven']] as const) {
      const h = await harness({ services: { runChecks: async () => report(verdict) } });
      const r = await run(standardsGate, h.ctx);
      expect(r.status).toBe(expected);
      if (expected === 'fail') expect(r.details?.[0]).toContain('zod-boundary');
    }
    const crash = await harness({ services: { runChecks: async () => { throw new Error('boom'); } } });
    expect((await run(standardsGate, crash.ctx)).status).toBe('unproven');
  });
});

describe('standards gate: diff-aware for non-standards rules (real check runner)', () => {
  /** Greenfield-style scaffold: read-only to the agent (path-guard), so a pre-existing violation there must not deadlock DONE. */
  const SCAFFOLD: Record<string, string> = {
    'src/server.ts': "import { app } from './app.ts';\napp.listen(3000, () => console.log('listening'));\n",
    'src/lib/http.ts': 'export const ok = 200;\n',
    'src/app.ts': 'export const app = { listen: (_p: number, f: () => void) => f() };\n',
  };
  const ITEMS = 'export const items: string[] = [];\n';

  /** A standards-category rule (passes on every source file) and a dropped-in lint rule flagging console calls. */
  const standardsRule = (failOn?: string): CheckPlugin => ({
    kind: 'check', id: 'zod-boundary', category: 'standards', unit: 'handlers',
    async run(ctx) {
      return ctx.sourceFiles.map((file): CheckFinding => (file === failOn
        ? { rule: 'zod-boundary', file, status: 'fail', units: { passed: 0, total: 1 }, violations: [{ location: `${file}:1:1`, message: 'unparsed body' }] }
        : { rule: 'zod-boundary', file, status: 'pass', units: { passed: 1, total: 1 }, violations: [] }));
    },
  });
  const noConsole: CheckPlugin = {
    kind: 'check', id: 'no-console', category: 'lint', unit: 'files',
    async run(ctx) {
      const out: CheckFinding[] = [];
      for (const file of ctx.sourceFiles) {
        const violations = (await ctx.read(file)).split('\n').flatMap((line, i) =>
          line.includes('console.') ? [{ location: `${file}:${i + 1}:${line.indexOf('console.') + 1}`, message: 'console call' }] : []);
        out.push({ rule: 'no-console', file, status: violations.length > 0 ? 'fail' : 'pass', units: { passed: violations.length > 0 ? 0 : 1, total: 1 }, violations });
      }
      return out;
    },
  };
  const ormNone: CheckPlugin = { kind: 'check', id: 'orm-users-select', category: 'orm', unit: 'queries', run: async () => [] };

  async function greenfield(files: Record<string, string>, checks: CheckPlugin[]) {
    const h = await harness({ files: { ...SCAFFOLD, ...files } });
    // run-start snapshot = the scaffold, exactly as executeRun takes it after scaffolding
    for (const [rel, content] of Object.entries(SCAFFOLD)) h.ctx.state.initialHashes.set(rel, sha(content));
    h.ctx.services.runChecks = (o) => runChecks({
      root: h.ws.root, checks, exec: realExec, harnessRoot: HARNESS_ROOT, logs: h.ctx.logs,
      ...(o?.rules !== undefined ? { rules: o.rules } : {}),
    });
    return h;
  }

  it('a lint violation in an unchanged scaffold file is pre-existing: the gate passes and says so', async () => {
    const h = await greenfield({ 'src/routes/items.ts': ITEMS }, [standardsRule(), noConsole, ormNone]);
    const r = await run(standardsGate, h.ctx);
    expect(r.status, JSON.stringify(r)).toBe('pass');
    expect(r.summary).toContain('1 pre-existing violation(s) in files this run did not change (not blocking)');
    expect(r.summary).toContain('1 n/a');
    expect(r.details).toEqual(["pre-existing (not blocking): no-console src/server.ts:2:24  console call"]);
  });

  it('the same rule on a file this run changed fails the gate (and still lists the pre-existing one)', async () => {
    const h = await greenfield({ 'src/routes/items.ts': `${ITEMS}console.log(items);\n` }, [standardsRule(), noConsole]);
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/1 violation\(s\) in files this run changed; 1 pre-existing/);
    expect(r.details).toEqual([
      'changed file: no-console src/routes/items.ts:2:1  console call',
      "pre-existing (not blocking): no-console src/server.ts:2:24  console call",
    ]);
  });

  it('editing the scaffold file makes its violation blocking (hash differs from the run-start snapshot)', async () => {
    const h = await greenfield({ 'src/routes/items.ts': ITEMS }, [standardsRule(), noConsole]);
    await h.ws.write('src/server.ts', `${SCAFFOLD['src/server.ts'] ?? ''}// edited\n`);
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toBe('changed file: no-console src/server.ts:2:24  console call');
  });

  it('standards-category rules stay strict over the whole API: a violation in an unchanged file still fails', async () => {
    const h = await greenfield({ 'src/routes/items.ts': ITEMS }, [standardsRule('src/lib/http.ts'), noConsole]);
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.join('\n')).toContain('zod-boundary');
  });

  it('a skipped non-standards rule makes the gate unproven, even when its only violations are pre-existing', async () => {
    const crash: CheckPlugin = { kind: 'check', id: 'orm-crash', category: 'orm', run: async () => { throw new Error('no parser'); } };
    const h = await greenfield({ 'src/routes/items.ts': ITEMS }, [standardsRule(), noConsole, crash]);
    const r = await run(standardsGate, h.ctx);
    expect(r.status).toBe('unproven');
  });

  it('a project-level finding is attributed by each violation location; an unattributable one blocks', async () => {
    const project = (location: string): CheckPlugin => ({
      kind: 'check', id: 'lint-project', category: 'lint',
      run: async () => [{ rule: 'lint-project', file: '(project)', status: 'fail', units: { passed: 0, total: 1 }, violations: [{ location, message: 'bad' }] }],
    });
    const pre = await greenfield({ 'src/routes/items.ts': ITEMS }, [standardsRule(), project('src/lib/http.ts:1:1')]);
    expect(await run(standardsGate, pre.ctx)).toMatchObject({ status: 'pass', details: ['pre-existing (not blocking): lint-project src/lib/http.ts:1:1  bad'] });
    const unknown = await greenfield({ 'src/routes/items.ts': ITEMS }, [standardsRule(), project('(somewhere)')]);
    expect((await run(standardsGate, unknown.ctx)).status).toBe('fail');
  });

  it('only n/a rules besides nothing: nothing proven → unproven', async () => {
    const h = await greenfield({}, [ormNone]);
    expect((await run(standardsGate, h.ctx)).status).toBe('unproven');
  });
});

describe('scope gate (real git repo)', () => {
  async function repo(task = brownfieldTask()) {
    const h = await harness({ task, files: { 'src/a.ts': 'export const a = 1;\n', 'package.json': '{}\n' } });
    await git(h.dir, 'init', '-q');
    await git(h.dir, 'add', '-A');
    await git(h.dir, 'commit', '-q', '-m', 'init');
    return h;
  }

  it('passes for in-scope changes and fails for out-of-scope ones', async () => {
    const h = await repo();
    await h.ws.write('src/a.ts', 'export const a = 2;\n');
    await h.ws.write('test/a.test.ts', 'x\n');
    expect(await run(scopeGate, h.ctx)).toMatchObject({ status: 'pass', summary: '2 changed files, all in scope' });

    await h.ws.write('package.json', '{"x":1}\n');
    const r = await run(scopeGate, h.ctx);
    expect(r.status).toBe('fail');
    expect(r.details?.[0]).toContain('package.json');

    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${h.dir}/outside.ts`, 'x');
    expect((await run(scopeGate, h.ctx)).details).toContain('outside.ts: outside the API root api');
  });

  it('accepts untouched scaffold files that equal their initial hash', async () => {
    const h = await repo();
    await h.ws.write('tsconfig.json', '{}\n'); // untracked scaffold file
    h.ctx.state.initialHashes.set('tsconfig.json', sha('{}\n'));
    expect((await run(scopeGate, h.ctx)).status).toBe('pass');
    await h.ws.write('tsconfig.json', '{"strict":false}\n');
    expect((await run(scopeGate, h.ctx)).status).toBe('fail');
  });

  it('is unproven when git status fails', async () => {
    const h = await harness({ exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository', durationMs: 0, timedOut: false }) });
    expect((await run(scopeGate, h.ctx)).status).toBe('unproven');
  });
});

describe('secrets gate (real git repo)', () => {
  it('runs in the ship phase only', () => {
    expect(secretsGate.phases).toEqual(['ship']);
  });

  it('passes on clean changes and fails on staged or untracked secrets', async () => {
    const h = await harness({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    await git(h.dir, 'init', '-q');
    await git(h.dir, 'add', '-A');
    await git(h.dir, 'commit', '-q', '-m', 'init');

    await h.ws.write('src/a.ts', 'export const a = process.env.A;\n');
    expect((await run(secretsGate, h.ctx, 'ship')).status).toBe('pass');

    await h.ws.write('src/a.ts', `export const a = 1;\nexport const k = "${'sk-' + 'x'.repeat(32)}";\n`);
    await git(h.dir, 'add', '-A');
    const staged = await run(secretsGate, h.ctx, 'ship');
    expect(staged.status).toBe('fail');
    expect(staged.details).toEqual([expect.stringMatching(/^api\/src\/a\.ts:2 {2}sk- style API key sk-x…/)]);

    await git(h.dir, 'reset', '-q', '--hard');
    await h.ws.write('src/new.ts', `-----BEGIN ${'PRIVATE'} KEY-----\n`);
    const untracked = await run(secretsGate, h.ctx, 'ship');
    expect(untracked.details).toEqual(['api/src/new.ts:1  PEM private key ----…(27 chars)']);
  });

  it('is unproven when git fails', async () => {
    const h = await harness({ exec: async () => ({ code: 128, stdout: '', stderr: 'fatal', durationMs: 0, timedOut: false }) });
    expect((await run(secretsGate, h.ctx, 'ship')).status).toBe('unproven');
  });
});
