import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { formatCommand, prBody, scanDiffForSecrets, ship } from '../../src/core/ship.ts';
import type { Exec } from '../../src/core/types.ts';
import { brownfieldTask, git, isolatedExec, makeCtx, repoTmp, stubGate, writeFiles } from './helpers.ts';

const tmp = repoTmp('ship');
afterAll(() => tmp.cleanup());

let counter = 0;
/** A repo with an `api/` root, a local bare remote with main pushed, and a feature branch checked out. */
async function setup(branch = 'harness/projects-change'): Promise<{ repo: string; remote: string; baseSha: string; branch: string }> {
  const dir = join(tmp.dir, `case-${++counter}`);
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  writeFiles(repo, { 'api/src/app.ts': 'export const v = 1;\n', 'README.md': 'readme\n' });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  await git(dir, 'init', '-q', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-q', 'origin', 'refs/heads/main:refs/heads/main');
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  if (branch !== 'main') await git(repo, 'checkout', '-q', '-b', branch);
  // the agent's work: one change inside the API root, one outside it
  writeFiles(repo, { 'api/src/app.ts': 'export const v = 2;\n', 'api/src/new.ts': 'export const n = 1;\n', 'README.md': 'changed outside\n' });
  return { repo, remote, baseSha, branch };
}

const pass = stubGate('stub', { status: 'pass', summary: 'all good' });

/** Intercept gh: `missing` → not installed; `ok` → authenticated, pr create prints a URL. Never runs the real gh. */
function withGh(mode: 'missing' | 'ok', calls: string[][] = []): Exec {
  return (cmd, args, opts) => {
    if (cmd !== 'gh') return isolatedExec(cmd, args, opts);
    calls.push(args);
    if (mode === 'missing') return Promise.resolve({ code: null, stdout: '', stderr: 'spawn gh ENOENT', durationMs: 0, timedOut: false });
    const out = args[0] === 'pr' ? 'https://example.test/org/repo/pull/7\n' : 'ok\n';
    return Promise.resolve({ code: 0, stdout: out, stderr: '', durationMs: 0, timedOut: false });
  };
}

function ctxFor(s: { repo: string; baseSha: string; branch: string }, exec: Exec, gates = [pass]) {
  return makeCtx({ repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: s.branch, baseBranch: 'main', baseSha: s.baseSha, exec, gates });
}

async function remoteRefs(remote: string): Promise<Map<string, string>> {
  const out = await git(tmp.dir, 'ls-remote', remote);
  return new Map(out.split('\n').filter((l) => l !== '').map((l) => {
    const [sha = '', ref = ''] = l.split('\t');
    return [ref, sha] as const;
  }));
}

describe('ship', () => {
  it('refuses a protected branch', async () => {
    const s = await setup('main');
    const r = await ship({ ctx: ctxFor(s, withGh('missing')), registry: ctxFor(s, withGh('missing')).registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons[0]).toContain('protected branch "main"');
    expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
  });

  it('refuses when the branch is the base branch', async () => {
    const s = await setup('feature/x');
    const ctx = makeCtx({ repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: 'feature/x', baseBranch: 'feature/x', baseSha: s.baseSha, exec: withGh('missing'), gates: [pass] });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons[0]).toContain('is the base branch');
  });

  it('refuses when a gate fails (gates are re-run fresh) and commits nothing', async () => {
    const s = await setup();
    const failing = stubGate('broken', { status: 'fail', summary: 'tests red', details: ['FAIL test/x.test.ts'] });
    const ctx = ctxFor(s, withGh('missing'), [pass, failing]);
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toContain('broken');
    expect(r.reasons.join('\n')).toContain('FAIL test/x.test.ts');
    expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
    expect(await git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses when no gate passed (unproven is never green)', async () => {
    const s = await setup();
    const ctx = ctxFor(s, withGh('missing'), [stubGate('u', { status: 'unproven', summary: 'skipped' })]);
    expect((await ship({ ctx, registry: ctx.registry, dryRun: false })).status).toBe('refused');
  });

  it('dry run plans the exact commands without executing any', async () => {
    const s = await setup();
    const ctx = ctxFor(s, withGh('ok'));
    const r = await ship({ ctx, registry: ctx.registry, dryRun: true });
    expect(r.status).toBe('dry-run');
    expect(r.commands?.some((c) => c.includes(`push --no-force -u origin refs/heads/${s.branch}:refs/heads/${s.branch}`))).toBe(true);
    expect(r.commands?.some((c) => c.startsWith('gh pr create --base main --head harness/projects-change'))).toBe(true);
    expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
    expect(await git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
    expect((await remoteRefs(s.remote)).has(`refs/heads/${s.branch}`)).toBe(false);
  });

  it('dry run never invokes gh and says the PR step depends on it', async () => {
    const s = await setup();
    const ghCalls: string[][] = [];
    const ctx = ctxFor(s, withGh('ok', ghCalls));
    const r = await ship({ ctx, registry: ctx.registry, dryRun: true });
    expect(r.status).toBe('dry-run');
    expect(ghCalls).toEqual([]);
    expect(r.reasons.join('\n')).toMatch(/PR step depends on gh/);
  });

  it('PR body reads token totals from an absolute tokens dir and cites the real run dir', async () => {
    const s = await setup();
    const runDir = join(tmp.dir, 'evidence', 'runs', 'projects-change-scripted-20261002-120000');
    const tokensDir = join(tmp.dir, 'evidence', 'tokens');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, 'projects-change-scripted-20261002-120000.json'), JSON.stringify({
      totals: { actual_input_tokens: 120, baseline_input_tokens: 2400, reduction_pct: 95 },
    }));
    const base = makeCtx({ repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: s.branch, baseBranch: 'main', baseSha: s.baseSha, exec: withGh('missing'), gates: [pass], runDir });
    const ctx = { ...base, config: { ...base.config, tokensDir } };
    const body = prBody(ctx, { ok: true, results: [], text: 'gates ok', compact: '' });
    // No baseline_kind recorded: the body must not present the number as measured.
    expect(body).toContain('actual 120 vs shadow baseline (an estimate, never sent; measure with --baseline + tokens compare) 2400 input tokens (reduction 95%)');
    expect(body).toContain(`Run evidence: ${relative(HARNESS_ROOT, runDir).split('\\').join('/')}/`);
    expect(body).not.toContain('Run evidence: runs/');
  });

  it('commits only the API root as sf-harness and pushes the branch; gh missing → committed', async () => {
    const s = await setup();
    const ghCalls: string[][] = [];
    const ctx = ctxFor(s, withGh('missing', ghCalls));
    const before = await remoteRefs(s.remote);
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('committed');
    expect(r.reasons.join(' ')).toContain('gh CLI is not installed');
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);

    const refs = await remoteRefs(s.remote);
    expect(refs.get(`refs/heads/${s.branch}`)).toBe(r.commit);
    expect(refs.get('refs/heads/main')).toBe(before.get('refs/heads/main'));
    expect([...refs.keys()].sort()).toEqual(['refs/heads/harness/projects-change', 'refs/heads/main']);

    expect(await git(s.repo, 'log', '-1', '--format=%an <%ae>')).toBe('sf-harness <harness@localhost>');
    const msg = await git(s.repo, 'log', '-1', '--format=%B');
    expect(msg).toContain('run: projects-change-scripted-20261002-120000');
    expect(msg).toContain('gate  stub');
    expect((await git(s.repo, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort()).toEqual(['api/src/app.ts', 'api/src/new.ts']);
    expect(await git(s.repo, 'status', '--porcelain')).toBe('M README.md');
    expect(await git(s.repo, 'rev-parse', 'main')).toBe(s.baseSha);
    expect(ghCalls.some((a) => a[0] === 'pr')).toBe(false);
  });

  it('opens a PR via gh when installed and authenticated → shipped', async () => {
    const s = await setup();
    const ghCalls: string[][] = [];
    const ctx = ctxFor(s, withGh('ok', ghCalls));
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('shipped');
    expect(r.prUrl).toBe('https://example.test/org/repo/pull/7');
    const pr = ghCalls.find((a) => a[0] === 'pr');
    expect(pr?.slice(0, 6)).toEqual(['pr', 'create', '--base', 'main', '--head', 'harness/projects-change']);
    const body = pr?.[pr.indexOf('--body') + 1] ?? '';
    expect(body).toContain('gate  stub');
    expect(body).toContain('### Tokens');
  });

  it('no remote → committed, not pushed', async () => {
    const s = await setup();
    await git(s.repo, 'remote', 'remove', 'origin');
    const ctx = ctxFor(s, withGh('ok'));
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('committed');
    expect(r.reasons[0]).toContain('no remote "origin"');
  });

  it('refuses and unstages when the staged diff contains a secret', async () => {
    const s = await setup();
    writeFileSync(join(s.repo, 'api', 'src', 'new.ts'), `export const key = "AKIA${'A'.repeat(16)}";\n`);
    const ctx = ctxFor(s, withGh('missing'));
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join('\n')).toContain('AWS access key id');
    expect(r.reasons.join('\n')).not.toContain('A'.repeat(16));
    expect(await git(s.repo, 'rev-parse', 'HEAD')).toBe(s.baseSha);
    expect(await git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses when the worktree is not on the run branch', async () => {
    const s = await setup();
    const ctx = makeCtx({ repoRoot: s.repo, rootRel: 'api', task: brownfieldTask(), branch: 'harness/other', baseBranch: 'main', baseSha: s.baseSha, exec: withGh('missing'), gates: [pass] });
    const r = await ship({ ctx, registry: ctx.registry, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons[0]).toContain('not the run branch');
  });
});

describe('ship helpers', () => {
  it('scanDiffForSecrets reports redacted added lines with line numbers', () => {
    const diff = ['+++ b/api/src/x.ts', '@@ -0,0 +3,2 @@', '+const a = 1;', `+const k = "sk-${'x'.repeat(30)}";`].join('\n');
    expect(scanDiffForSecrets(diff)).toEqual(['api/src/x.ts:4  sk- style API key sk-x…(33 chars)']);
  });
  it('formatCommand quotes unsafe arguments', () => {
    expect(formatCommand('git', ['commit', '-m', 'a b'])).toBe('git commit -m "a b"');
  });
});
