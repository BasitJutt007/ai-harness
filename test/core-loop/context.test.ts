import { describe, expect, it } from 'vitest';
import {
  baselineView,
  compactToolInput,
  DIGEST_HEADER,
  DIGEST_VALUE_CHARS,
  digestInput,
  digestTurn,
  ELIDE_INPUT_CHARS,
  headline,
  jitView,
  messageChars,
  type TranscriptTurn,
} from '../../src/core/context.ts';
import type { Message, Part } from '../../src/core/types.ts';

const first: Message = { role: 'user', parts: [{ type: 'text', text: 'brief' }] };

const body = (n: number): string => `line one of ${n}\n${'detail line\n'.repeat(10)}end`;

function turn(n: number, opts: { content?: string; writeContent?: string } = {}): TranscriptTurn {
  const id = `c${n}`;
  const parts: Part[] = [{ type: 'text', text: `thinking ${n}` }];
  if (opts.writeContent !== undefined) {
    parts.push({ type: 'tool_call', id, name: 'write_file', input: { path: `src/f${n}.ts`, content: opts.writeContent } });
  } else {
    parts.push({ type: 'tool_call', id, name: 'run_tests', input: {} });
  }
  const content = opts.content ?? body(n);
  return {
    turn: n,
    assistant: { role: 'assistant', parts },
    results: { role: 'user', parts: [{ type: 'tool_result', callId: id, content, isError: false }] },
    raw: { [id]: `RAW ${n} `.repeat(200) },
  };
}

function resultContent(m: Message | undefined): string {
  const p = m?.parts[0];
  return p !== undefined && p.type === 'tool_result' ? p.content : '';
}

function callInput(m: Message | undefined): unknown {
  const p = m?.parts.find((x) => x.type === 'tool_call');
  return p !== undefined && p.type === 'tool_call' ? p.input : null;
}

function digestText(view: Message[]): string {
  const p = view[0]?.parts[1];
  return p !== undefined && p.type === 'text' ? p.text : '';
}

/** Serialization used to check prefix stability (what a provider's prompt cache keys on). */
function serialize(view: Message[]): string {
  return view.map((m) => `${m.role}:${m.parts.map((p) => JSON.stringify(p)).join('|')}`).join('\n');
}

describe('input elision and digest helpers', () => {
  it('elides every input string longer than the threshold, keeping short ones and the path', () => {
    const long = 'y'.repeat(ELIDE_INPUT_CHARS + 1);
    expect(compactToolInput({ path: 'src/a.ts', content: long, note: 'ok' })).toEqual({
      path: 'src/a.ts',
      content: `<omitted ${ELIDE_INPUT_CHARS + 1} chars>`,
      note: 'ok',
    });
    expect(compactToolInput({ find: 'z'.repeat(500), replace: 'short' })).toEqual({ find: '<omitted 500 chars>', replace: 'short' });
    expect(compactToolInput({ content: 'z'.repeat(ELIDE_INPUT_CHARS) })).toEqual({ content: 'z'.repeat(ELIDE_INPUT_CHARS) });
    expect(compactToolInput({ steps: ['a', 'w'.repeat(400)] })).toEqual({ steps: ['a', '<omitted 400 chars>'] });
  });

  it('renders digest inputs as short key=value pairs', () => {
    expect(digestInput({ path: 'src/a.ts', startLine: 3 })).toBe('path=src/a.ts startLine=3');
    expect(digestInput({ pattern: 'two words' })).toBe('pattern="two words"');
    expect(digestInput({ path: 'a.ts', content: 'q'.repeat(1000) })).toBe('path=a.ts content=<1000 chars>');
    expect(digestInput({ path: 'a.ts', find: 'f'.repeat(DIGEST_VALUE_CHARS + 1), replace: 'short one' })).toBe(
      `path=a.ts find=<${DIGEST_VALUE_CHARS + 1} chars> replace="short one"`,
    );
    expect(digestInput({ files: ['test/a.test.ts'], steps: ['one step', 'x'.repeat(200)] })).toBe('files=[test/a.test.ts] steps=["one step",<200 chars>]');
    expect(digestInput({ q: { a: 1, b: 'two words' } })).toBe('q={a:1,b:"two words"}');
    expect(digestInput({})).toBe('');
  });

  it('headline skips blank and rule-only lines and caps length', () => {
    expect(headline('\n────────\nverdict 100%\nmore')).toBe('verdict 100%');
    expect(headline('x'.repeat(300))).toBe(`${'x'.repeat(200)}…`);
    expect(headline('zod-boundary      FAIL  src/a.ts     3/5 handlers')).toBe('zod-boundary FAIL src/a.ts 3/5 handlers');
    expect(headline('')).toBe('');
  });

  it('digests one line per tool call and drops assistant prose', () => {
    const t = turn(7, { writeContent: 'q'.repeat(1000), content: 'wrote src/f7.ts (new, 40 lines)' });
    expect(digestTurn(t)).toEqual(['t7 write_file path=src/f7.ts content=<1000 chars> -> wrote src/f7.ts (new, 40 lines)']);
    const nudge: TranscriptTurn = {
      turn: 3,
      assistant: { role: 'assistant', parts: [{ type: 'text', text: 'hmm' }] },
      results: { role: 'user', parts: [{ type: 'text', text: 'nudge' }] },
      raw: {},
    };
    expect(digestTurn(nudge)).toEqual(['t3 (no tool call)']);
  });
});

describe('jitView', () => {
  it('keeps the last keepRecentTurns as messages and folds older turns into the digest', () => {
    const turns = [1, 2, 3, 4].map((n) => turn(n));
    const view = jitView(first, turns, 2, true);
    expect(view).toHaveLength(1 + 2 * 2);
    expect(view[0]?.parts[0]).toEqual(first.parts[0]);
    expect(digestText(view)).toBe([DIGEST_HEADER, 't1 run_tests -> line one of 1', 't2 run_tests -> line one of 2'].join('\n'));
    expect(resultContent(view[2])).toBe(body(3));
    expect(resultContent(view[4])).toBe(body(4));
    expect(JSON.stringify(view)).not.toContain('thinking 1');
  });

  it('leaves the first message untouched while nothing is old enough to fold', () => {
    const turns = [1, 2].map((n) => turn(n));
    expect(jitView(first, turns, 2, true)[0]).toBe(first);
  });

  it('elides large inputs from the first replay on, including the most recent turn', () => {
    const turns = [1, 2, 3].map((n) => turn(n, { writeContent: 'q'.repeat(1000) }));
    const view = jitView(first, turns, 2, true);
    expect(callInput(view[3])).toEqual({ path: 'src/f3.ts', content: '<omitted 1000 chars>' });
    expect(callInput(view[1])).toEqual({ path: 'src/f2.ts', content: '<omitted 1000 chars>' });
    expect(digestText(view)).toContain('t1 write_file path=src/f1.ts content=<1000 chars>');
  });

  it('does not elide or fold when compactHistory is false', () => {
    const turns = [1, 2, 3, 4].map((n) => turn(n, { writeContent: 'q'.repeat(1000) }));
    const view = jitView(first, turns, 2, false);
    expect(view).toHaveLength(1 + 4 * 2);
    expect(view[0]).toBe(first);
    expect(resultContent(view[2])).toBe(body(1));
    expect(callInput(view[1])).toEqual({ path: 'src/f1.ts', content: 'q'.repeat(1000) });
  });

  it('is append-only: everything before the recent window is a prefix of the next request', () => {
    const turns = [1, 2, 3, 4, 5, 6, 7].map((n) => turn(n, { writeContent: `w${n} `.repeat(300) }));
    for (let k = 1; k < turns.length; k += 1) {
      const prev = jitView(first, turns.slice(0, k), 2, true);
      const next = jitView(first, turns.slice(0, k + 1), 2, true);
      // the first message (brief + digest so far) only ever grows at its end
      expect(serialize(next.slice(0, 1)).startsWith(serialize(prev.slice(0, 1)).replace(/"}$/, ''))).toBe(true);
      // a turn's recent-window rendering never changes while it stays in the window
      const lastPrev = prev.slice(-2);
      expect(next.slice(-4, -2)).toEqual(lastPrev);
    }
  });

  it('keeps tool_call / tool_result pairing intact in the recent window', () => {
    const turns = [1, 2, 3, 4, 5].map((n) => turn(n, { writeContent: 'q'.repeat(1000) }));
    const view = jitView(first, turns, 2, true);
    for (let i = 1; i < view.length; i += 2) {
      const a = view[i];
      const r = view[i + 1];
      expect(a?.role).toBe('assistant');
      expect(r?.role).toBe('user');
      const callIds = (a?.parts ?? []).flatMap((p) => (p.type === 'tool_call' ? [p.id] : []));
      const resultIds = (r?.parts ?? []).flatMap((p) => (p.type === 'tool_result' ? [p.callId] : []));
      expect(resultIds).toEqual(callIds);
    }
  });

  it('keepRecentTurns 0 folds everything into the first message', () => {
    const view = jitView(first, [turn(1), turn(2)], 0, true);
    expect(view).toHaveLength(1);
    expect(digestText(view).split('\n')).toHaveLength(3);
  });

  it('does not mutate the canonical transcript', () => {
    const turns = [1, 2, 3].map((n) => turn(n, { writeContent: 'q'.repeat(1000) }));
    const before = JSON.stringify(turns);
    const firstBefore = JSON.stringify(first);
    jitView(first, turns, 0, true);
    jitView(first, turns, 1, true);
    expect(JSON.stringify(turns)).toBe(before);
    expect(JSON.stringify(first)).toBe(firstBefore);
  });

  it('passes nudge-only turns in the recent window through', () => {
    const t: TranscriptTurn = {
      turn: 3,
      assistant: { role: 'assistant', parts: [{ type: 'text', text: 'hmm' }] },
      results: { role: 'user', parts: [{ type: 'text', text: 'nudge' }] },
      raw: {},
    };
    const view = jitView(first, [turn(1), turn(2), t], 2, true);
    expect(view[view.length - 1]).toEqual(t.results);
  });
});

describe('baselineView', () => {
  it('uses raw output for every result and compacts nothing', () => {
    const turns = [1, 2, 3, 4].map((n) => turn(n, { writeContent: 'q'.repeat(1000) }));
    const view = baselineView(first, turns);
    expect(resultContent(view[2])).toBe(turns[0]?.raw['c1']);
    expect(callInput(view[1])).toEqual({ path: 'src/f1.ts', content: 'q'.repeat(1000) });
    expect(messageChars(view)).toBeGreaterThan(messageChars(jitView(first, turns, 2, false)));
    expect(messageChars(jitView(first, turns, 2, false))).toBeGreaterThan(messageChars(jitView(first, turns, 2, true)));
  });

  it('falls back to the visible content when no raw is stored', () => {
    const t = turn(1);
    t.raw = {};
    expect(resultContent(baselineView(first, [t])[2])).toBe(body(1));
  });
});
