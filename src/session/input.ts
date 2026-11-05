/**
 * Where the owner's lines come from, and on which channel.
 *
 * The channel decides what a reply can do: only a line typed at an interactive terminal ('tty') can
 * approve a contract (items.ts approvalVerdict). The terminal reader takes it from process.stdin itself;
 * nothing the model, a tool or a file says can choose it. Tests inject a scripted source whose channel
 * is explicit.
 *
 * Lines typed at a terminal while the agent works are dropped (with a notice), never queued: a "yes"
 * typed early must not become the answer to a proposal shown later. Piped input is a script and is
 * read in order. Ctrl-C while the agent works cancels the turn; at the prompt it is reported to the
 * session (twice on an empty line exits); Ctrl-D (end of input) exits.
 */
import { createInterface, type Interface } from 'node:readline';
import type { TurnChannel } from '../core/items.ts';

export type OwnerLine = { kind: 'line'; text: string } | { kind: 'eof' } | { kind: 'interrupt' };

export interface OwnerInput {
  /** 'tty' when lines are typed at an interactive terminal, else 'pipe'. */
  readonly channel: TurnChannel;
  /** The owner's next line at the prompt (or end of input, or Ctrl-C at the prompt). */
  read(prompt: string): Promise<OwnerLine>;
  /** Ctrl-C while the agent works: `cb` is called. Returns the unsubscribe. */
  onInterrupt(cb: () => void): () => void;
  close(): void;
}

/** The real terminal (or pipe) on process.stdin. `onDropped` hears about lines typed while the agent works. */
export function terminalInput(opts: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; onDropped?: (line: string) => void } = {}): OwnerInput {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const tty = stdin.isTTY === true;
  const rl: Interface = createInterface({ input: stdin, output: stdout, terminal: tty, historySize: tty ? 200 : 0 });
  let waiting: ((l: OwnerLine) => void) | null = null;
  const queued: OwnerLine[] = [];
  let interrupt: (() => void) | null = null;
  let closed = false;

  const deliver = (l: OwnerLine): void => {
    if (waiting !== null) {
      const w = waiting;
      waiting = null;
      w(l);
    } else queued.push(l);
  };
  rl.on('line', (text) => {
    if (waiting === null && tty) {
      opts.onDropped?.(text);
      return;
    }
    deliver({ kind: 'line', text });
  });
  rl.on('close', () => {
    closed = true;
    deliver({ kind: 'eof' });
  });
  const onSigint = (): void => {
    if (interrupt !== null) {
      interrupt();
      return;
    }
    if (waiting !== null) {
      // Ctrl-C at the prompt clears what was typed; the session decides whether an empty-line Ctrl-C exits.
      if (rl.line.length > 0) {
        rl.write(null, { ctrl: true, name: 'u' });
        rl.write(null, { ctrl: true, name: 'k' });
      }
      deliver({ kind: 'interrupt' });
      return;
    }
    // Nothing is listening (the session is still starting): Ctrl-C quits, as it would anywhere else.
    // The session lock is released by its process-exit handler.
    rl.close();
    stdout.write('\n');
    process.exit(130);
  };
  rl.on('SIGINT', onSigint);
  // A piped stdin gets a real signal instead of a key press.
  if (!tty) process.on('SIGINT', onSigint);

  return {
    channel: tty ? 'tty' : 'pipe',
    read(prompt) {
      const next = queued.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.resolve({ kind: 'eof' });
      return new Promise((resolve) => {
        waiting = resolve;
        if (tty) {
          rl.setPrompt(prompt);
          rl.prompt();
        }
      });
    },
    onInterrupt(cb) {
      interrupt = cb;
      return () => {
        if (interrupt === cb) interrupt = null;
      };
    },
    close() {
      if (!tty) process.removeListener('SIGINT', onSigint);
      rl.close();
    },
  };
}

/** One scripted step: a line, end of input, Ctrl-C at the prompt, or a function run when read (a test hook). */
export type ScriptStep = string | { eof: true } | { interrupt: true } | (() => OwnerLine | string);

/**
 * A scripted owner for tests and demos: lines in order, on an explicit channel. `fireInterrupt()`
 * plays a Ctrl-C while the agent works (what a test driver calls mid-turn).
 */
export class ScriptedInput implements OwnerInput {
  readonly prompts: string[] = [];
  private interrupt: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly steps: ScriptStep[],
    readonly channel: TurnChannel,
  ) {}

  read(prompt: string): Promise<OwnerLine> {
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
    this.interrupt = cb;
    return () => {
      if (this.interrupt === cb) this.interrupt = null;
    };
  }

  /** Ctrl-C while the agent works; false when no turn is running. */
  fireInterrupt(): boolean {
    if (this.interrupt === null) return false;
    this.interrupt();
    return true;
  }

  close(): void {
    this.closed = true;
  }
}
