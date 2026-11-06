/**
 * Fail-closed audit: the Measure script the owner reads in the PROPOSAL box is the script node runs.
 * The owner approves the script by reading it, and the harness runs it after that yes, so nothing in it
 * may read differently on a terminal than it does to node. Each mutation hides code from the reader a
 * different way (a line break node sees and a terminal does not, an invisible character, a look-alike
 * letter); measureScriptProblem must refuse every one in a script the model writes. The baseline (the
 * same code, plain) passes, and the box shows it with exactly the lines node reads. A mutation that
 * passes is a hole: fix measureScriptProblem, never this list.
 *
 *   npm run audit:mutations
 */
import { describe, expect, it } from 'vitest';
import { measureScriptProblem } from '../../plugins/tools/propose_contract.ts';
import { SCRIPT_LINE_BREAK } from '../../src/session/sanitize.ts';
import { Ui } from '../../src/session/ui.ts';

const ch = (code: number): string => String.fromCharCode(code);
const SHOWN = "console.log(JSON.stringify({ metric: 'm', value: 1 })); // prints 1";
const HIDDEN = "console.log(JSON.stringify({ metric: 'm', value: 42 }));";

const MUTATIONS: Array<{ name: string; script: string; owner: boolean }> = [
  // `owner`: refused in an imported (owner-written) script too, not only in one the model writes.
  { name: 'lone carriage return ends the comment', script: `${SHOWN}${ch(0x0d)}${HIDDEN}\n`, owner: true },
  { name: 'U+2028 line separator ends the comment', script: `${SHOWN}${ch(0x2028)}${HIDDEN}\n`, owner: true },
  { name: 'U+2029 paragraph separator ends the comment', script: `${SHOWN}${ch(0x2029)}${HIDDEN}\n`, owner: true },
  { name: 'zero-width joiner makes a second name', script: `const value = 1; const val${ch(0x200d)}ue = 42;\nconsole.log(val${ch(0x200d)}ue);\n`, owner: true },
  { name: 'zero-width non-joiner makes a second name', script: `const value = 1; const val${ch(0x200c)}ue = 42;\nconsole.log(val${ch(0x200c)}ue);\n`, owner: true },
  { name: 'right-to-left override reorders a line', script: `const v = 1; /* ${ch(0x202e)} } ;24 = v { */\nconsole.log(v);\n`, owner: true },
  { name: 'byte order mark inside the code', script: `const v = 1;${ch(0xfeff)}\nconsole.log(v);\n`, owner: true },
  { name: 'soft hyphen inside a name', script: `const va${ch(0x00ad)}lue = 42;\nconsole.log(va${ch(0x00ad)}lue);\n`, owner: true },
  { name: 'next line (U+0085)', script: `${SHOWN}${ch(0x85)}${HIDDEN}\n`, owner: true },
  { name: 'vertical tab and form feed', script: `const v = 1;${ch(0x0b)}${ch(0x0c)}\nconsole.log(v);\n`, owner: true },
  { name: 'ESC sequence that erases the screen', script: `console.log(1); /* ${ch(0x1b)}[2J */\n`, owner: true },
  { name: 'Cyrillic look-alike letter makes a second name', script: `const value = 1; const v${ch(0x0430)}lue = 42;\nconsole.log(v${ch(0x0430)}lue);\n`, owner: false },
  { name: 'Greek look-alike letter makes a second name', script: `const value = 1; const val${ch(0x03c5)}e = 42;\nconsole.log(val${ch(0x03c5)}e);\n`, owner: false },
];

describe('Measure script display mutations', () => {
  it('baseline: the plain script passes, and the box shows exactly the lines node reads', () => {
    const plain = `${SHOWN}\n${HIDDEN}\n`;
    expect(measureScriptProblem(plain, { ascii: true })).toBeNull();
    expect(measureScriptProblem(plain)).toBeNull();
    let out = '';
    new Ui({ write: (t) => void (out += t), isTTY: false }, false).proposal('m', '# m\nProblem: x\n', [], { path: 'metrics/m.mjs', text: plain });
    const nodeLines = plain.replace(/\n$/, '').split(SCRIPT_LINE_BREAK);
    expect(out).toContain(`(${nodeLines.length} lines)`);
    for (const l of nodeLines) expect(out).toContain(`│   ${l}\n`);
  });

  for (const m of MUTATIONS) {
    it(`refused: ${m.name}`, () => {
      expect(measureScriptProblem(m.script, { ascii: true }), m.name).not.toBeNull();
      if (m.owner) expect(measureScriptProblem(m.script), `${m.name} (an imported script)`).not.toBeNull();
    });
  }
});
