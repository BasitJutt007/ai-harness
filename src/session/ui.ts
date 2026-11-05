/**
 * What the owner sees in a session: a banner, a status line, the model's text as it streams, one line
 * per tool call, hook block and gate run, the proposal box, a spinner while the model thinks, and the
 * verdict block. Zero dependencies (util.styleText); colour only on a TTY without NO_COLOR, and a
 * spinner only on a TTY, so a piped session (and every test) gets plain text.
 *
 * Long tool output never reaches the screen: a tool line is the tool's one-line summary, truncated to
 * the terminal width. The full output is in the session's records (transcript.jsonl, logs/).
 */
import { styleText } from 'node:util';
import type { NamedGateResult } from '../core/gates.ts';
import type { RunEvent, ToolEffect } from '../core/types.ts';

export interface Output {
  write(text: string): void;
  readonly isTTY: boolean;
  readonly columns?: number | undefined;
}

type Style = Parameters<typeof styleText>[0];

/** Colour iff the output is a terminal, NO_COLOR is unset (or empty) and TERM is not "dumb". */
export function colorEnabled(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isTTY) return false;
  const no = env['NO_COLOR'];
  if (no !== undefined && no !== '') return false;
  return env['TERM'] !== 'dumb';
}

/** An original mark for sf-harness: a gate (the work passes through it), then the name. */
export const BANNER_LINES = [
  '  ╻ ╻ ╻ ╻',
  '  ┣━╋━╋━┫   s f · h a r n e s s',
  '  ┃ ┃ ┃ ┃   a governed coding agent: you talk, the gates decide, you ship',
];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface StatusInfo {
  repo: string;
  branch: string;
  writable: boolean;
  /** Why the session is read-only, and the command that fixes it (empty when writable). */
  reason: string;
  fix: string;
  model: string;
  capUsd: number;
}

export interface VerdictView {
  kind: 'DONE' | 'NOT DONE' | 'UNPROVEN';
  reasons: string[];
  gates: NamedGateResult[];
  standards: string;
  humanMustVerify: string[];
}

export const WORK_COMPLETED = '✔ Work completed: every gate is green. Nothing was committed; /diff shows the change, /ship ships it.';

/** One-line text: whitespace collapsed, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;
}

export class Ui {
  private atLineStart = true;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private spinnerShown = false;
  private gateBuffer: Array<{ gate: string; status: string }> = [];
  /** While true, gate events are not printed (the session prints the gate run itself). */
  quietGates = false;

  constructor(
    private readonly out: Output,
    readonly color: boolean,
    private readonly effectOf: (tool: string) => ToolEffect | undefined = () => undefined,
  ) {}

  /** The usable line width (terminal columns, else 100). */
  get width(): number {
    const c = this.out.columns;
    return typeof c === 'number' && c >= 40 ? c : 100;
  }

  paint(style: Style, text: string): string {
    return this.color ? styleText(style, text, { validateStream: false }) : text;
  }

  /** Raw text (the model's stream). */
  write(text: string): void {
    if (text.length === 0) return;
    this.stopSpinner();
    this.out.write(text);
    this.atLineStart = text.endsWith('\n');
  }

  /** A whole line, starting on a fresh line. */
  line(text = ''): void {
    this.stopSpinner();
    if (!this.atLineStart) this.out.write('\n');
    this.out.write(`${text}\n`);
    this.atLineStart = true;
  }

  /** End a streamed reply with a newline (if it did not end with one). */
  endStream(): void {
    if (!this.atLineStart) {
      this.out.write('\n');
      this.atLineStart = true;
    }
  }

  // ── spinner (TTY only) ──

  startSpinner(label: string): void {
    if (!this.out.isTTY || this.spinnerTimer !== null) return;
    if (!this.atLineStart) {
      this.out.write('\n');
      this.atLineStart = true;
    }
    const draw = (): void => {
      this.out.write(`\r${this.paint('cyan', SPINNER[this.spinnerFrame % SPINNER.length] ?? '·')} ${this.paint('dim', label)}\u001b[K`);
      this.spinnerFrame += 1;
      this.spinnerShown = true;
    };
    draw();
    this.spinnerTimer = setInterval(draw, 90);
    this.spinnerTimer.unref?.();
  }

  stopSpinner(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerShown) {
      this.out.write('\r\u001b[K');
      this.spinnerShown = false;
      this.atLineStart = true;
    }
  }

  // ── fixed blocks ──

  banner(): void {
    const [top, mid, low] = BANNER_LINES;
    this.line(this.paint('cyan', top ?? ''));
    this.line(`${this.paint('cyan', (mid ?? '').slice(0, 11))}${this.paint('bold', (mid ?? '').slice(11))}`);
    this.line(`${this.paint('cyan', (low ?? '').slice(0, 11))}${this.paint('dim', (low ?? '').slice(11))}`);
    this.line();
  }

  status(s: StatusInfo): void {
    const where = s.writable ? this.paint('green', 'writable') : this.paint('yellow', 'read-only');
    this.line(`${this.paint('dim', 'repo')} ${s.repo}  ${this.paint('dim', 'branch')} ${s.branch} (${where})  ${this.paint('dim', 'model')} ${s.model}  ${this.paint('dim', 'cap')} $${s.capUsd.toFixed(2)}`);
    if (!s.writable) this.line(this.paint('yellow', `read-only: ${s.reason}; ${s.fix}. Chat and reading work; every edit is refused.`));
  }

  note(text: string): void {
    this.line(this.paint('dim', text));
  }

  warn(text: string): void {
    this.line(this.paint('yellow', text));
  }

  error(text: string): void {
    this.line(this.paint('red', text));
  }

  // ── live events ──

  /** One line for a recorded event (tool call, hook block, gate, note), or nothing. */
  event(e: RunEvent): void {
    const w = this.width - 4;
    if (e.kind === 'gate') {
      if (this.quietGates) return;
      const status = typeof (e.data as { status?: unknown } | undefined)?.status === 'string' ? String((e.data as { status: string }).status) : e.decision === 'block' ? 'fail' : 'pass';
      this.gateBuffer.push({ gate: e.source, status });
      return;
    }
    if (e.kind === 'tool') {
      if (e.source === 'finish' && e.decision === 'pass') return; // the finish note says more
      const effect = this.effectOf(e.source);
      // A command that ran and failed (a red test run) is information; a refused read or write is not.
      if (e.decision === 'block' && effect === 'exec') {
        this.line(`${this.paint('yellow', '●')} ${clip(`${e.source} ${e.message}`, w)}`);
        return;
      }
      if (e.decision === 'block') {
        this.line(this.paint('red', clip(`✗ ${e.source}: ${e.message}`, w)));
        return;
      }
      const icon = effect === 'write' ? this.paint('yellow', '✎') : effect === 'control' ? this.paint('magenta', '◆') : this.paint('cyan', '●');
      this.line(`${icon} ${clip(`${e.source} ${effect === 'write' ? lineCounts(e.message) : e.message}`, w)}`);
      return;
    }
    if (e.kind === 'hook') {
      const msg = e.message.startsWith(`${e.source}: `) ? e.message.slice(e.source.length + 2) : e.message;
      if (e.decision === 'block') this.line(this.paint('red', clip(`✗ BLOCKED by ${e.source}: ${msg}`, w)));
      else if (e.decision === 'record') this.line(this.paint('dim', clip(`  · ${e.source}: ${msg}`, w)));
      return;
    }
    if (e.kind === 'note' && e.source === 'finish') {
      const accepted = e.decision === 'pass';
      this.line(`${this.paint('magenta', '◆')} ${accepted ? 'finish accepted by the gates' : clip(`finish refused: ${e.message.replace(/^FINISH REFUSED\s*/, '')}`, w)}`);
      this.flushGates();
      return;
    }
    if (e.kind === 'note') {
      this.line(this.paint('dim', clip(`  · ${e.message}`, w)));
      return;
    }
    if (e.kind === 'error') this.line(this.paint('red', clip(`  ! ${e.source}: ${e.message}`, w)));
  }

  /** The gate results buffered since the last flush, on one line. */
  flushGates(): void {
    if (this.gateBuffer.length === 0) return;
    const parts = this.gateBuffer.map((g) => `${g.gate} ${this.gateStatus(g.status)}`);
    this.gateBuffer = [];
    this.line(`  ${this.paint('dim', 'gates')}  ${parts.join(this.paint('dim', ' · '))}`);
  }

  gateStatus(status: string): string {
    if (status === 'pass') return this.paint('green', 'pass');
    if (status === 'fail') return this.paint('red', 'FAIL');
    if (status === 'unproven') return this.paint('yellow', 'UNPROVEN');
    return this.paint('dim', status);
  }

  /** One line per gate of a fresh run. */
  gateLines(results: NamedGateResult[]): void {
    const w = this.width - 30;
    for (const r of results) this.line(`  ${r.gate.padEnd(16)} ${this.gateStatus(r.status).padEnd(this.color ? 18 : 9)} ${this.paint('dim', clip(r.summary, Math.max(30, w)))}`);
  }

  // ── proposal and verdict ──

  /** The contract as proposed, boxed, and what the owner can reply. */
  proposal(slug: string, contractText: string, extra: string[]): void {
    const w = Math.min(this.width, 110) - 4;
    const bar = (label: string): string => `${label} ${'─'.repeat(Math.max(4, w - label.length - 1))}`;
    this.line(this.paint('magenta', `┌ ${bar(`PROPOSAL ${slug}`)}`));
    for (const raw of contractText.split('\n')) {
      if (raw.trim().length === 0 || /^#\s/.test(raw)) continue;
      for (const piece of wrapLine(raw, w)) this.line(`${this.paint('magenta', '│')} ${piece}`);
    }
    for (const x of extra) for (const piece of wrapLine(x, w)) this.line(`${this.paint('magenta', '│')} ${this.paint('dim', piece)}`);
    this.line(this.paint('magenta', '└ Type your reply: yes to approve, or say what to change. Only the next line you type counts.'));
  }

  verdict(v: VerdictView): void {
    this.line(`${this.paint('dim', 'gates')}  fresh run of every required gate`);
    this.gateLines(v.gates);
    this.line(`${this.paint('dim', 'standards')}  ${clip(v.standards, this.width - 12)}`);
    if (v.kind === 'DONE') {
      this.line(this.paint(['green', 'bold'], WORK_COMPLETED));
      return;
    }
    const head = v.kind === 'NOT DONE' ? this.paint(['red', 'bold'], '✗ NOT DONE') : this.paint(['yellow', 'bold'], '? UNPROVEN');
    this.line(`${head}: the gates, not the model, decide; this work is not complete.`);
    for (const r of v.reasons.slice(0, 8)) this.line(`  - ${clip(r, this.width - 6)}`);
    if (v.reasons.length > 8) this.line(`  … ${v.reasons.length - 8} more (run.json in the session records)`);
    if (v.humanMustVerify.length > 0) {
      this.line(this.paint('dim', '  a human must verify:'));
      for (const h of v.humanMustVerify.slice(0, 6)) this.line(this.paint('dim', `    · ${clip(h, this.width - 8)}`));
    }
  }

  /** A unified diff, coloured. */
  diff(text: string): void {
    for (const l of text.replace(/\n$/, '').split('\n')) {
      if (l.startsWith('diff --git') || l.startsWith('+++') || l.startsWith('---') || l.startsWith('new file')) this.line(this.paint('bold', l));
      else if (l.startsWith('@@')) this.line(this.paint('cyan', l));
      else if (l.startsWith('+')) this.line(this.paint('green', l));
      else if (l.startsWith('-')) this.line(this.paint('red', l));
      else this.line(l);
    }
  }
}

/** A write tool's summary with its line counts as +added −removed: "(new, 7 lines)" → "(+7)", "(+3 −1 lines)" → "(+3 −1)". */
export function lineCounts(summary: string): string {
  return summary.replace(/\(new, (\d+) lines?\)/, '(+$1)').replace(/\((\+\d+ −\d+) lines?\)/, '($1)');
}

/** A line cut into pieces of at most `width` characters, on spaces where it can. */
export function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= width / 3) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = `  ${rest.slice(cut).trimStart()}`;
  }
  if (rest.trim().length > 0) out.push(rest);
  return out;
}
