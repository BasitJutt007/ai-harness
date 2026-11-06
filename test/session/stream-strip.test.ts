/**
 * The model's stream is stripped as it arrives, and the result is the same however it was chunked: what
 * stripControls gives the whole text. An escape sequence can be cut anywhere across chunks and can be
 * of any length (an unterminated OSC string longer than any buffer is still dropped to its end, as the
 * whole text's strip drops it); the single-byte C1 CSI and OSC are sequences in a stream too. The twin
 * of every case is the whole text in one chunk.
 */
import { describe, expect, it } from 'vitest';
import { StreamStripper, stripControls } from '../../src/session/sanitize.ts';
import { MODEL_GUTTER, Ui } from '../../src/session/ui.ts';

const ESC = '\u001b';
const BEL = '\u0007';

/** What `chunks`, streamed as the model's prose to an output of `cols` columns (null: a pipe), shows. */
function streamed(chunks: string[], cols: number | null): string {
  let s = '';
  const ui = new Ui({ write: (t) => void (s += t), isTTY: false, columns: cols ?? undefined }, false);
  for (const c of chunks) ui.write(c);
  ui.endStream();
  return s;
}

/** `chunks` through one StreamStripper, its end included. */
function stripped(chunks: string[]): string {
  const s = new StreamStripper();
  return chunks.map((c) => s.push(c)).join('') + s.end();
}

/** `text` in pieces of `size` UTF-16 units. */
function units(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** A repeatable pseudo-random source (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every character a sequence can start, continue, end or break on, plain text, controls, C1, a pair. */
const ALPHABET = [ESC, ESC, ESC, '[', '[', ']', 'P', 'X', '^', '_', '\\', BEL, '\u009b', '\u009c', '\u009d', '\u0090', '0', '1', ';', '?', ' ', '!', '/', 'm', 'A', 'a', 'z', '~', '\n', '\t', '\r', '\u0008', '\u007f', 'é', '😀', '‮'];

function sample(next: () => number): { text: string; chunks: string[] } {
  let text = '';
  const n = Math.floor(next() * 40);
  for (let i = 0; i < n; i += 1) text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? 'a';
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    const k = 1 + Math.floor(next() * 5);
    chunks.push(text.slice(i, i + k));
    i += k;
  }
  return { text, chunks };
}

describe('the model\'s stream is stripped the same however it is chunked', () => {
  it('random texts of escape sequences, controls and text, cut anywhere: the rows are those of the whole text', () => {
    const next = random(20261106);
    for (let i = 0; i < 3000; i += 1) {
      const { text, chunks } = sample(next);
      for (const cols of [null, 20]) {
        const whole = streamed([text], cols);
        expect(streamed(chunks, cols), `${JSON.stringify(text)} in ${JSON.stringify(chunks)} at ${cols}`).toBe(whole);
        expect(streamed(units(text, 1), cols), `${JSON.stringify(text)} a unit at a time at ${cols}`).toBe(whole);
        expect(whole).not.toMatch(/[\u001b\u009b\u009d]/);
      }
    }
  });

  it('StreamStripper gives exactly what stripControls gives the whole text, for every chunking of those texts', () => {
    const next = random(7);
    for (let i = 0; i < 3000; i += 1) {
      const { text, chunks } = sample(next);
      const want = stripControls(text);
      expect(stripped([text]), JSON.stringify(text)).toBe(want);
      expect(stripped(chunks), `${JSON.stringify(text)} in ${JSON.stringify(chunks)}`).toBe(want);
      expect(stripped(units(text, 1)), `${JSON.stringify(text)} a unit at a time`).toBe(want);
    }
  });

  it('an unterminated OSC longer than any buffer is dropped to the end of the stream however it arrives (it was shown, a character at a time, past 256)', () => {
    const text = `start ${ESC}]0;${'t'.repeat(300)} visible tail words`;
    const whole = streamed([text], 40);
    expect(whole).toBe(`${MODEL_GUTTER}start \n`);
    expect(streamed(units(text, 1), 40)).toBe(whole);
    expect(streamed(units(text, 7), 40)).toBe(whole);
    // The same for a DCS string, and for an unterminated single-byte OSC.
    for (const open of [`${ESC}P`, '\u009d']) {
      const t = `start ${open}${'q'.repeat(300)} hidden`;
      expect(streamed(units(t, 1), 40), JSON.stringify(open)).toBe(streamed([t], 40));
    }
  });

  it('twin: the same long OSC, terminated (BEL or ST), hides only itself: the text after it is shown, however it arrives', () => {
    for (const end of [BEL, `${ESC}\\`]) {
      const text = `start ${ESC}]0;${'t'.repeat(300)}${end} visible tail words`;
      const whole = streamed([text], 40);
      expect(whole, JSON.stringify(end)).toBe(`${MODEL_GUTTER}start  visible tail words\n`);
      expect(streamed(units(text, 1), 40), JSON.stringify(end)).toBe(whole);
    }
    // A CSI with a long run of parameters is a complete colour code: dropped whole either way.
    const csi = `a ${ESC}[${'1;'.repeat(200)}31mb`;
    expect(streamed(units(csi, 1), null)).toBe(streamed([csi], null));
    expect(streamed([csi], null)).toBe(`${MODEL_GUTTER}a b\n`);
  });

  it('single-byte C1 sequences cut across chunks are stripped as in the whole text', () => {
    const cases = [
      ['\u009b3', '1m text'],
      ['\u009d0;tit', `le${BEL} rest`],
      ['\u009d0;title\u009c', ' rest'],
      ['\u009b', '12'],
    ];
    for (const chunks of cases) expect(streamed(chunks, null), JSON.stringify(chunks)).toBe(streamed([chunks.join('')], null));
    expect(streamed(['\u009b3', '1m text'], null)).toBe(`${MODEL_GUTTER} text\n`);
    expect(streamed(['\u009d0;tit', `le${BEL} rest`], null)).toBe(`${MODEL_GUTTER} rest\n`);
    expect(streamed(['\u009b', '12'], null)).toBe(`${MODEL_GUTTER}12\n`);
  });

  it('a long unterminated string is not held: memory does not grow with it, and 200k characters a character at a time are quick', () => {
    const s = new StreamStripper();
    expect(s.push(`ok ${ESC}]0;`)).toBe('ok ');
    const t0 = performance.now();
    let shown = '';
    for (let i = 0; i < 200_000; i += 1) shown += s.push('x');
    expect(shown).toBe('');
    expect(s.heldLength).toBe(0);
    expect(s.push(`${BEL}after`)).toBe('after');
    expect(s.end()).toBe('');
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
