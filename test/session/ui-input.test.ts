/**
 * The screen and the keyboard. Colour and the spinner only on a terminal without NO_COLOR (their twin:
 * a pipe gets plain text); tool output is one clipped line; the verdict block says "Work completed"
 * only for DONE. The terminal reader takes its channel from stdin itself: a pipe is 'pipe' (it can
 * never approve), read in order to the end.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isSessionCommand } from '../../src/core/cli.ts';
import { terminalInput } from '../../src/session/input.ts';
import { runSessionCli } from '../../src/session/main.ts';
import { cellWidth, stripControls } from '../../src/session/sanitize.ts';
import { BANNER_LINES, cells, clip, colorEnabled, lineCounts, MODEL_GUTTER, Ui, WORK_COMPLETED, wrapLine } from '../../src/session/ui.ts';
import type { RunEvent } from '../../src/core/types.ts';

/** An output of `columns` columns (80), or none (null: a pipe, no rows to break). */
function capture(isTTY: boolean, columns: number | null = 80): { out: { write: (t: string) => void; isTTY: boolean; columns: number | undefined }; text: () => string } {
  let s = '';
  return { out: { write: (t) => void (s += t), isTTY, columns: columns ?? undefined }, text: () => s };
}

const ev = (e: Partial<RunEvent>): RunEvent => ({ turn: 1, at: '', kind: 'tool', source: 'read_file', message: '', ...e });

describe('colour', () => {
  it('only on a terminal, never with NO_COLOR or TERM=dumb', () => {
    expect(colorEnabled(true, {})).toBe(true);
    expect(colorEnabled(false, {})).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: '' })).toBe(true);
    expect(colorEnabled(true, { TERM: 'dumb' })).toBe(false);
  });

  it('coloured output carries ANSI codes; plain output none', () => {
    const c = capture(true);
    new Ui(c.out, true).error('x');
    expect(c.text()).toContain('\u001b[31m');
    const p = capture(false);
    new Ui(p.out, false).error('x');
    expect(p.text()).toBe('x\n');
  });
});

describe('the spinner', () => {
  it('draws on a terminal and clears itself', () => {
    const c = capture(true);
    const ui = new Ui(c.out, false);
    ui.startSpinner('thinking');
    ui.stopSpinner();
    expect(c.text()).toMatch(/^\r. thinking\u001b\[K\r\u001b\[K$/);
  });

  it('twin: a pipe never gets one', () => {
    const p = capture(false);
    const ui = new Ui(p.out, false);
    ui.startSpinner('thinking');
    ui.stopSpinner();
    expect(p.text()).toBe('');
  });
});

describe('lines', () => {
  it('the banner is the harness\'s own mark (a gate and the name), three lines', () => {
    expect(BANNER_LINES).toHaveLength(3);
    expect(BANNER_LINES.join('\n')).toContain('s f · h a r n e s s');
  });

  it('one line per tool call, clipped; writes marked ✎, blocks ✗ with the hook', () => {
    const p = capture(false);
    const ui = new Ui(p.out, false, (t) => (t === 'write_file' ? 'write' : 'read'));
    ui.event(ev({ source: 'read_file', decision: 'pass', message: 'src/a.ts (lines 1-120 of 300)' }));
    ui.event(ev({ source: 'write_file', decision: 'pass', message: 'wrote src/a.ts (+3 −1 lines)' }));
    ui.event(ev({ kind: 'hook', source: 'observed-red', decision: 'block', message: `observed-red: ${'x'.repeat(300)}` }));
    ui.event(ev({ kind: 'hook', source: 'path-guard', decision: 'pass', message: 'pre_tool write_file' }));
    const lines = p.text().trimEnd().split('\n');
    expect(lines[0]).toBe('● read_file src/a.ts (lines 1-120 of 300)');
    expect(lines[1]).toBe('✎ write_file wrote src/a.ts (+3 −1)');
    expect(lines[2]).toMatch(/^✗ BLOCKED by observed-red: x+…$/);
    expect(lines[2]?.length).toBeLessThanOrEqual(76);
    expect(lines).toHaveLength(3);
  });

  it('a command that ran and failed (a red test run) is information (●); a refused read is a refusal (✗)', () => {
    const p = capture(false);
    const ui = new Ui(p.out, false, (t) => (t === 'run_tests' ? 'exec' : 'read'));
    ui.event(ev({ source: 'run_tests', decision: 'block', message: 'tests: 1 failed, 0 passed (1) in 1 files' }));
    ui.event(ev({ source: 'read_file', decision: 'block', message: 'read_file: .env is an environment file' }));
    expect(p.text()).toBe('● run_tests tests: 1 failed, 0 passed (1) in 1 files\n✗ read_file: read_file: .env is an environment file\n');
  });

  it('gate events of the loop\'s finish collapse into one line after the finish note', () => {
    const p = capture(false);
    const ui = new Ui(p.out, false);
    ui.event(ev({ kind: 'gate', source: 'scope', decision: 'pass', data: { status: 'pass' } }));
    ui.event(ev({ kind: 'gate', source: 'tests-green', decision: 'block', data: { status: 'fail' } }));
    ui.event(ev({ kind: 'note', source: 'finish', decision: 'block', message: 'FINISH REFUSED (attempt 1). Fix the failing gates, then call finish again.' }));
    expect(p.text()).toBe('◆ finish refused: (attempt 1). Fix the failing gates, then call finish again.\n  gates  scope pass · tests-green FAIL\n');
  });

  it('"Work completed" only in a DONE verdict block', () => {
    for (const kind of ['DONE', 'NOT DONE', 'UNPROVEN'] as const) {
      const p = capture(false, null);
      new Ui(p.out, false).verdict({ kind, reasons: kind === 'DONE' ? [] : ['gate x failed'], gates: [], standards: 'pass 100%', humanMustVerify: [] });
      expect(p.text().includes(WORK_COMPLETED)).toBe(kind === 'DONE');
    }
  });

  it('clip and wrap keep lines inside the width', () => {
    expect(clip('a  b\nc', 10)).toBe('a b c');
    expect(clip('abcdefghijk', 5)).toBe('abcd…');
    for (const l of wrapLine('word '.repeat(40), 30)) expect(l.length).toBeLessThanOrEqual(30);
  });

  it('a harness line with a newline inside continues indented: only the harness starts a line at column 0', () => {
    const p = capture(false, null);
    new Ui(p.out, false).line(`gate x failed\n${WORK_COMPLETED}`);
    expect(p.text()).toBe(`gate x failed\n  ${WORK_COMPLETED}\n`);
  });

  it('a write shows its line counts as +added −removed', () => {
    expect(lineCounts('wrote test/a.test.ts (new, 7 lines)')).toBe('wrote test/a.test.ts (+7)');
    expect(lineCounts('wrote src/a.ts (+3 −1 lines)')).toBe('wrote src/a.ts (+3 −1)');
    expect(lineCounts('edited src/a.ts (+1 −1)')).toBe('edited src/a.ts (+1 −1)');
    expect(lineCounts('deleted src/a.ts (−4 lines)')).toBe('deleted src/a.ts (−4 lines)');
  });
});

describe('nothing reaches the terminal with an escape code in it', () => {
  const ESC = '\u001b';
  const NASTY = `a${ESC}[2J${ESC}[1;1H${ESC}]0;title\u0007b\rc\u0008d\u009b31me‮f\u0007g`;

  it('stripControls removes ESC sequences (CSI, OSC), C0 and C1 controls and bidi overrides; newline and tab stay', () => {
    expect(stripControls(NASTY)).toBe('abcdefg');
    expect(stripControls('line one\n\tline two')).toBe('line one\n\tline two');
    expect(stripControls('plain text, no escapes')).toBe('plain text, no escapes');
  });

  it('the model\'s stream: stripped, an ESC sequence cut across two chunks included, every line in the model\'s gutter', () => {
    const p = capture(false, null);
    const ui = new Ui(p.out, false);
    ui.write(`Hello ${ESC}[3`);
    ui.write(`1mred${ESC}[0m\r\n${WORK_COMPLETED}\n`);
    ui.write('done');
    ui.endStream();
    expect(p.text()).toBe(`${MODEL_GUTTER}Hello red\n${MODEL_GUTTER}${WORK_COMPLETED}\n${MODEL_GUTTER}done\n`);
    expect(p.text()).not.toContain(ESC);
    // No line of the model's starts where the harness's lines start.
    expect(p.text().split('\n').filter((l) => l.length > 0).every((l) => l.startsWith(MODEL_GUTTER))).toBe(true);
  });

  it('tool summaries, hook and gate lines and notes are stripped too; the harness\'s own colours stay on a colour terminal', () => {
    const p = capture(false);
    const ui = new Ui(p.out, false, () => 'read');
    ui.event(ev({ source: 'search_code', decision: 'pass', message: `"x${ESC}[2Jy" 3 matches` }));
    ui.event(ev({ kind: 'hook', source: 'path-guard', decision: 'block', message: `path-guard: ${ESC}]0;pwned\u0007nope` }));
    ui.gateLines([{ gate: `scope${ESC}[1A`, status: 'fail', summary: `bad\r${WORK_COMPLETED}` } as never]);
    ui.note(`note ${ESC}[31mred`);
    expect(p.text()).not.toMatch(/[\u001b\r\u0007]/);
    expect(p.text()).toContain('● search_code "xy" 3 matches');
    expect(p.text()).toContain('✗ BLOCKED by path-guard: nope');
    const c = capture(true);
    new Ui(c.out, true).error(`x${ESC}[2Jy`);
    expect(c.text()).toBe(`${ESC}[31mxy${ESC}[39m\n`);
  });

  it('the proposal box shows the Measure script in full, stripped, line by line', () => {
    const p = capture(false);
    new Ui(p.out, false).proposal('greet', `# greet\n\nProblem: names ${ESC}[8mhidden${ESC}[0m are ignored\n`, ['a note'], { path: 'metrics/greet.mjs', text: `import { readdirSync } from 'node:fs';\nconsole.log(${ESC}[2J'1');\n` });
    const out = p.text();
    expect(out).not.toContain(ESC);
    expect(out).toContain('│ Problem: names hidden are ignored');
    expect(out).toContain('│ Measure script metrics/greet.mjs (2 lines)\n│ the harness runs it, confined and offline, only after your yes; its output\n│   never reaches the agent');
    expect(out).toContain("│   import { readdirSync } from 'node:fs';");
    expect(out).toContain("│   console.log('1');");
  });

  it('the box breaks a script where node does (CR, U+2028, U+2029 too) and a contract where its parser does (CR too): nothing is glued onto a comment', () => {
    const CR = String.fromCharCode(0x0d);
    const LS = String.fromCharCode(0x2028);
    const p = capture(false, null);
    new Ui(p.out, false).proposal('greet', `# greet${CR}Problem: names${CR}Owner: web team\n`, [], { path: 'metrics/greet.mjs', text: `// prints 1${CR}console.log(42);${LS}console.log(43);\n` });
    const out = p.text();
    expect(out).toContain('│ Measure script metrics/greet.mjs (3 lines)');
    expect(out).toContain('│   // prints 1\n│   console.log(42);\n│   console.log(43);\n');
    expect(out).toContain('│ Problem: names\n│ Owner: web team\n');
    // The twin: a script with plain newlines is shown with the same lines.
    const q = capture(false, null);
    new Ui(q.out, false).proposal('greet', '# greet\nProblem: names\n', [], { path: 'metrics/greet.mjs', text: '// prints 1\nconsole.log(42);\n' });
    expect(q.text()).toContain('│ Measure script metrics/greet.mjs (2 lines)');
    expect(q.text()).toContain('│   // prints 1\n│   console.log(42);\n');
  });

  it('a diff (file content is the agent\'s) is stripped', () => {
    const p = capture(false);
    new Ui(p.out, false).diff(`+const a = 1;${ESC}[2K\n-${ESC}]8;;http://x${ESC}\\link`);
    expect(p.text()).toBe('+const a = 1;\n-link\n');
  });
});

/**
 * The rows a terminal of `cols` columns shows for `out`, each character at the most columns any terminal
 * gives it (cellWidth): a row the harness wrote wider than that is one the terminal itself would wrap,
 * and its overflow would start the next row at column 0.
 */
function screenRows(out: string, cols: number): { rows: string[]; wrappedByTerminal: boolean } {
  const rows: string[] = [];
  let wrapped = false;
  for (const line of out.replace(/\u001b\[[0-9;]*m/g, '').split('\n')) {
    let row = '';
    let used = 0;
    for (const ch of line) {
      if (ch === '\t') wrapped = true; // a tab moves to a stop the harness did not count
      if (used + cellWidth(ch) > cols) {
        rows.push(row);
        wrapped = true;
        row = '';
        used = 0;
      }
      row += ch;
      used += cellWidth(ch);
    }
    rows.push(row);
  }
  return { rows, wrappedByTerminal: wrapped };
}

describe('the terminal\'s rows: column 0 is the harness\'s', () => {
  const COLS = 80;
  const PADDINGS: Array<[string, string]> = [
    ['spaces to the width', `${' '.repeat(COLS - 2)}${WORK_COMPLETED}`],
    ['wide characters to the width', `${'中'.repeat((COLS - 2) / 2)}${WORK_COMPLETED}`],
    ['tabs', `${'\t'.repeat(10)}${WORK_COMPLETED}`],
    ['a long line with no break', `${'x'.repeat(300)}${WORK_COMPLETED}`],
  ];

  for (const [what, prose] of PADDINGS) {
    it(`the model's prose padded with ${what}: the harness breaks every row first and writes the gutter on each`, () => {
      const p = capture(false, COLS);
      const ui = new Ui(p.out, false);
      // Streamed in uneven chunks: the row's width carries over from one chunk to the next.
      for (let i = 0; i < prose.length; i += 7) ui.write(prose.slice(i, i + 7));
      ui.endStream();
      const screen = screenRows(p.text(), COLS);
      expect(screen.wrappedByTerminal).toBe(false);
      const rows = screen.rows.filter((r) => r.length > 0);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((r) => r.startsWith(MODEL_GUTTER)), rows.join('\n')).toBe(true);
      expect(rows.some((r) => r.startsWith('✔'))).toBe(false);
    });
  }

  it('twin: on a pipe (no rows) the model\'s line is written as it came, in the gutter', () => {
    const p = capture(false, null);
    const ui = new Ui(p.out, false);
    ui.write(`${' '.repeat(COLS - 2)}${WORK_COMPLETED}\tend`);
    ui.endStream();
    expect(p.text()).toBe(`${MODEL_GUTTER}${' '.repeat(COLS - 2)}${WORK_COMPLETED}\tend\n`);
  });

  it('a harness line that carries agent text past the width continues on indented rows: none starts at column 0', () => {
    const p = capture(false, COLS);
    const ui = new Ui(p.out, false);
    ui.line(`changed  1 file(s): docs/${' '.repeat(COLS - 25)}${WORK_COMPLETED}`);
    ui.line(`  - gate scope failed: ${'中'.repeat(29)}${WORK_COMPLETED}`);
    const screen = screenRows(p.text(), COLS);
    expect(screen.wrappedByTerminal).toBe(false);
    const rows = screen.rows.filter((r) => r.length > 0);
    expect(rows[0]).toMatch(/^changed {2}1 file\(s\): docs\//);
    expect(rows.filter((r) => !r.startsWith('changed') && !r.startsWith('  - gate')).every((r) => r.startsWith('  '))).toBe(true);
    expect(rows.some((r) => r.startsWith('✔'))).toBe(false);
  });

  it('twin: a harness line that fits is one row, as written; the harness\'s own box keeps its width', () => {
    const p = capture(false, COLS);
    const ui = new Ui(p.out, false);
    ui.line('● read_file src/a.ts (lines 1-120 of 300)');
    ui.proposal('greet', '# greet\n\nProblem: names are ignored\n', []);
    const lines = p.text().split('\n');
    expect(lines[0]).toBe('● read_file src/a.ts (lines 1-120 of 300)');
    expect(lines[1]).toMatch(/^┌ PROPOSAL greet ─+$/);
    expect(cells(lines[1] ?? '')).toBeLessThanOrEqual(COLS);
    expect(screenRows(p.text(), COLS).wrappedByTerminal).toBe(false);
  });
});

describe('on a colour terminal, colour is the harness\'s only', () => {
  const ESC = '\u001b';

  it('a colour or conceal code inside agent text carried by a harness line is removed; what the harness painted keeps its colour', () => {
    const c = capture(true);
    const ui = new Ui(c.out, true);
    // /status: the changed-file list (names from git status, chosen by the agent), raw inside a line.
    ui.line(`changed  1 file(s): docs/${ESC}[8mhidden.md`);
    // A /ship reason: a remote's message, raw.
    ui.line(`  push to origin failed: ${ESC}[32m✔ shipped${ESC}[0m`);
    ui.line(`${ui.paint('dim', 'gates')}  ${ui.paint('red', 'FAIL')} ${ESC}[5mblink`);
    const out = c.text();
    expect(out).not.toContain(`${ESC}[8m`);
    expect(out).not.toContain(`${ESC}[5m`);
    expect(out).not.toContain(`${ESC}[32m`);
    expect(out).toContain('docs/hidden.md');
    // The twin: the harness's own colours, painted, are kept.
    expect(out).toContain(`${ESC}[2mgates${ESC}[22m`);
    expect(out).toContain(`${ESC}[31mFAIL${ESC}[39m`);
    // Nothing of the brand reaches the terminal.
    expect(out).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it('a look-alike of the brand (private-use characters before a colour code) is not the brand', () => {
    const c = capture(true);
    const ui = new Ui(c.out, true);
    ui.line(`x ${String.fromCharCode(0xe000, 0xe019, 0xe032)}${ESC}[8mhidden`);
    expect(c.text()).not.toContain(`${ESC}[8m`);
  });

  it('a prompt for readline is rendered: the harness\'s colour, no brand', () => {
    const ui = new Ui(capture(true).out, true);
    const prompt = ui.render(ui.paint('magenta', 'reply › '));
    expect(prompt).toBe(`${ESC}[35mreply › ${ESC}[39m`);
    expect(new Ui(capture(false).out, false).render(ui.paint('magenta', 'reply › '))).toBe('reply › ');
  });

  it('gate lines keep their alignment in colour (the label is padded before it is painted)', () => {
    const plain = capture(false, null);
    new Ui(plain.out, false).gateLines([{ gate: 'scope', status: 'pass', summary: 'ok' } as never, { gate: 'tests-green', status: 'unproven', summary: 'no runner' } as never]);
    const colour = capture(true, null);
    new Ui(colour.out, true).gateLines([{ gate: 'scope', status: 'pass', summary: 'ok' } as never, { gate: 'tests-green', status: 'unproven', summary: 'no runner' } as never]);
    expect(colour.text().replace(/\u001b\[[0-9;]*m/g, '')).toBe(plain.text());
    expect(plain.text()).toBe('  scope            pass      ok\n  tests-green      UNPROVEN  no runner\n');
  });
});

describe('the terminal reader', () => {
  it('a pipe is the pipe channel, read in order to the end of input', async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const input = terminalInput({ stdin, stdout });
    expect(input.channel).toBe('pipe');
    (stdin as unknown as PassThrough).end('hello\nyes\n');
    expect(await input.read('› ')).toEqual({ kind: 'line', text: 'hello' });
    expect(await input.read('› ')).toEqual({ kind: 'line', text: 'yes' });
    expect(await input.read('› ')).toEqual({ kind: 'eof' });
    input.close();
  });
});

describe('the command line', () => {
  it('no command, only options, or chat starts a session; a command or --help does not', () => {
    expect(isSessionCommand([])).toBe(true);
    expect(isSessionCommand(['chat'])).toBe(true);
    expect(isSessionCommand(['--model', 'x'])).toBe(true);
    expect(isSessionCommand(['run', 'task.yaml'])).toBe(false);
    expect(isSessionCommand(['--help'])).toBe(false);
    expect(isSessionCommand(['-h'])).toBe(false);
  });

  it('a session refuses an unknown option or an argument before it starts (exit 2)', async () => {
    const lines: string[] = [];
    expect(await runSessionCli({ positionals: [], flags: new Map([['ship', ['x']]]), bools: new Set() }, (l) => lines.push(l))).toBe(2);
    expect(await runSessionCli({ positionals: ['extra'], flags: new Map(), bools: new Set() }, (l) => lines.push(l))).toBe(2);
    expect(await runSessionCli({ positionals: [], flags: new Map([['max-turns', ['0']]]), bools: new Set() }, (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([
      'unknown option --ship (a session takes --driver, --model, --max-turns, --driver-opt)',
      'a session takes no arguments, got: extra',
      '--max-turns must be a positive integer (turns per message)',
    ]);
  });
});
