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
 */

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
/** A colour/style sequence the harness itself paints with (util.styleText): kept on a colour terminal. */
const SGR = /\u001b\[[0-9;]*m/g;

/** `text` without ESC sequences and control characters (newline and tab stay). */
export function stripControls(text: string): string {
  return text.replace(ESC_SEQ, '').replace(CONTROL, '');
}

/**
 * Like stripControls, but SGR sequences (colour and style only: they cannot move the cursor or erase
 * anything) stay when `keepSgr` is set: what the harness painted keeps its colour on a colour terminal.
 */
export function stripControlsKeepingSgr(text: string, keepSgr: boolean): string {
  if (!keepSgr) return stripControls(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(SGR)) {
    out += stripControls(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + stripControls(text.slice(last));
}

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
