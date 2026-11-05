/**
 * Owner commands, interruption, secrets, read-only checkouts and the one-session lock. Each refusal
 * has its twin: a protected (or dirty) checkout is read-only, a working branch is writable; .env is
 * never shown, README is; a second session is refused while the first holds the lock, and starts once
 * it is released; Ctrl-C cancels the turn and the next message is served.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec as coreExec } from '../../src/core/exec.ts';
import { cmdItem } from '../../src/core/item-cli.ts';
import { acquireCheckoutLock, repoStateDir } from '../../src/core/state-home.ts';
import { ScriptedInput } from '../../src/session/input.ts';
import { runSession } from '../../src/session/session.ts';
import type { Exec, ModelResponse } from '../../src/core/types.ts';
import { calls, git, ledgerTypes, proposal, realRegistry, registryWithGates, runScripted, SessionDriver, TEST_BODY, text, transcript, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo;
beforeEach(() => {
  r = webRepo();
});
afterEach(() => r.cleanup());

const TEST_FILE = 'test/greeting-name.test.ts';

describe('/status, /diff, /cost, /help, /model, /clear', () => {
  it('report the branch, the item and its stage, the change, the spend', async () => {
    const ran = await runScripted(
      r,
      [calls(['propose_contract', proposal()]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), text('Test written.')],
      ['/diff', 'fix the greeting', 'yes', '/status', '/diff', '/cost', '/help', '/model', '/model not-a-model'],
      { registry: await registryWithGates() },
    );
    expect(ran.out).toContain('no changes in the working tree');
    expect(ran.out).toMatch(/branch {3}fix\/greeting \(writable\)/);
    expect(ran.out).toMatch(/item {5}greeting-name {2}approved {2}\(contract [0-9a-f]{12}\)/);
    expect(ran.out).toContain(`changed  1 file(s): ${TEST_FILE}`);
    expect(ran.out).toMatch(/model {4}scripted:session-test {2}· {2}spend \$0\.0000 of \$2\.00/);
    expect(ran.out).toContain(`new file ${TEST_FILE}`);
    expect(ran.out).toContain("+import { test } from 'node:test';");
    expect(ran.out).toMatch(/spend {4}\$0\.0000 of the \$2\.00 cap \(scripted:session-test/);
    expect(ran.out).toMatch(/\/ship {12}commit, push and open the PR/);
    expect(ran.out).toMatch(/allowed {2}gpt-5\.6-luna, claude-haiku-4-5-20251001/);
    expect(ran.out).toMatch(/✗ no driver serves model "not-a-model"/);
  });

  it('/diff colours nothing and hides nothing but .env content; tracked changes show as a diff', async () => {
    const steps = [calls(['propose_contract', proposal()]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), text('ok')];
    const lines = ['fix it', 'yes', () => {
      writeFileSync(join(r.repo, 'README.md'), '# tiny-web\n\nnow with names\n');
      writeFileSync(join(r.repo, '.env.local'), 'SECRET_TOKEN=do-not-show-me\n');
      return '/diff';
    }];
    const ran = await runScripted(r, steps, lines, { registry: await registryWithGates() });
    expect(ran.out).toContain('+now with names');
    expect(ran.out).toContain('new file .env.local');
    expect(ran.out).toContain('(an environment file: its content is never shown)');
    expect(ran.out).not.toContain('do-not-show-me');
  });

  it('/clear starts a new conversation: the next request does not carry the old one', async () => {
    const ran = await runScripted(r, [text('first answer'), text('second answer')], ['remember the word ZEBRA', '/clear', 'what was the word?']);
    expect(ran.out).toContain('new conversation: same session, item, records and spend');
    expect(JSON.stringify(ran.driver.requests[1]?.messages)).not.toContain('ZEBRA');
    expect(JSON.stringify(ran.driver.requests[0]?.messages)).toContain('ZEBRA');
    expect(transcript(ran).some((e) => typeof e === 'object' && e !== null && 'cleared' in e)).toBe(true);
  });

  it('an unknown command is named, never sent to the model', async () => {
    const ran = await runScripted(r, [], ['/frobnicate']);
    expect(ran.out).toContain('unknown command /frobnicate (/help lists them)');
    expect(ran.driver.used).toBe(0);
  });
});

describe('Ctrl-C', () => {
  it('cancels the running turn and returns to the prompt; the next message is served', async () => {
    const input = new ScriptedInput(['work on something long', 'hello again'], 'tty');
    const wait = (_req: unknown, signal: AbortSignal | undefined): Promise<ModelResponse> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('request aborted')));
        setTimeout(() => input.fireInterrupt(), 5);
      });
    const ran = await runScripted(r, [wait, text('Hello again! Ready.')], [], { input });
    expect(ran.out).toContain('⏹ interrupted: the turn was cancelled. Back to you.');
    expect(ran.out).toContain('Hello again! Ready.');
    expect(ran.result.code).toBe(0);
  });

  it('twice on an empty prompt ends the session (once only warns)', async () => {
    const ran = await runScripted(r, [text('never')], [{ interrupt: true }, 'hi', { interrupt: true }, { interrupt: true }, 'never read']);
    expect(ran.out).toContain('(Ctrl-C again on an empty prompt to exit, or /exit)');
    expect(ran.driver.used).toBe(1);
    expect(ran.input.prompts).toHaveLength(4);
    expect(ran.runJson['status']).toBe('ended');
  });

  it('during /status, /diff, /gates, /import and /ship a handler hears it and says what finishes first; every command completes', async () => {
    let armed = false;
    let input: ScriptedInput | null = null;
    const fired: boolean[] = [];
    // The first git command a command runs plays a Ctrl-C (nothing listening would have ended the process).
    const exec: Exec = (cmd, args, o) => {
      if (armed && cmd === 'git') {
        armed = false;
        fired.push(input?.fireInterrupt() ?? false);
      }
      return coreExec(cmd, args, o);
    };
    const arm = (line: string) => (): string => {
      armed = true;
      return line;
    };
    input = new ScriptedInput(['fix it', 'yes', arm('/status'), arm('/diff'), arm('/gates'), arm('/ship'), arm('/import nowhere.md'), 'hello'], 'tty');
    const ran = await runScripted(r, [calls(['propose_contract', proposal()]), calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]), text('written'), text('still here')], [], { input, exec, registry: await registryWithGates() });
    expect(fired).toEqual([true, true, true, true, true]);
    for (const what of ['/status', '/diff', 'the gates', '/ship', '/import']) expect(ran.out).toContain(`finishing ${what} first; Ctrl-C again after it ends to exit`);
    expect(ran.out).toMatch(/item {5}greeting-name {2}approved/);
    expect(ran.out).toContain(`new file ${TEST_FILE}`);
    expect(ran.out).toMatch(/● committed [0-9a-f]{12} on fix\/greeting/);
    expect(ran.out).toMatch(/✗ not proposed: no such file/);
    expect(ran.out).toContain('still here');
    expect(ran.runJson['status']).toBe('ended');
  });

  it('a Ctrl-C while the harness was busy counts as the first: one more on the empty prompt exits (twin of "once only warns")', async () => {
    let input: ScriptedInput | null = null;
    const busy: Exec = (cmd, args, o) => {
      if (cmd === 'git' && args.includes('symbolic-ref') && input !== null && input.prompts.length === 1) input.fireInterrupt();
      return coreExec(cmd, args, o);
    };
    input = new ScriptedInput(['/status', { interrupt: true }, 'never read'], 'tty');
    const ran = await runScripted(r, [], [], { input, exec: busy });
    expect(ran.out).toContain('finishing /status first; Ctrl-C again after it ends to exit');
    expect(ran.input.prompts).toHaveLength(2);
    expect(ran.runJson['status']).toBe('ended');
  });
});

describe('secrets stay out of reach', () => {
  it('.env cannot be read, listed or searched, even when tracked; README can (the twin)', async () => {
    const withEnv = webRepo({ extra: { '.env': 'API_TOKEN=super-secret-abc123\n' } });
    try {
      const ran = await runScripted(
        withEnv,
        [calls(['read_file', { path: '.env' }], ['list_files', {}], ['search_code', { pattern: 'super-secret' }], ['read_file', { path: 'README.md' }]), text('I cannot read .env.')],
        ['show me the env file'],
      );
      expect(ran.out).toMatch(/✗ read_file: read_file: \.env is an environment file \(\.env\*\): it can hold secrets/);
      expect(ran.out).toMatch(/● read_file README\.md/);
      const everything = ran.out + readFileSync(join(ran.dir, 'transcript.jsonl'), 'utf8') + readFileSync(join(ran.dir, 'events.jsonl'), 'utf8');
      expect(everything).not.toContain('super-secret-abc123');
      // list_files shows the four other files, never .env; search_code never looks inside it.
      const results = transcript(ran).flatMap((e) => ((e as { results?: Array<{ content?: string }> | null }).results ?? []).map((p) => p.content ?? ''));
      const listing = results.find((c) => / files under /.test(c)) ?? '';
      expect(listing).toContain('README.md');
      expect(listing).not.toContain('.env');
      expect(results).toContain('no matches for "super-secret" in 2 files');
    } finally {
      withEnv.cleanup();
    }
  });
});

describe('read-only checkouts', () => {
  it('a protected branch is read-only, says why and the fix; propose_contract is refused', async () => {
    const main = webRepo({ branch: 'main' });
    try {
      const ran = await runScripted(main, [calls(['propose_contract', proposal()]), text('Read-only here.')], ['fix the greeting']);
      expect(ran.out).toMatch(/branch main \(read-only\)/);
      expect(ran.out).toContain('read-only: the branch main is protected (harness.config.json protectedBranches); create a working branch: git switch -c <name> (from main). Chat and reading work; every edit is refused.');
      expect(ran.out).toMatch(/✗ propose_contract: propose_contract refused: this session is read-only/);
      expect(ledgerTypes(ran, 'greeting-name')).toEqual([]);
      expect(ran.runJson).toMatchObject({ writable: false, readOnly: { reason: 'the branch main is protected (harness.config.json protectedBranches)' } });
    } finally {
      main.cleanup();
    }
  });

  it('a dirty working tree is read-only too, with the stash fix', async () => {
    writeFileSync(join(r.repo, 'README.md'), '# changed before the session\n');
    const ran = await runScripted(r, [], ['/status']);
    expect(ran.out).toMatch(/read-only: the working tree has 1 uncommitted change\(s\) \(README\.md\)/);
    expect(ran.out).toContain('git stash -u');
  });

  it('twin: a clean working branch is writable', async () => {
    const ran = await runScripted(r, [], ['/status']);
    expect(ran.out).toMatch(/branch {3}fix\/greeting \(writable\)/);
  });
});

describe('starting', () => {
  it('outside a git repository: a clear message and exit 2', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'not-git-')));
    try {
      let out = '';
      const res = await runSession({ cwd: dir, input: new ScriptedInput([], 'tty'), output: { write: (t) => void (out += t), isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: await realRegistry() });
      expect(res.code).toBe(2);
      expect(out).toMatch(/is not inside a git repository\. cd into a repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts on the repository top from any sub-directory', async () => {
    let out = '';
    const res = await runSession({ cwd: join(r.repo, 'src'), input: new ScriptedInput([], 'tty'), output: { write: (t) => void (out += t), isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: await realRegistry() });
    expect(res.code).toBe(0);
    expect(out).toMatch(/repo tiny-web {2}branch fix\/greeting/);
  });

  it('a second session on the same checkout is refused with the holder\'s pid; once released, it starts', async () => {
    const dirs = await repoStateDir(r.repo, r.env);
    const held = acquireCheckoutLock(dirs.locksDir, r.repo, { releaseOnExit: false });
    expect(held.ok).toBe(true);
    let out = '';
    const res = await runSession({ cwd: r.repo, input: new ScriptedInput([], 'tty'), output: { write: (t) => void (out += t), isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: await realRegistry() });
    expect(res.code).toBe(2);
    expect(out).toMatch(new RegExp(`a session is already running in .*tiny-web \\(pid ${process.pid}, started`));
    if (held.ok) held.release();
    const again = await runSession({ cwd: r.repo, input: new ScriptedInput([], 'tty'), output: { write: () => undefined, isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: await realRegistry() });
    expect(again.code).toBe(0);
  });

  it('a session that fails says so (exit 1) and still releases its lock', async () => {
    const broken = await runScripted(r, [], [() => {
      throw new Error('terminal gone');
    }]);
    expect(broken.result.code).toBe(1);
    expect(broken.out).toContain('harness: the session stopped: terminal gone');
    const next = await runScripted(r, [], []);
    expect(next.result.code).toBe(0);
  });

  it('a piped owner line is echoed, so a piped transcript reads in order (a terminal echoes it itself)', async () => {
    const piped = await runScripted(r, [text('Hi.')], ['hello'], { channel: 'pipe' });
    expect(piped.out).toMatch(/› hello\n┆ Hi\./);
    const typed = await runScripted(r, [text('Hi.')], ['hello']);
    expect(typed.out).not.toContain('› hello');
  });

  it('a session releases its lock when it ends (the next one starts)', async () => {
    const first = await runScripted(r, [], ['/exit']);
    expect(first.result.code).toBe(0);
    const second = await runScripted(r, [], []);
    expect(second.result.code).toBe(0);
  });

  it('refuses to start without the required in-place hooks', async () => {
    const reg = await realRegistry();
    let out = '';
    const res = await runSession({ cwd: r.repo, input: new ScriptedInput([], 'tty'), output: { write: (t) => void (out += t), isTTY: false }, env: r.env, driver: new SessionDriver([]), registry: { ...reg, hooks: reg.hooks.filter((h) => h.plugin.name !== 'branch-guard') } });
    expect(res.code).toBe(2);
    expect(out).toMatch(/required hook\(s\) branch-guard are not registered/);
  });
});

describe('harness item inside the repository', () => {
  it('finds a session item in the repository\'s records (HARNESS_ITEMS_ROOT unset), and close defaults --repo to it', async () => {
    await runScripted(r, [calls(['propose_contract', proposal()]), text('ok')], ['fix it', 'yes']);
    const lines: string[] = [];
    const env = { ...r.env };
    delete env['HARNESS_ITEMS_ROOT'];
    expect(await cmdItem({ positionals: ['status', 'greeting-name'], flags: new Map() }, (l) => lines.push(l), { cwd: r.repo, env })).toBe(0);
    expect(lines[0]).toMatch(/^item greeting-name: from this repository's session records/);
    expect(lines[1]).toMatch(/^greeting-name\s+approved/);
    const close: string[] = [];
    expect(await cmdItem({ positionals: ['close', 'greeting-name'], flags: new Map() }, (l) => close.push(l), { cwd: r.repo, env })).toBe(1);
    expect(close.join('\n')).toMatch(/no Measure: the outcome cannot be read \(the contract says "Measure: none"\)/);
    expect(close.join('\n')).not.toMatch(/--repo <dir> is needed/);
  });

  it('twin: HARNESS_ITEMS_ROOT still wins (the item is not there)', async () => {
    await runScripted(r, [calls(['propose_contract', proposal()]), text('ok')], ['fix it', 'yes']);
    const lines: string[] = [];
    const other = mkdtempSync(join(tmpdir(), 'items-'));
    try {
      await cmdItem({ positionals: ['status', 'greeting-name'], flags: new Map() }, (l) => lines.push(l), { cwd: r.repo, env: { ...r.env, HARNESS_ITEMS_ROOT: other } });
      expect(lines[0]).toMatch(/^greeting-name\s+no-contract/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('git is untouched by chat', () => {
  it('a session that only chats leaves the branch, the index and the tree as they were', async () => {
    const before = git(r.repo, 'rev-parse', 'HEAD');
    await runScripted(r, [text('hi')], ['hello']);
    expect(git(r.repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
    expect(git(r.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/greeting');
  });
});
