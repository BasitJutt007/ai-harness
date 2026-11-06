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

/** The tail of a streamed chunk that may be the start of an ESC sequence the next chunk completes. */
const OPEN_ESC = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*|[PX^_][^\u001b]*|[ -/]*)?$/;

/**
 * Splits a streamed chunk into what can be shown now (stripped) and a held-back tail that may be an
 * unfinished ESC sequence (at most 256 characters; a longer one is shown, stripped, as it is).
 */
export function splitStreamChunk(carry: string, chunk: string): { show: string; carry: string } {
  const text = carry + chunk;
  const m = OPEN_ESC.exec(text);
  if (m !== null && text.length - m.index <= 256) return { show: stripControls(text.slice(0, m.index)), carry: text.slice(m.index) };
  return { show: stripControls(text), carry: '' };
}
