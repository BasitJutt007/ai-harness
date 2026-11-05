/**
 * Where the owner's lines come from, and on which channel.
 *
 * The channel decides what a reply can do: only a line typed at an interactive terminal ('tty') can
 * approve a contract (items.ts approvalVerdict). The terminal reader takes it from process.stdin itself;
 * nothing the model, a tool or a file says can choose it. Tests inject a scripted source whose channel
 * is explicit.
 *
 * On a terminal:
 *   - Lines that arrive in one burst are one message: a bracketed paste (when the terminal supports it,
 *     the lines between its start and end marks, plus the line the owner then ends with Enter), else
 *     lines that arrive within a short coalescing window of each other. Only lines typed after a turn
 *     has started are dropped (never queued: a "yes" typed early must not become the answer to a
 *     proposal shown later), and the owner is told so once per turn.
 *   - A read for a reply to a proposal (`read(prompt, { approval: true })`) first clears any half-typed
 *     line: text typed before the PROPOSAL box was shown is never the reply to it.
 *   - Ctrl-C goes to the innermost handler (onInterrupt is a stack): the running turn is cancelled, or a
 *     command that must finish says so. At the prompt, Ctrl-C clears a half-typed line (and counts for
 *     nothing); on an empty prompt it is reported to the session (twice exits). Before the session reads
 *     its first line (startup) nothing is listening and Ctrl-C quits the process; once it runs, the
 *     process is never ended by Ctrl-C (a child process or a measure worktree is never left behind).
 * A pipe is a script: read in order, line by line, to the end. Ctrl-D (end of input) exits.
 */
import { createInterface, emitKeypressEvents, type Interface } from 'node:readline';
import { PassThrough } from 'node:stream';
import type { TurnChannel } from '../core/items.ts';

export type OwnerLine = { kind: 'line'; text: string } | { kind: 'eof' } | { kind: 'interrupt' };

export interface ReadOptions {
  /** The read takes the reply to a proposal: anything typed before it is cleared first. */
  approval?: boolean;
}

export interface OwnerInput {
  /** 'tty' when lines are typed at an interactive terminal, else 'pipe'. */
  readonly channel: TurnChannel;
  /** The owner's next message at the prompt (or end of input, or Ctrl-C on an empty prompt). */
  read(prompt: string, opts?: ReadOptions): Promise<OwnerLine>;
  /** Ctrl-C while the session is busy: the innermost `cb` is called. Returns the unsubscribe. */
  onInterrupt(cb: () => void): () => void;
  close(): void;
}

/** How long lines may be apart to count as one burst (a paste without bracketed-paste marks). */
export const BURST_MS = 40;

/** Bracketed paste on and off (DECSET 2004): the terminal marks a paste, readline reports the marks. */
const PASTE_ON = '\u001b[?2004h';
const PASTE_OFF = '\u001b[?2004l';

/** Whether this Node's keypress parser reports bracketed-paste marks (paste-start / paste-end). */
export function pasteKeysSupported(): boolean {
  const probe = new PassThrough();
  let seen = false;
  emitKeypressEvents(probe);
  probe.on('keypress', (_s: unknown, k: { name?: string } | undefined) => {
    if (k?.name === 'paste-start') seen = true;
  });
  probe.write('\u001b[200~');
  probe.end();
  return seen;
}

export interface TerminalInputOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** One-line notices for the owner (a dropped line, a cleared half-typed line, a busy Ctrl-C). */
  notify?: (text: string) => void;
  /** The coalescing window for a burst of lines (default BURST_MS). */
  burstMs?: number;
  /** Ends the process at startup on Ctrl-C (default process.exit). */
  exit?: (code: number) => void;
}

/** The real terminal (or pipe) on process.stdin. */
export function terminalInput(opts: TerminalInputOptions = {}): OwnerInput {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const notify = opts.notify ?? (() => undefined);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const burstMs = opts.burstMs ?? BURST_MS;
  const tty = stdin.isTTY === true;
  const rl: Interface = createInterface({ input: stdin, output: stdout, terminal: tty, historySize: tty ? 200 : 0 });
  let waiting: ((l: OwnerLine) => void) | null = null;
  const queued: OwnerLine[] = [];
  const handlers: Array<() => void> = [];
  let closed = false;
  /** The session has asked for its first line: from now on Ctrl-C never ends the process. */
  let live = false;
  /** Lines of a burst that started while a read was pending (delivered as one message). */
  let burst: string[] | null = null;
  let burstTimer: NodeJS.Timeout | null = null;
  /** Inside a bracketed paste. */
  let pasting = false;
  /** A paste ended mid-line: the owner's Enter ends the message (now, not after a window). */
  let afterPaste = false;
  /** The owner was told, during this busy stretch, that a line was not sent. */
  let droppedNotified = false;

  const deliver = (l: OwnerLine): void => {
    if (waiting !== null) {
      const w = waiting;
      waiting = null;
      w(l);
    } else queued.push(l);
  };
  const clearBurst = (): void => {
    if (burstTimer !== null) clearTimeout(burstTimer);
    burstTimer = null;
    burst = null;
    afterPaste = false;
  };
  const flushBurst = (): void => {
    const lines = burst;
    clearBurst();
    if (lines !== null && lines.length > 0) deliver({ kind: 'line', text: lines.join('\n') });
  };
  const armBurst = (): void => {
    if (burstTimer !== null) clearTimeout(burstTimer);
    burstTimer = setTimeout(flushBurst, burstMs);
    burstTimer.unref?.();
  };
  const dropped = (): void => {
    if (droppedNotified) return;
    droppedNotified = true;
    notify('(the agent is working: what you typed was not sent; type it again at the prompt. Ctrl-C interrupts the turn)');
  };
  const clearTyped = (): boolean => {
    if (rl.line.length === 0) return false;
    rl.write(null, { ctrl: true, name: 'u' });
    rl.write(null, { ctrl: true, name: 'k' });
    return true;
  };

  rl.on('line', (text) => {
    if (!tty) {
      deliver({ kind: 'line', text });
      return;
    }
    if (burst !== null) {
      // The burst continues (a paste, or a line within the window): one message.
      burst.push(text);
      if (pasting) return;
      if (afterPaste) flushBurst();
      else armBurst();
      return;
    }
    if (waiting === null) {
      dropped();
      return;
    }
    burst = [text];
    if (!pasting) armBurst();
  });
  if (tty && pasteKeysSupported()) {
    stdout.write(PASTE_ON);
    stdin.on('keypress', (_s: unknown, k: { name?: string } | undefined) => {
      if (k?.name === 'paste-start') {
        pasting = true;
        if (burst === null && waiting !== null) burst = [];
        if (burstTimer !== null) clearTimeout(burstTimer);
        burstTimer = null;
      } else if (k?.name === 'paste-end') {
        pasting = false;
        if (burst === null) return;
        // A paste that ended mid-line waits for the owner's Enter, which ends it; else it is sent now.
        if (rl.line.length > 0) afterPaste = true;
        else if (burst.length > 0) flushBurst();
        else clearBurst();
      }
    });
  }
  rl.on('close', () => {
    closed = true;
    flushBurst();
    deliver({ kind: 'eof' });
  });
  const onSigint = (): void => {
    const top = handlers.at(-1);
    if (top !== undefined) {
      top();
      return;
    }
    if (waiting !== null) {
      // At the prompt: a half-typed line (or a burst being collected) is cleared, and that is all.
      const hadBurst = burst !== null;
      clearBurst();
      if (clearTyped() || hadBurst) {
        stdout.write('\n');
        rl.prompt();
        return;
      }
      deliver({ kind: 'interrupt' });
      return;
    }
    if (live) {
      // The session is running something that has no handler of its own: it finishes first.
      notify('(busy: the harness finishes what it is doing first; Ctrl-C again at the prompt to exit)');
      return;
    }
    // Nothing is listening yet (the session is still starting): Ctrl-C quits, as it would anywhere else.
    // The session lock is released by its process-exit handler.
    rl.close();
    stdout.write('\n');
    exit(130);
  };
  rl.on('SIGINT', onSigint);
  // A piped stdin gets a real signal instead of a key press.
  if (!tty) process.on('SIGINT', onSigint);

  return {
    channel: tty ? 'tty' : 'pipe',
    read(prompt, ro = {}) {
      live = true;
      droppedNotified = false;
      if (ro.approval === true && tty) {
        // What was typed before the proposal was shown is not a reply to it.
        const hadBurst = burst !== null;
        clearBurst();
        if (clearTyped() || hadBurst) notify('(cleared what was typed before the proposal: type your reply now)');
      }
      const next = queued.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.resolve({ kind: 'eof' });
      return new Promise((resolve) => {
        waiting = resolve;
        if (tty) {
          rl.setPrompt(prompt);
          rl.prompt(true);
        }
      });
    },
    onInterrupt(cb) {
      handlers.push(cb);
      return () => {
        const i = handlers.lastIndexOf(cb);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    close() {
      if (!tty) process.removeListener('SIGINT', onSigint);
      clearBurst();
      if (tty && !closed) stdout.write(PASTE_OFF);
      rl.close();
    },
  };
}

/** One scripted step: a line, end of input, Ctrl-C at the prompt, or a function run when read (a test hook). */
export type ScriptStep = string | { eof: true } | { interrupt: true } | (() => OwnerLine | string);

/**
 * A scripted owner for tests and demos: lines in order, on an explicit channel. `fireInterrupt()`
 * plays a Ctrl-C while the session is busy (what a test driver calls mid-turn or mid-command).
 */
export class ScriptedInput implements OwnerInput {
  readonly prompts: string[] = [];
  /** Which reads asked for a reply to a proposal (approval: true), by index into `prompts`. */
  readonly approvalReads: number[] = [];
  private readonly handlers: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly steps: ScriptStep[],
    readonly channel: TurnChannel,
  ) {}

  read(prompt: string, opts: ReadOptions = {}): Promise<OwnerLine> {
    if (opts.approval === true) this.approvalReads.push(this.prompts.length);
    this.prompts.push(prompt);
    if (this.closed) return Promise.resolve({ kind: 'eof' });
    const s = this.steps.shift();
    if (s === undefined) return Promise.resolve({ kind: 'eof' });
    if (typeof s === 'string') return Promise.resolve({ kind: 'line', text: s });
    if (typeof s === 'function') {
      const r = s();
      return Promise.resolve(typeof r === 'string' ? { kind: 'line', text: r } : r);
    }
    return Promise.resolve('eof' in s ? { kind: 'eof' } : { kind: 'interrupt' });
  }

  onInterrupt(cb: () => void): () => void {
    this.handlers.push(cb);
    return () => {
      const i = this.handlers.lastIndexOf(cb);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /** Ctrl-C while the session is busy; false when nothing is listening. */
  fireInterrupt(): boolean {
    const top = this.handlers.at(-1);
    if (top === undefined) return false;
    top();
    return true;
  }

  close(): void {
    this.closed = true;
  }
}
