/**
 * Terminal-safe text. Whatever the model writes (its streamed prose, a contract field, a Measure script,
 * a path, a search pattern that ends up in a tool summary) and whatever a gate or hook says about it
 * reaches the owner's terminal only through these helpers, so it can never move the cursor, rewrite a
 * line the harness printed, change the window title, hide text or reorder it.
 *
 * Removed: ESC sequences (CSI, OSC, DCS/SOS/PM/APC strings, two-character escapes), the C0 controls
 * except newline and tab (carriage return, backspace, bell, ...), DEL, the C1 controls (U+0080-U+009F,
 * the single-byte CSI and OSC among them) and the bidirectional overrides and isolates (U+202A-U+202E,
 * U+2066-U+2069, U+061C, U+200E, U+200F) that make a line read differently from its bytes.
 *
 * Colour is the harness's alone. A colour sequence the harness paints (Ui.paint) carries a private
 * brand, a random string drawn once per process that is never shown, sent or recorded; when a line is
 * written, only branded sequences keep their colour (keepBranded) and every other ESC sequence is
 * removed, a colour or "conceal" code that arrived inside a file name, a gate line or a remote's
 * message included. The model cannot forge the brand: it never sees it.
 */
import { randomBytes } from 'node:crypto';

// ESC-introduced sequences, the longest forms first.
const ESC_SEQ = new RegExp(
  [
    '\\u001b\\[[0-?]*[ -/]*[@-~]', // CSI ... final byte
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?', // OSC ... BEL or ST (or unterminated)
    '\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?', // DCS / SOS / PM / APC ... ST
    '\\u001b[ -/]*[0-~]', // two-character and nF escapes
    '\\u009b[0-?]*[ -/]*[@-~]', // single-byte CSI
    '\\u009d[^\\u0007\\u009c]*(?:\\u0007|\\u009c)?', // single-byte OSC
  ].join('|'),
  'g',
);
/** C0 except \t and \n, DEL, C1, and the bidirectional controls. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
/** A colour/style sequence (util.styleText's output). */
const SGR = /\u001b\[[0-9;]*m/g;

/**
 * The brand on a colour sequence the harness painted: 12 private-use characters (U+E000-U+F8FF), random
 * per process. Private-use, so a brand that ever leaked would show as boxes and never act on a terminal.
 */
const BRAND = Array.from(randomBytes(12), (b) => String.fromCharCode(0xe000 + b * 25)).join('');
const BRAND_RE = new RegExp(BRAND, 'g');
const BRANDED_SGR = new RegExp(`${BRAND}(\\u001b\\[[0-9;]*m)`, 'g');

/** `text` without ESC sequences and control characters (newline and tab stay), and without a brand. */
export function stripControls(text: string): string {
  return text.replace(BRAND_RE, '').replace(ESC_SEQ, '').replace(CONTROL, '');
}

/** `styled` (util.styleText's output for harness text) with each of its colour sequences branded as the harness's. */
export function brandSgr(styled: string): string {
  return styled.replace(SGR, (m) => `${BRAND}${m}`);
}

/**
 * `text` ready for a colour terminal: the colour sequences the harness painted (branded) keep their
 * colour, unbranded; everything else is stripped (stripControls), so agent text carried inside a
 * harness line brings no colour, conceal or cursor code with it.
 */
export function keepBranded(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(BRANDED_SGR)) {
    out += stripControls(text.slice(last, m.index)) + (m[1] ?? '');
    last = m.index + m[0].length;
  }
  return out + stripControls(text.slice(last));
}

/**
 * The columns a character may take on a terminal, never fewer than any terminal gives it: printable
 * ASCII and the box-drawing characters the harness draws with take 1; anything else is counted as 2
 * (wide, emoji and East Asian ambiguous characters take 2 on some terminals; counting more only wraps
 * a little earlier). A tab is expanded before it is counted.
 */
export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x20 && c <= 0x7e) return 1;
  if (c >= 0x2500 && c <= 0x257f) return 1;
  return 2;
}

/** JavaScript's line terminators: a Measure script is shown broken exactly where node breaks it. */
export const SCRIPT_LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;

/** The control characters a text holds (items.ts: what parseContract and propose_contract refuse). */
export { controlChars } from '../core/items.ts';

/**
 * Where a stream stands inside ESC_SEQ's grammar: in text; after ESC; in a CSI's parameters or its
 * intermediates (ESC [ or the single-byte CSI); in an nF escape's intermediates; inside an OSC string
 * (ends at BEL or ST), a DCS/SOS/PM/APC string (ends at ST) or a single-byte OSC (ends at BEL or the
 * single-byte ST); or just after an ESC inside an OSC or DCS-like string (ST if a backslash follows).
 */
type StreamState = 'text' | 'esc' | 'csi' | 'csi-inter' | 'c1csi' | 'c1csi-inter' | 'nf' | 'osc' | 'str' | 'str-esc' | 'c1osc';

const isParam = (c: number): boolean => c >= 0x30 && c <= 0x3f; // [0-?]
const isInter = (c: number): boolean => c >= 0x20 && c <= 0x2f; // [ -/]
const isCsiFinal = (c: number): boolean => c >= 0x40 && c <= 0x7e; // [@-~]
const isEscFinal = (c: number): boolean => c >= 0x30 && c <= 0x7e; // [0-~]
const ONE_CONTROL = new RegExp(`^${CONTROL.source}$`);

/**
 * The model's stream stripped as it arrives: push each chunk, end() when the stream ends, and the
 * pieces joined are exactly what stripControls gives the whole text, however it was chunked (a
 * sequence cut anywhere across chunks, of any length). It reads ESC_SEQ's grammar one UTF-16 unit at a
 * time: an OSC or DCS-like string is dropped as it arrives (whether it ends or not, all of it is
 * removed), so nothing of it is held however long it runs; only a CSI's or nF escape's parameters are
 * held (printable ASCII, shown if the sequence turns out not to complete). The harness's brand, which
 * the model never sees, is removed from each chunk.
 */
export class StreamStripper {
  private state: StreamState = 'text';
  /** The parameters and intermediates of a CSI or nF escape not yet known to complete. */
  private held = '';

  /** How many units are held back (tests: a string sequence holds none). */
  get heldLength(): number {
    return this.held.length;
  }

  /** What of `chunk` can be shown now, stripped. */
  push(chunk: string): string {
    let out = '';
    for (let i = 0; i < chunk.length; i += 1) out += this.step(chunk[i] ?? '');
    return out.replace(BRAND_RE, '');
  }

  /** The stream ended: what a sequence left open shows (the parameters of a CSI or nF escape that never completed). */
  end(): string {
    const out = this.state === 'csi' || this.state === 'csi-inter' || this.state === 'c1csi' || this.state === 'c1csi-inter' || this.state === 'nf' ? this.held : '';
    this.state = 'text';
    this.held = '';
    return out;
  }

  /** One UTF-16 unit: what it shows (with whatever a sequence it ends turned out to hold). */
  private step(ch: string): string {
    const c = ch.charCodeAt(0);
    switch (this.state) {
      case 'esc':
        if (ch === '[') return this.enter('csi');
        if (ch === ']') return this.enter('osc');
        if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') return this.enter('str');
        if (isInter(c)) {
          this.state = 'nf';
          this.held = ch;
          return '';
        }
        // A two-character escape is removed; any other character after ESC: the ESC alone is removed.
        this.state = 'text';
        return isEscFinal(c) ? '' : this.step(ch);
      case 'csi':
      case 'c1csi':
        if (isParam(c)) return this.hold(ch);
        if (isInter(c)) {
          this.state = this.state === 'csi' ? 'csi-inter' : 'c1csi-inter';
          return this.hold(ch);
        }
        return isCsiFinal(c) ? this.enter('text') : this.broken(ch);
      case 'csi-inter':
      case 'c1csi-inter':
        if (isInter(c)) return this.hold(ch);
        return isCsiFinal(c) ? this.enter('text') : this.broken(ch);
      case 'nf':
        if (isInter(c)) return this.hold(ch);
        return isEscFinal(c) ? this.enter('text') : this.broken(ch);
      case 'osc':
        if (ch === '\u0007') return this.enter('text');
        if (ch === '\u001b') return this.enter('str-esc');
        return '';
      case 'str':
        return ch === '\u001b' ? this.enter('str-esc') : '';
      case 'str-esc':
        // ST ends the string; any other character: the string ended before this ESC, which starts anew.
        if (ch === '\\') return this.enter('text');
        this.state = 'esc';
        return this.step(ch);
      case 'c1osc':
        return ch === '\u0007' || ch === '\u009c' ? this.enter('text') : '';
      case 'text':
        if (ch === '\u001b') return this.enter('esc');
        if (ch === '\u009b') return this.enter('c1csi');
        if (ch === '\u009d') return this.enter('c1osc');
        return ONE_CONTROL.test(ch) ? '' : ch;
    }
  }

  private enter(state: StreamState): string {
    this.state = state;
    this.held = '';
    return '';
  }

  private hold(ch: string): string {
    this.held += ch;
    return '';
  }

  /**
   * The sequence did not complete at `ch`: what it held is shown as text (its introducer is removed:
   * "ESC [" as a two-character escape, a lone ESC or single-byte CSI as a control), and `ch` is read
   * as text again.
   */
  private broken(ch: string): string {
    const shown = this.held;
    this.state = 'text';
    this.held = '';
    return shown + this.step(ch);
  }
}
