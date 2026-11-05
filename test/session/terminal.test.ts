/**
 * The keyboard, on a fake terminal (a TTY stream: readline in raw mode, Ctrl-C as the \u0003 key). Each
 * refusal has its twin:
 *   - lines pasted in one burst are one message (a bracketed paste, or a burst within the window); lines
 *     typed apart are separate; only lines typed while the session is busy are dropped, and the owner is
 *     told once per busy stretch;
 *   - a read for a reply clears what was typed before it (a chat read keeps the type-ahead);
 *   - Ctrl-C at startup ends the process; once the session runs it never does: the innermost handler
 *     hears it, or the owner is told the harness finishes first; on a half-typed line it only clears it;
 *   - in a whole session: a "yes" typed before the PROPOSAL box is never the reply (a "yes" typed after
 *     it is); a Ctrl-C during the before reading or the test baseline is answered with what is being
 *     finished, the process is not ended, and the measure worktree is cleaned up.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec as coreExec } from '../../src/core/exec.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import type { Exec } from '../../src/core/types.ts';
import { terminalInput, type OwnerInput } from '../../src/session/input.ts';
import { runSession } from '../../src/session/session.ts';
import { BASELINE, calls, proposal, registryWithGates, SessionDriver, text, webRepo, type Step, type WebRepo } from './helpers.ts';

interface FakeTty {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  type(s: string): void;
  screen(): string;
}

/** A terminal: stdin is a TTY (raw mode is a no-op), stdout records what readline draws. */
function fakeTty(): FakeTty {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (b: boolean) => unknown };
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100 });
  let screen = '';
  (stdout as unknown as PassThrough).on('data', (d: Buffer) => {
    screen += d.toString();
  });
  return { stdin, stdout, type: (s) => void (stdin as unknown as PassThrough).write(s), screen: () => screen };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('pasted lines are one message', () => {
  it('several lines pasted in one burst (no paste marks) arrive as one message', async () => {
    const t = fakeTty();
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 20 });
    const got = input.read('› ');
    t.type('first line\nsecond line\nthird line\n');
    expect(await got).toEqual({ kind: 'line', text: 'first line\nsecond line\nthird line' });
    input.close();
  });

  it('a bracketed paste is one message, ended by the owner\'s Enter when it ends mid-line (the window plays no part)', async () => {
    const t = fakeTty();
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 60_000 });
    expect(t.screen()).toContain('\u001b[?2004h');
    let settled: unknown = null;
    const got = input.read('› ').then((l) => (settled = l));
    t.type('\u001b[200~alpha\nbeta\ngamma\u001b[201~');
    await tick(30);
    expect(settled).toBeNull();
    t.type('\r');
    expect(await got).toEqual({ kind: 'line', text: 'alpha\nbeta\ngamma' });
    // A paste that ends with a newline is sent as soon as it ends.
    const next = input.read('› ');
    t.type('\u001b[200~one\ntwo\n\u001b[201~');
    expect(await next).toEqual({ kind: 'line', text: 'one\ntwo' });
    input.close();
    expect(t.screen()).toContain('\u001b[?2004l');
  });

  it('twin: lines typed apart are separate messages; lines typed while the session is busy are dropped, and the owner is told once', async () => {
    const t = fakeTty();
    const notes: string[] = [];
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 10, notify: (n) => notes.push(n) });
    const first = input.read('› ');
    t.type('one\r');
    expect(await first).toEqual({ kind: 'line', text: 'one' });
    // Busy (no read pending): two lines, one notice, nothing queued.
    t.type('typed while busy\r');
    t.type('and again\r');
    expect(notes.filter((n) => /was not sent/.test(n))).toHaveLength(1);
    await tick(30);
    const second = input.read('› ');
    t.type('two\r');
    expect(await second).toEqual({ kind: 'line', text: 'two' });
    t.type('busy again\r');
    expect(notes.filter((n) => /was not sent/.test(n))).toHaveLength(2);
    input.close();
  });
});

describe('a reply starts clean', () => {
  it('a read for a reply clears what was typed before it, and says so', async () => {
    const t = fakeTty();
    const notes: string[] = [];
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 5, notify: (n) => notes.push(n) });
    const first = input.read('› ');
    t.type('go\r');
    await first;
    t.type('yes');
    const reply = input.read('reply › ', { approval: true });
    expect(notes).toContain('(cleared what was typed before the proposal: type your reply now)');
    t.type('no thanks\r');
    expect(await reply).toEqual({ kind: 'line', text: 'no thanks' });
    input.close();
  });

  it('twin: a chat read keeps the type-ahead', async () => {
    const t = fakeTty();
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 5 });
    const first = input.read('› ');
    t.type('go\r');
    await first;
    t.type('hel');
    const next = input.read('› ');
    t.type('lo\r');
    expect(await next).toEqual({ kind: 'line', text: 'hello' });
    input.close();
  });
});

describe('Ctrl-C on the terminal', () => {
  it('at startup (nothing has been read yet) it ends the process, as anywhere else', () => {
    const t = fakeTty();
    const exits: number[] = [];
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, exit: (c) => exits.push(c) });
    t.type('\u0003');
    expect(exits).toEqual([130]);
    input.close();
  });

  it('once the session runs it never ends the process: a handler hears it, else the owner is told the harness finishes first', async () => {
    const t = fakeTty();
    const exits: number[] = [];
    const notes: string[] = [];
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 5, exit: (c) => exits.push(c), notify: (n) => notes.push(n) });
    const first = input.read('› ');
    t.type('go\r');
    await first;
    t.type('\u0003');
    expect(exits).toEqual([]);
    expect(notes.at(-1)).toMatch(/busy: the harness finishes what it is doing first/);
    // The innermost handler hears it (a command inside a turn, say), then the outer one again.
    const heard: string[] = [];
    const offOuter = input.onInterrupt(() => heard.push('turn'));
    const offInner = input.onInterrupt(() => heard.push('command'));
    t.type('\u0003');
    offInner();
    t.type('\u0003');
    offOuter();
    expect(heard).toEqual(['command', 'turn']);
    expect(exits).toEqual([]);
    input.close();
  });

  it('on a half-typed line it clears the line and counts for nothing; on an empty prompt it is reported', async () => {
    const t = fakeTty();
    const input = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 5 });
    let settled: unknown = null;
    const got = input.read('› ').then((l) => (settled = l));
    t.type('half typed');
    t.type('\u0003');
    await tick(10);
    expect(settled).toBeNull();
    t.type('\u0003');
    expect(await got).toEqual({ kind: 'interrupt' });
    // The cleared text is gone: the next line is only what is typed now.
    const next = input.read('› ');
    t.type('fresh\r');
    expect(await next).toEqual({ kind: 'line', text: 'fresh' });
    input.close();
  });
});

// ───────────── whole sessions on the fake terminal ─────────────

let r: WebRepo;
beforeEach(() => {
  r = webRepo();
});
afterEach(() => r.cleanup());

interface TtyRun {
  out: string;
  notes: string[];
  exits: number[];
  runJson: Record<string, unknown>;
  driver: SessionDriver;
}

/**
 * A session on the fake terminal. `typist` is called each time the session reads (its index, the
 * prompt) and returns what the owner then types on the terminal, or null to type nothing.
 */
async function ttySession(steps: Step[], typist: (n: number, prompt: string, t: FakeTty) => string | null, opts: { exec?: Exec; measureBaseline?: () => Promise<typeof BASELINE>; build?: (t: FakeTty, input: OwnerInput) => void } = {}): Promise<TtyRun> {
  const t = fakeTty();
  const notes: string[] = [];
  const exits: number[] = [];
  let out = '';
  const terminal = terminalInput({ stdin: t.stdin, stdout: t.stdout, burstMs: 5, notify: (n) => notes.push(n), exit: (c) => exits.push(c) });
  let reads = 0;
  const input: OwnerInput = {
    channel: terminal.channel,
    read(prompt, o) {
      const got = terminal.read(prompt, o);
      const typed = typist(reads, prompt, t);
      reads += 1;
      if (typed !== null) setImmediate(() => t.type(typed));
      return got;
    },
    onInterrupt: (cb) => terminal.onInterrupt(cb),
    close: () => terminal.close(),
  };
  opts.build?.(t, input);
  const driver = new SessionDriver(steps);
  const result = await runSession({
    cwd: r.repo,
    input,
    output: { write: (s) => void (out += s), isTTY: false },
    env: r.env,
    exec: opts.exec ?? coreExec,
    registry: await registryWithGates(),
    driver,
    measureBaseline: opts.measureBaseline ?? (async () => BASELINE),
    isolation: { mode: 'auto', mechanism: 'sandbox-exec', policy: 'test' },
    sessionId: `tty${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  });
  input.close();
  const dir = result.sessionDir ?? '';
  const runJson = dir !== '' && existsSync(join(dir, 'run.json')) ? (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>) : {};
  return { out, notes, exits, runJson, driver };
}

function ledgerOf(run: TtyRun, slug: string): Array<{ type: string; text?: string }> {
  const file = join(String(run.runJson['itemsRoot']), 'items', slug, 'ledger.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { event: { type: string; text?: string } }).event) : [];
}

/** The model proposes; while it does, the owner has typed "yes" without Enter (before the box exists). */
function proposeWhileOwnerTypes(t: () => FakeTty): Step[] {
  return [
    async () => {
      t().type('yes');
      return calls(['propose_contract', proposal()]);
    },
    text('Understood.'),
  ];
}

describe('a whole session on a terminal', () => {
  it('"yes" typed before the PROPOSAL box is cleared, never the reply (Enter alone sends nothing): the next typed line is', async () => {
    let tty: FakeTty | null = null;
    const run = await ttySession(proposeWhileOwnerTypes(() => tty as unknown as FakeTty), (n, prompt) => {
      if (n === 0) return 'fix the greeting\r';
      if (n === 1) return '\r';
      if (prompt === 'reply › ') return 'no thanks\r';
      return '/exit\r';
    }, { build: (t) => (tty = t) });
    expect(run.notes).toContain('(cleared what was typed before the proposal: type your reply now)');
    const ledger = ledgerOf(run, 'greeting-name');
    expect(ledger.map((e) => e.type)).toEqual(['proposed', 'human_turn', 'declined']);
    expect(ledger[1]?.text).toBe('no thanks');
    expect(run.out).not.toMatch(/✔ approved/);
  });

  it('twin: "yes" typed after the box approves', async () => {
    let tty: FakeTty | null = null;
    const run = await ttySession(proposeWhileOwnerTypes(() => tty as unknown as FakeTty), (n, prompt) => {
      if (n === 0) return 'fix the greeting\r';
      if (prompt === 'reply › ') return 'yes\r';
      return '/exit\r';
    }, { build: (t) => (tty = t) });
    expect(run.out).toMatch(/✔ approved: Ada Owner approved proposal seq 1/);
    expect(ledgerOf(run, 'greeting-name').map((e) => e.type)).toEqual(['proposed', 'human_turn', 'approved']);
  });

  it('Ctrl-C during the test baseline says what is finished first and does not end the process; Ctrl-C again at the prompt exits', async () => {
    let tty: FakeTty | null = null;
    const run = await ttySession(
      [calls(['propose_contract', proposal()]), text('Approved, thanks.')],
      (n, prompt) => (n === 0 ? 'fix the greeting\r' : prompt === 'reply › ' ? 'yes\r' : '\u0003'),
      {
        build: (t) => (tty = t),
        measureBaseline: async () => {
          tty?.type('\u0003');
          await tick(20);
          return BASELINE;
        },
      },
    );
    expect(run.exits).toEqual([]);
    expect(run.out).toContain("finishing the repository's own tests (the baseline) first; Ctrl-C again after it ends to exit");
    // The baseline finished (recorded), and the one Ctrl-C at the prompt then ended the session cleanly.
    expect(run.out).toContain('Approved, thanks.');
    expect(run.runJson['status']).toBe('ended');
  });

  it.skipIf(detectMechanism() === 'none')('Ctrl-C during the before reading: the reading finishes, the measure worktree is removed, the process is not ended', async () => {
    let tty: FakeTty | null = null;
    const slow = "const until = Date.now() + 400;\nwhile (Date.now() < until) { /* measuring */ }\nconsole.log(5);\n";
    let fired = false;
    const exec: Exec = async (cmd, args, o) => {
      if (!fired && args.some((a) => a.endsWith('measure.mjs'))) {
        fired = true;
        setTimeout(() => tty?.type('\u0003'), 50);
      }
      return coreExec(cmd, args, o);
    };
    const run = await ttySession(
      [calls(['propose_contract', proposal({ measureScript: slow })]), text('ok')],
      (n, prompt) => (n === 0 ? 'fix the greeting\r' : prompt === 'reply › ' ? 'yes\r' : '/exit\r'),
      { build: (t) => (tty = t), exec },
    );
    expect(fired).toBe(true);
    expect(run.exits).toEqual([]);
    expect(run.out).toContain('finishing the before reading first; Ctrl-C again after it ends to exit');
    expect(run.out).toMatch(/before value: 5 \(read by the harness at development [0-9a-f]{12}\)/);
    expect(ledgerOf(run, 'greeting-name').map((e) => e.type)).toEqual(['proposed', 'human_turn', 'approved', 'metric']);
    const worktrees = execFileSync('git', ['-C', r.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(worktrees.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    const measureDir = join(HARNESS_ROOT, '.harness', 'measure');
    expect(existsSync(measureDir) ? readdirSync(measureDir).filter((d) => d.startsWith('greeting-name-')) : []).toEqual([]);
  });

  it('a pasted multi-line request reaches the model as one message; a pasted text that starts with "/" is chat, not a command', async () => {
    const run = await ttySession([text('Got both lines.'), text('Chat, not a command.')], (n) => {
      if (n === 0) return '\u001b[200~the greeting ignores names\nand trims nothing\n\u001b[201~';
      if (n === 1) return '\u001b[200~/diff is what I would run\nbut tell me first\n\u001b[201~';
      return '/exit\r';
    });
    const first = JSON.stringify(run.driver.requests[0]?.messages ?? []);
    expect(first).toContain('the greeting ignores names\\nand trims nothing');
    expect(run.driver.used).toBe(2);
    expect(run.out).not.toContain('no changes in the working tree');
  });
});
