/**
 * What the owner sees in a session: a banner, a status line, the model's text as it streams, one line
 * per tool call, hook block and gate run, the proposal box, a spinner while the model thinks, and the
 * verdict block. Zero dependencies (util.styleText); colour only on a TTY without NO_COLOR, and a
 * spinner only on a TTY, so a piped session (and every test) gets plain text.
 *
 * Long tool output never reaches the screen: a tool line is the tool's one-line summary, truncated to
 * the terminal width. The full output is in the session's records (transcript.jsonl, logs/).
 *
 * The harness owns the left margin. Every row of the model's streamed prose starts with MODEL_GUTTER,
 * written by the harness, so a model line never begins at column 0: "✔ Work completed", a gate line or
 * a PROPOSAL box in the model's words always reads as the model's. That holds for the terminal's rows,
 * not only for the model's newlines: when the width is known (a terminal's columns), the harness breaks
 * every row itself before the terminal would (sanitize.ts cellWidth counts a character at the most
 * columns any terminal gives it, tabs become spaces) and writes the gutter again, so padding a line to
 * the width cannot push text to column 0. Rows break at word boundaries, as a terminal app wraps prose
 * (only a word longer than a whole row is cut), and the model's rows come out the same however its
 * stream was chunked. A harness line that is too wide, or has a newline inside, continues on an
 * indented row, so agent text it carries (a file name, a gate line) never takes column 0 either.
 * Nothing reaches the terminal with an ESC sequence or a control character in it
 * (sanitize.ts): not the model's prose, a tool summary, a hook or gate line, the proposal box or a diff;
 * on a colour terminal only the colours the harness painted itself (Ui.paint) survive in a line.
 * A pipe has no rows: there, lines are not broken.
 */
import { styleText } from 'node:util';
import type { NamedGateResult } from '../core/gates.ts';
import type { RunEvent, ToolEffect } from '../core/types.ts';
import { brandSgr, cellWidth, keepBranded, SCRIPT_LINE_BREAK, splitStreamChunk, stripControls } from './sanitize.ts';

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

/** What starts every row of the model's prose (the harness writes it; a harness line never starts with it). */
export const MODEL_GUTTER = '┆ ';
const GUTTER_CELLS = [...MODEL_GUTTER].reduce((n, ch) => n + cellWidth(ch), 0);
/** Where a continuation row of a harness line starts. */
const CONTINUE = '  ';
/** Tab stops when a tab is expanded on a terminal. */
const TAB = 8;
/** A colour sequence the harness kept in a rendered line (no width on screen). */
const SGR_AT = /^\u001b\[[0-9;]*m/;

/** The columns `text` (plain: no ESC sequence) may take: cellWidth per character. */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) n += cellWidth(ch);
  return n;
}

/**
 * Where a line being broken into rows stands (fitRows; the model's stream, across its chunks): the
 * columns the current row takes (its gutter or indent included), the column its text starts at, and the
 * word held back since the last space, written once it is known whether it fits on this row.
 */
interface RowState {
  col: number;
  start: number;
  word: string;
  wordCells: number;
}

/** The word `r` holds, written where it stands (the end of a line, or of the stream). */
function takeWord(r: RowState): string {
  const w = r.word;
  r.col += r.wordCells;
  r.word = '';
  r.wordCells = 0;
  return w;
}

/**
 * `text` (part of one line: no newline; the harness's colour sequences may be in it) appended where `r`
 * stands, broken into rows of at most `cols` columns the way a terminal app wraps prose: at the last
 * space that fits, so a word is never cut; only a word longer than a whole row is cut, where the row
 * ends. Every row this starts begins with `lead` (`leadCells` columns). Nothing is dropped or doubled: a
 * word moves to the next row together with the space after it, and a space that cannot fit after a word
 * filling a whole row starts the next one. A tab becomes spaces up to its stop (counted from column
 * `tabFrom`). The last word stays held in `r` (takeWord writes it): until a space, the line's end or the
 * stream's end, nobody knows whether it fits, so the rows are the same however the text was chunked.
 */
function breakRows(r: RowState, text: string, cols: number, lead: string, leadCells: number, tabFrom: number): string {
  let out = '';
  const nextRow = (): void => {
    out += `\n${lead}`;
    r.col = leadCells;
    r.start = leadCells;
  };
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      const m = SGR_AT.exec(text.slice(i));
      if (m !== null) {
        // No width: a colour code goes where the word it touches goes.
        r.word += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0x20);
    i += ch.length;
    if (ch === ' ' || ch === '\t') {
      // The word and the space after it stay on this row when both fit; else the word starts the next
      // row (unless it is all this row holds: then it fills the row, and the space starts the next one).
      if (r.col + r.wordCells + 1 > cols && r.col > r.start) nextRow();
      out += takeWord(r);
      const n = ch === '\t' ? TAB - ((r.col - tabFrom) % TAB) : 1;
      for (let k = 0; k < n; k += 1) {
        if (r.col + 1 > cols && r.col > r.start) nextRow();
        out += ' ';
        r.col += 1;
      }
      continue;
    }
    const w = cellWidth(ch);
    if (r.col + r.wordCells + w > cols) {
      // The word does not fit after what the row holds: it moves to the next row whole.
      if (r.col > r.start) nextRow();
      // A word longer than a whole row: cut where the row ends (a row always takes at least one character).
      if (r.col + r.wordCells + w > cols && r.wordCells > 0) {
        out += takeWord(r);
        nextRow();
      }
    }
    r.word += ch;
    r.wordCells += w;
  }
  return out;
}

/**
 * A rendered line (only the harness's colour sequences, newlines and tabs left in it) broken into rows
 * of at most `cols` columns at word boundaries (breakRows): every row after the first starts with
 * `indent`, so nothing the line carries lands at column 0 when a terminal would otherwise wrap it. On a
 * terminal (finite `cols`) a tab becomes spaces up to the next tab stop; a pipe (Infinity) has no rows,
 * and only a newline inside the line starts an indented row.
 */
export function fitRows(text: string, cols: number, indent: string): string {
  if (cols === Infinity) return text.replace(/\n/g, `\n${indent}`);
  const start = cells(indent);
  const r: RowState = { col: 0, start: 0, word: '', wordCells: 0 };
  let out = '';
  for (const [k, piece] of text.split('\n').entries()) {
    if (k > 0) {
      out += `${takeWord(r)}\n${indent}`;
      r.col = start;
      r.start = start;
    }
    out += breakRows(r, piece, cols, indent, start, 0);
  }
  return out + takeWord(r);
}

/** One-line text: control characters removed, whitespace collapsed, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = stripControls(text).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;
}

/** A Measure script shown in the proposal box. */
export interface ShownScript {
  /** Where the harness keeps it, relative to the items root (metrics/<file>.mjs). */
  path: string;
  text: string;
}

export class Ui {
  private atLineStart = true;
  /** Where the model's current row stands (its gutter included), and the word it holds back (breakRows). */
  private model: RowState = { col: 0, start: 0, word: '', wordCells: 0 };
  /** The tail of the model's stream that may be an unfinished ESC sequence (held until the next chunk). */
  private streamCarry = '';
  /** A chunk that ended inside a surrogate pair: its first half, held until the second arrives. */
  private halfPair = '';
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

  /**
   * The usable line width, what one-line text is clipped to: the columns rows break at (wrapAt: the
   * terminal's, or 80 on a terminal that reports none) when that is 40 or more, else 100 (a pipe).
   */
  get width(): number {
    const w = this.wrapAt;
    return w !== Infinity && w >= 40 ? w : 100;
  }

  /**
   * Where rows break: the terminal's columns when known (else 80 on a terminal); a pipe has no rows
   * (Infinity: nothing is broken).
   */
  get wrapAt(): number {
    const c = this.out.columns;
    if (typeof c === 'number' && c > 0) return c;
    return this.out.isTTY ? 80 : Infinity;
  }

  /**
   * `text` styled (on a colour terminal), its control characters removed first. Its colour is the
   * harness's (branded): it survives in a line, unlike any colour code inside agent text.
   */
  paint(style: Style, text: string): string {
    const t = stripControls(text);
    return this.color ? brandSgr(styleText(style, t, { validateStream: false })) : t;
  }

  /** `text` as it may reach the terminal: the harness's own colours (on a colour terminal) and nothing else. */
  render(text: string): string {
    return this.color ? keepBranded(text) : stripControls(text);
  }

  /**
   * The model's streamed prose: control characters and ESC sequences removed (one cut across two chunks
   * included), and every row it starts gets MODEL_GUTTER in front, so it never begins at column 0.
   */
  write(text: string): void {
    if (text.length === 0) return;
    this.stopSpinner();
    const { show, carry } = splitStreamChunk(this.streamCarry, text);
    this.streamCarry = carry;
    let s = this.halfPair + show;
    this.halfPair = '';
    // A chunk may end inside a surrogate pair: the character is counted (and placed) once, when it is whole.
    if (/[\uD800-\uDBFF]$/.test(s)) {
      this.halfPair = s.slice(-1);
      s = s.slice(0, -1);
    }
    this.writeModel(s);
  }

  /**
   * `show` (already stripped) in the gutter, broken into rows at word boundaries (breakRows) before the
   * terminal would wrap it, the gutter written again on each. The word after the last space is held
   * until it is known whether it fits; endStream, a harness line or the spinner writes it.
   */
  private writeModel(show: string): void {
    if (show.length === 0) return;
    const cols = this.wrapAt;
    const gutter = this.render(this.paint('dim', MODEL_GUTTER));
    let out = '';
    for (const piece of show.split(/(\n)/)) {
      if (piece === '\n') {
        out += `${takeWord(this.model)}\n`;
        this.atLineStart = true;
        continue;
      }
      if (piece.length === 0) continue;
      if (this.atLineStart) {
        out += gutter;
        this.model = { col: GUTTER_CELLS, start: GUTTER_CELLS, word: '', wordCells: 0 };
        this.atLineStart = false;
      }
      // A pipe has no rows: the prose is written as it came.
      out += cols === Infinity ? takeWord(this.model) + piece : breakRows(this.model, piece, cols, gutter, GUTTER_CELLS, GUTTER_CELLS);
    }
    if (out.length > 0) this.out.write(out);
  }

  /** The model's current line ended: its held word written, then a newline (when the line has anything on it). */
  private endModelLine(): void {
    const word = takeWord(this.model);
    if (this.atLineStart) return;
    this.out.write(`${word}\n`);
    this.atLineStart = true;
  }

  /**
   * A whole harness line, starting on a fresh line. Control characters and every ESC sequence the
   * harness did not paint are removed; a newline inside it, or a row the terminal would wrap, continues
   * on an indented row.
   */
  line(text = ''): void {
    this.stopSpinner();
    this.endModelLine();
    this.out.write(`${fitRows(this.render(text), this.wrapAt, CONTINUE)}\n`);
    this.atLineStart = true;
  }

  /** End a streamed reply with a newline (if it did not end with one). */
  endStream(): void {
    if (this.streamCarry.length > 0 || this.halfPair.length > 0) {
      const rest = this.halfPair + stripControls(this.streamCarry);
      this.streamCarry = '';
      this.halfPair = '';
      this.writeModel(rest);
    }
    this.endModelLine();
  }

  // ── spinner (TTY only) ──

  startSpinner(label: string): void {
    if (!this.out.isTTY || this.spinnerTimer !== null) return;
    this.endModelLine();
    // One row only: "\r" returns to the start of the row, so a label the terminal wrapped would leave rows behind.
    const shown = clipCells(label, this.wrapAt - 3);
    const draw = (): void => {
      this.out.write(`\r${this.render(this.paint('cyan', SPINNER[this.spinnerFrame % SPINNER.length] ?? '·'))} ${this.render(this.paint('dim', shown))}\u001b[K`);
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
    this.line(`${this.paint('dim', 'repo')} ${stripControls(s.repo)}  ${this.paint('dim', 'branch')} ${stripControls(s.branch)} (${where})  ${this.paint('dim', 'model')} ${stripControls(s.model)}  ${this.paint('dim', 'cap')} $${s.capUsd.toFixed(2)}`);
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
      this.line(this.paint('dim', `  · ${clip(e.message, w - 4)}`));
      return;
    }
    if (e.kind === 'error') this.line(this.paint('red', `  ! ${clip(`${e.source}: ${e.message}`, w - 4)}`));
  }

  /** The gate results buffered since the last flush, on one line. */
  flushGates(): void {
    if (this.gateBuffer.length === 0) return;
    const parts = this.gateBuffer.map((g) => `${stripControls(g.gate)} ${this.gateStatus(g.status)}`);
    this.gateBuffer = [];
    this.line(`  ${this.paint('dim', 'gates')}  ${parts.join(this.paint('dim', ' · '))}`);
  }

  /** A gate status, painted, its label padded to `pad` characters first (so colour never changes the alignment). */
  gateStatus(status: string, pad = 0): string {
    if (status === 'pass') return this.paint('green', 'pass'.padEnd(pad));
    if (status === 'fail') return this.paint('red', 'FAIL'.padEnd(pad));
    if (status === 'unproven') return this.paint('yellow', 'UNPROVEN'.padEnd(pad));
    return this.paint('dim', stripControls(status).padEnd(pad));
  }

  /** One line per gate of a fresh run. */
  gateLines(results: NamedGateResult[]): void {
    const w = this.width - 30;
    for (const r of results) this.line(`  ${stripControls(r.gate).padEnd(16)} ${this.gateStatus(r.status, 9)} ${this.paint('dim', clip(r.summary, Math.max(30, w)))}`);
  }

  // ── proposal and verdict ──

  /**
   * The contract as proposed, boxed, with the full text of its Measure script when it has one (the code
   * the harness runs once the owner says yes), and what the owner can reply. Lines are broken where
   * the code that reads them breaks them, before anything is stripped: the contract where the contract
   * parser does (\n, \r\n, \r), the script at every JavaScript line terminator (\n, \r\n, \r, U+2028,
   * U+2029), so a line node runs is never shown glued to a comment. Then each line is stripped of
   * control characters and broken to the box's width.
   */
  proposal(slug: string, contractText: string, extra: string[], script: ShownScript | null = null): void {
    const w = Math.max(20, Math.min(this.width, this.wrapAt, 110) - 4);
    const bar = (label: string): string => `${label} ${'─'.repeat(Math.max(4, w - cells(label) - 1))}`;
    const side = this.paint('magenta', '│');
    this.line(this.paint('magenta', `┌ ${bar(`PROPOSAL ${clip(slug, 60)}`)}`));
    for (const raw of contractText.split(/\r\n?|\n/).map(stripControls)) {
      if (raw.trim().length === 0 || /^#\s/.test(raw)) continue;
      for (const piece of wrapLine(raw, w)) this.line(`${side} ${piece}`);
    }
    if (script !== null) {
      const lines = script.text.replace(/(?:\r\n|\r|\n|\u2028|\u2029)$/, '').split(SCRIPT_LINE_BREAK).map(stripControls);
      this.line(`${side} ${this.paint('bold', `Measure script ${stripControls(script.path)}`)} ${this.paint('dim', `(${lines.length} line${lines.length === 1 ? '' : 's'})`)}`);
      for (const piece of wrapLine('the harness runs it, confined and offline, only after your yes; its output never reaches the agent', w)) this.line(`${side} ${this.paint('dim', piece)}`);
      for (const l of lines) for (const piece of wrapLine(`  ${l.replace(/\t/g, '  ')}`, w)) this.line(`${side} ${this.paint('cyan', piece)}`);
    }
    for (const x of extra) for (const piece of wrapLine(stripControls(x), w)) this.line(`${side} ${this.paint('dim', piece)}`);
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

  /** A unified diff, coloured; its control characters removed first (file content is the agent's). */
  diff(text: string): void {
    for (const l of stripControls(text).replace(/\n$/, '').split('\n')) {
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

/** How many UTF-16 units of `text` fit in `width` columns (cellWidth), at least one character. */
function fitUnits(text: string, width: number): number {
  let used = 0;
  let units = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (used + w > width && units > 0) break;
    used += w;
    units += ch.length;
  }
  return units;
}

/** `text` cut to at most `width` columns (cellWidth), with an ellipsis when it was cut. */
export function clipCells(text: string, width: number): string {
  const t = stripControls(text);
  if (cells(t) <= width) return t;
  return `${t.slice(0, fitUnits(t, Math.max(1, width - 2)))}…`;
}

/** A line cut into pieces of at most `width` columns (cellWidth; `width` at least 4), on spaces where it can. */
export function wrapLine(line: string, atMost: number): string[] {
  const width = Math.max(4, atMost);
  if (cells(line) <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (cells(rest) > width) {
    const fit = fitUnits(rest, width);
    let cut = rest.lastIndexOf(' ', fit);
    if (cut <= fit / 3) cut = fit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = `  ${rest.slice(cut).trimStart()}`;
  }
  if (rest.trim().length > 0) out.push(rest);
  return out;
}
