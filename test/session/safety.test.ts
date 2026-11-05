/**
 * Session safety, each refusal with the twin that passes:
 *   - the owner's git-ignored files and .env.local are never written, by write_file or edit_file (a
 *     git-visible file is); a session will not start without path-guard;
 *   - a second contract cannot take over the bound item's unshipped work (the same slug, edited, can be
 *     proposed again; another slug once the work is gone);
 *   - a refusal the model cannot fix (sandbox off, the branch moved, a read-only checkout) ends its turn
 *     and the harness tells the owner; one it can fix (a denied path) does not;
 *   - the state directories are owner-only; run.json's baseBranch is the contract's Base (none before
 *     one); the read-only prompt never offers a proposal; checkOptions reach the rule list;
 *   - nothing is copied at startup: a file's run-start content is kept right before its first write,
 *     and old sessions' copies are pruned (the newest kept);
 *   - a plain JavaScript web repository gets the in-place web profile;
 *   - /ship records the session's DONE run right before the shipped entry, so `harness item close`
 *     finds no ship-order problem (and refuses a ledger where that run is missing).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerFacts, preconditions } from '../../src/core/close.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { appendLedger, itemPaths, itemStatus, readLedger } from '../../src/core/items.ts';
import { targetProfile } from '../../src/core/run.ts';
import { newRunState } from '../../src/core/run-store.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type { RunContext } from '../../src/core/types.ts';
import { sessionSystemPrompt } from '../../src/session/prompt.ts';
import { initialCopyHook, pruneSessionCopies, runSession } from '../../src/session/session.ts';
import { ScriptedInput } from '../../src/session/input.ts';
import { calls, fakeRemote, git, ledgerTypes, proposal, realRegistry, registryWithGates, runScripted, SessionDriver, TEST_BODY, text, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo;
beforeEach(() => {
  r = webRepo();
});
afterEach(() => r.cleanup());

const TEST_FILE = 'test/greeting-name.test.ts';

describe('the owner\'s git-ignored files and .env.local', () => {
  it('write_file and edit_file to an ignored path or .env.local are refused and leave the owner\'s content as it was; a git-visible file is written (the twin)', async () => {
    const w = webRepo({ extra: { '.gitignore': 'notes/\n.env.local\n' } });
    try {
      mkdirSync(join(w.repo, 'notes'), { recursive: true });
      writeFileSync(join(w.repo, 'notes', 'todo.md'), 'owner notes\n');
      writeFileSync(join(w.repo, '.env.local'), 'SECRET_TOKEN=owner-only\n');
      const ran = await runScripted(
        w,
        [
          calls(['propose_contract', proposal()]),
          calls(
            ['write_file', { path: 'notes/todo.md', content: 'agent notes\n' }],
            ['edit_file', { path: 'notes/todo.md', find: 'owner', replace: 'agent' }],
            ['write_file', { path: '.env.local', content: 'SECRET_TOKEN=agent\n' }],
            ['edit_file', { path: '.env.local', find: 'owner-only', replace: 'agent' }],
            ['write_file', { path: 'docs/notes.md', content: '# notes by the agent\n' }],
          ),
          text('Done what I could.'),
        ],
        ['fix the greeting', 'yes'],
        { registry: await registryWithGates() },
      );
      expect(ran.out).toMatch(/✗ BLOCKED by path-guard: write refused: notes\/todo\.md is ignored by git/);
      expect(ran.out.match(/BLOCKED by path-guard: write refused: notes\/todo\.md is ignored by git/g)).toHaveLength(2);
      expect(ran.out.match(/BLOCKED by path-guard: \.env\.local is harness-owned in place/g)).toHaveLength(2);
      expect(readFileSync(join(w.repo, 'notes', 'todo.md'), 'utf8')).toBe('owner notes\n');
      expect(readFileSync(join(w.repo, '.env.local'), 'utf8')).toBe('SECRET_TOKEN=owner-only\n');
      expect(readFileSync(join(w.repo, 'docs', 'notes.md'), 'utf8')).toBe('# notes by the agent\n');
      expect(ran.out).toMatch(/✎ write_file wrote docs\/notes\.md/);
    } finally {
      w.cleanup();
    }
  });

  it('a session refuses to start without path-guard (the hook that keeps writes off those files); with it, it starts', async () => {
    const reg = await realRegistry();
    let out = '';
    const res = await runSession({ cwd: r.repo, input: new ScriptedInput([], 'tty'), output: { write: (t) => void (out += t), isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: { ...reg, hooks: reg.hooks.filter((h) => h.plugin.name !== 'path-guard') } });
    expect(res.code).toBe(2);
    expect(out).toMatch(/required hook\(s\) path-guard are not registered.*git-ignored or \.env\* file/);
    const ok = await runSession({ cwd: r.repo, input: new ScriptedInput([], 'tty'), output: { write: () => undefined, isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: reg });
    expect(ok.code).toBe(0);
  });
});

describe('a second contract never takes over the bound item\'s work', () => {
  const footer = proposal({ slug: 'footer-text', problem: 'The footer shows last year.', commit: 'fix(footer): show the current year in the footer' });

  it('propose_contract and /import for another slug are refused while the approved item has unshipped changes; the model is stopped', async () => {
    const drafts = join(r.base, 'drafts');
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, 'footer-text.md'), '# footer-text\n');
    const ran = await runScripted(
      r,
      [calls(['propose_contract', proposal()]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), text('Test written.'), calls(['propose_contract', footer]), text('never asked in that turn')],
      ['fix the greeting', 'yes', 'now fix the footer too', `/import ${join(drafts, 'footer-text.md')}`],
      { registry: await registryWithGates() },
    );
    expect(ran.out).toMatch(/✗ propose_contract: propose_contract refused: item greeting-name is approved in this session/);
    expect(ran.out).toMatch(/⏹ the agent stopped: item greeting-name is approved in this session and its changes have not shipped \(1 changed file\(s\): test\/greeting-name\.test\.ts\)/);
    // The model is told why, and that it cannot fix it (the tool result in the transcript).
    const told = readFileSync(join(ran.dir, 'transcript.jsonl'), 'utf8');
    expect(told).toContain('a contract for \\"footer-text\\" would take that work over');
    expect(told).toContain('This is not something you can fix: do not retry it.');
    expect(ran.out).toMatch(/✗ not proposed: item greeting-name is approved in this session and its changes have not shipped/);
    expect(ledgerTypes(ran, 'footer-text')).toEqual([]);
    expect(ran.driver.used).toBe(4);
    expect(ran.runJson['item']).toMatchObject({ slug: 'greeting-name', stage: 'approved' });
  });

  it('twin: the same slug, edited, may be proposed again (it waits for a new yes)', async () => {
    const ran = await runScripted(
      r,
      [calls(['propose_contract', proposal()]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), text('Test written.'), calls(['propose_contract', proposal({ problem: 'The greeting ignores the visitor name, and trims nothing.' })]), text('ok')],
      ['fix the greeting', 'yes', 'also say it trims nothing'],
      { registry: await registryWithGates() },
    );
    expect(ledgerTypes(ran, 'greeting-name')).toEqual(['proposed', 'human_turn', 'approved', 'proposed']);
    expect(ran.out.match(/┌ PROPOSAL greeting-name/g)).toHaveLength(2);
  });

  it('twin: another slug is proposed once the bound item has no change in the tree', async () => {
    const ran = await runScripted(r, [calls(['propose_contract', proposal()]), text('Approved; nothing to change after all.'), calls(['propose_contract', footer]), text('ok')], ['fix the greeting', 'yes', 'then the footer'], { registry: await registryWithGates() });
    expect(ledgerTypes(ran, 'footer-text')).toEqual(['proposed']);
  });
});

describe('a refusal the model cannot fix ends its turn', () => {
  it('a Measure script with the sandbox off: refused, the model is told to stop and report, the turn ends, the owner is told', async () => {
    const ran = await runScripted(
      r,
      [calls(['propose_contract', proposal({ measureScript: "console.log('1');\n" })]), text('I could not propose it: the sandbox is off.')],
      ['fix the greeting', 'what happened?'],
      { extra: { isolation: { mode: 'off', mechanism: 'none', policy: 'test' } } },
    );
    expect(ran.out).toMatch(/✗ propose_contract: propose_contract refused: a Measure script you write runs only where/);
    expect(ran.out).toMatch(/⏹ the agent stopped: a Measure script you write runs only where the sandbox confines it, and the sandbox is off here/);
    // The model's next request is the owner's next message: the turn ended right after the refusal.
    expect(ran.driver.requests).toHaveLength(2);
    const next = JSON.stringify(ran.driver.requests[1]?.messages ?? []);
    expect(next).toContain('what happened?');
    expect(next).toContain('This is not something you can fix: do not retry it. Stop, tell the owner what is wrong');
    expect(next).toContain('[harness] Your last turn was ended by the harness');
    expect(ledgerTypes(ran, 'greeting-name')).toEqual([]);
  });

  it('the branch moved under the session (branch-guard): the turn ends there', async () => {
    const ran = await runScripted(
      r,
      [
        calls(['propose_contract', proposal()]),
        async () => {
          git(r.repo, 'switch', '-q', '-c', 'somewhere-else');
          return calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]);
        },
        calls(['write_file', { path: 'test/other.test.ts', content: TEST_BODY }]),
      ],
      ['fix the greeting', 'yes'],
      { registry: await registryWithGates() },
    );
    expect(ran.out).toMatch(/✗ BLOCKED by branch-guard: write refused: HEAD moved from fix\/greeting/);
    expect(ran.out).toMatch(/⏹ the agent stopped: write refused: HEAD moved from fix\/greeting/);
    expect(ran.driver.used).toBe(2);
    expect(existsSync(join(r.repo, 'test', 'other.test.ts'))).toBe(false);
  });

  it('a read-only checkout: propose_contract is refused and the turn ends', async () => {
    const main = webRepo({ branch: 'main' });
    try {
      const ran = await runScripted(main, [calls(['propose_contract', proposal()]), text('never asked in that turn')], ['fix the greeting']);
      expect(ran.out).toMatch(/⏹ the agent stopped: this session is read-only/);
      expect(ran.driver.used).toBe(1);
    } finally {
      main.cleanup();
    }
  });

  it('twin: a refusal the model can fix (a denied path) leaves the turn running: it writes the allowed file next', async () => {
    const ran = await runScripted(
      r,
      [calls(['propose_contract', proposal()]), calls(['write_file', { path: 'package.json', content: '{}\n' }]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), text('Wrote the test instead.')],
      ['fix the greeting', 'yes'],
      { registry: await registryWithGates() },
    );
    expect(ran.out).toMatch(/✗ BLOCKED by path-guard: package\.json is harness-owned in place/);
    expect(ran.out).not.toMatch(/⏹ the agent stopped/);
    expect(ran.driver.used).toBe(4);
    expect(readFileSync(join(r.repo, TEST_FILE), 'utf8')).toBe(TEST_BODY);
  });
});

describe('records and prompts', () => {
  it('the state directories are owner-only (0700)', async () => {
    const ran = await runScripted(r, [], ['/exit']);
    const root = String(ran.runJson['stateDir']);
    for (const d of [root, join(root, 'sessions'), join(root, 'tokens'), join(root, 'locks')]) expect(statSync(d).mode & 0o777, d).toBe(0o700);
  });

  it('run.json baseBranch: null before a contract, the contract\'s Base after the approval (never the working branch)', async () => {
    const before = await runScripted(r, [], ['/status']);
    expect(before.runJson['baseBranch']).toBeNull();
    const after = await runScripted(r, [calls(['propose_contract', proposal()]), text('ok')], ['fix the greeting', 'yes']);
    expect(after.runJson).toMatchObject({ branch: 'fix/greeting', baseBranch: 'development' });
  });

  it('the read-only prompt never says the model can propose; the writable one does (the twin)', () => {
    const base = { repo: 'tiny-web', branch: 'main', stack: 'web' as const, runner: 'vitest', tools: [], checks: [] };
    const ro = sessionSystemPrompt({ ...base, writable: false, reason: 'the branch main is protected' });
    expect(ro).not.toMatch(/propos/i);
    expect(ro).toMatch(/you can read and explain, nothing more/);
    expect(sessionSystemPrompt({ ...base, writable: true, reason: '' })).toMatch(/call propose_contract/);
  });

  it('checkOptions reach the session\'s rule list (as in file mode); without them, nothing is added', async () => {
    const check = { kind: 'check' as const, id: 'demo-rule', category: 'demo', description: 'admin routes carry the admin decorator', run: async () => [] } as never;
    const base = { repo: 'tiny-web', branch: 'fix/x', writable: true, reason: '', stack: 'web' as const, runner: 'vitest', tools: [], checks: [check] };
    expect(sessionSystemPrompt({ ...base, checkOptions: { 'demo-rule': { adminDecorators: ['AdminOnly'] } } })).toContain('- demo-rule: admin routes carry the admin decorator (configured: adminDecorators: AdminOnly)');
    expect(sessionSystemPrompt(base)).toContain('- demo-rule: admin routes carry the admin decorator\n'.trimEnd());
    expect(sessionSystemPrompt(base)).not.toContain('(configured');
    // In a real session: the configured options of a rule the session lists are in its system prompt.
    const plain = await runScripted(r, [text('hi')], ['hello']);
    const rule = /\n- ([a-z0-9-]+): /.exec((plain.driver.requests[0]?.system ?? '').split('Standards the gates check')[1] ?? '')?.[1];
    expect(rule).toBeDefined();
    const configured = await runScripted(r, [text('hi')], ['hello'], { config: { ...loadConfig(HARNESS_ROOT), checkOptions: { [rule ?? '']: { marker: 'from-config' } } } });
    expect(configured.driver.requests[0]?.system).toContain(`- ${rule ?? ''}: `);
    expect(configured.driver.requests[0]?.system).toMatch(/\(configured: marker: from-config\)/);
  });
});

describe('run-start copies: lazy, and pruned', () => {
  it('a session that only chats copies nothing', async () => {
    const ran = await runScripted(r, [text('hi')], ['hello']);
    const initial = join(ran.dir, 'initial');
    expect(existsSync(initial) ? readdirSync(initial) : []).toEqual([]);
  });

  it('a file\'s run-start content is kept right before its first write (from the file, else the start commit); a new file needs none', async () => {
    const runDir = join(r.base, 'run');
    const ws = createWorkspace(r.repo, '.', { visibility: 'git' });
    const state = newRunState();
    const original = readFileSync(join(r.repo, 'src', 'greeting.ts'), 'utf8');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(original).digest('hex');
    state.initialHashes.set('src/greeting.ts', hash);
    const baseSha = git(r.repo, 'rev-parse', 'HEAD');
    const hook = initialCopyHook({ runDir, top: r.repo, baseSha, exec: coreExec, state: () => state });
    const ctx = { workspace: ws } as unknown as RunContext;
    const call = (path: string) => ({ event: 'pre_tool' as const, call: { id: 'c', tool: 'edit_file', effect: 'write' as const, input: {}, paths: [path] } });
    expect(await hook.plugin.run(call('test/new.test.ts'), ctx)).toEqual({ decision: 'pass' });
    expect(existsSync(join(runDir, 'initial'))).toBe(false);
    // The file already differs (an earlier edit): its content comes from the start commit, verified by its hash.
    writeFileSync(join(r.repo, 'src', 'greeting.ts'), `${original}// changed\n`);
    expect(await hook.plugin.run(call('src/greeting.ts'), ctx)).toEqual({ decision: 'pass' });
    expect(readFileSync(join(runDir, 'initial', hash), 'utf8')).toBe(original);
  });

  it('old sessions\' copies are removed at startup, the newest kept', () => {
    const sessions = join(r.base, 'sessions');
    for (let i = 0; i < 8; i += 1) {
      mkdirSync(join(sessions, `s${i}`, 'initial'), { recursive: true });
      writeFileSync(join(sessions, `s${i}`, 'run.json'), '{}\n');
      const t = new Date(2026, 0, 1 + i);
      utimesSync(join(sessions, `s${i}`), t, t);
    }
    expect(pruneSessionCopies(sessions, 's7', 5).sort()).toEqual(['s0', 's1']);
    expect(readdirSync(sessions).filter((s) => existsSync(join(sessions, s, 'initial'))).sort()).toEqual(['s2', 's3', 's4', 's5', 's6', 's7']);
    // Records stay; only the copies go.
    expect(existsSync(join(sessions, 's0', 'run.json'))).toBe(true);
  });
});

describe('a plain JavaScript web repository', () => {
  it('gets the in-place web profile in a session (stack web, JavaScript is code)', async () => {
    const js = webRepo({ extra: { 'package.json': `${JSON.stringify({ name: 'js-web', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^7.0.0' } })}\n`, 'src/main.js': 'export const hello = (n) => `Hi ${n}`;\n', 'index.html': '<!doctype html><script type="module" src="/src/main.js"></script>\n' } });
    try {
      git(js.repo, 'rm', '-q', 'src/greeting.ts', 'test/greeting.test.ts');
      git(js.repo, 'commit', '-q', '-m', 'javascript only');
      const ran = await runScripted(js, [text('hi')], ['hello']);
      expect(ran.runJson['target']).toMatchObject({ stack: 'web', codeKinds: 'web' });
      expect(JSON.stringify(ran.driver.requests[0]?.messages ?? [])).toContain('stack web');
      // The twin: the same checkout's file-mode profile is not the web one.
      const fileMode = await targetProfile(createWorkspace(js.repo, '.'));
      expect(fileMode.profile?.stack).not.toBe('web');
    } finally {
      js.cleanup();
    }
  });
});

describe.skipIf(detectMechanism() === 'none')('ship, then close', () => {
  const COUNT = "import { readdirSync } from 'node:fs';\nconsole.log(readdirSync('src').length);\n";

  it('/ship records the DONE run of the approved contract right before shipped: close names no ship-order problem; the twin without that run is refused', async () => {
    git(r.repo, 'remote', 'add', 'origin', 'git@github.com:acme/tiny-web.git');
    const seen: string[] = [];
    const ran = await runScripted(
      r,
      [calls(['propose_contract', proposal({ measureScript: COUNT })]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), calls(['finish', { summary: 'test added' }])],
      ['fix the greeting', 'yes', '/ship'],
      { registry: await registryWithGates(), exec: fakeRemote(seen) },
    );
    expect(ran.out).toMatch(/✔ shipped [0-9a-f]{12} on fix\/greeting/);
    const root = String(ran.runJson['itemsRoot']);
    const status = itemStatus(root, 'greeting-name');
    const entries = status.ledger.entries;
    expect(entries.map((e) => e.event.type)).toEqual(['proposed', 'human_turn', 'approved', 'metric', 'run', 'shipped']);
    const run = entries[4]?.event;
    expect(run).toMatchObject({ type: 'run', runId: ran.result.sessionId, verdict: 'DONE', contractHash: status.contract.parse?.hash });
    expect(preconditions({ status, ...ledgerFacts(status) })).toEqual([]);

    // The twin: the same records with the run entry left out (what /ship wrote before this fix).
    const other = join(r.base, 'without-run');
    const paths = itemPaths(other, 'greeting-name');
    mkdirSync(join(other, 'docs', 'contracts'), { recursive: true });
    writeFileSync(paths.contract, readFileSync(itemPaths(root, 'greeting-name').contract, 'utf8'));
    for (const e of readLedger(itemPaths(root, 'greeting-name').ledger).entries) if (e.event.type !== 'run') appendLedger(paths.ledger, e.event);
    const without = itemStatus(other, 'greeting-name');
    expect(without.stage).toBe('shipped');
    expect(preconditions({ status: without, ...ledgerFacts(without) }).join(' ')).toMatch(/the ledger holds no record of that run before it: a shipped line alone proves nothing/);
  });
});
