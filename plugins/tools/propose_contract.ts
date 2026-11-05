/**
 * propose_contract (session only): the model drafts the work item's contract before its first edit.
 *
 * The tool is only the model-facing schema. The interactive session (RunContext.session) does the
 * work: the HARNESS fills Repo, Base and Stakeholder (the person at this terminal, from the repository's
 * git user; Owner too when the model leaves it empty), writes docs/contracts/<slug>.md (and
 * metrics/<slug>.mjs) in the session's items root outside the repository, validates the text with the
 * same parser the gates use, records the proposal in the item ledger and shows it to the owner, with
 * the Measure script in full. Only the next line the owner types at the prompt can answer it; nothing
 * the model says or a tool returns is ever an approval. The before value is read only after that yes,
 * and what the script prints never reaches the model.
 *
 * No field may carry a control character (an ESC sequence, a carriage return, a bidirectional
 * override): what the model writes here is shown to the owner, and must read as it is. The Measure
 * script is held to more (measureScriptProblem): the owner reads it in the PROPOSAL box and node runs
 * it, so it may hold nothing that node reads differently from how a terminal shows it.
 *
 * Its effect is 'control' (never 'write'): it changes no repository file, so the write hooks do not
 * apply, and it is never offered in file mode (sessionOnly), where items are proposed with
 * `harness item propose`. Called outside a session it refuses.
 */
import { z } from 'zod';
import { controlChars, defineTool } from '../../src/core/plugin-api.ts';

/** A text field: no control character (newline and tab aside: the harness puts each value on one line). */
const text = (min = 1): z.ZodString =>
  z.string().min(min).refine((s) => controlChars(s).length === 0, { message: 'contains control characters (ESC, carriage return, bidirectional overrides...): write plain text' });

/** A character's code point as U+XXXX. */
function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Why a Measure script cannot be shown as it runs (null: it can). A \r\n is read as one newline; then
 * refused, by line: a lone carriage return, U+2028 or U+2029 (each ends a line, and a // comment, for
 * node, while a terminal shows no break: code after it would read as part of the comment), any other
 * control character but tab, and any invisible format character (zero-width, bidirectional, BOM, soft
 * hyphen, ...). With `ascii` (a script the model wrote) also anything outside printable ASCII, so no
 * look-alike letter makes two names read the same. Applies to /import scripts too (without `ascii`).
 */
export function measureScriptProblem(text: string, opts: { ascii?: boolean } = {}): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const [i, line] of lines.entries()) {
    for (const ch of line) {
      if (ch === '\t') continue;
      const c = ch.codePointAt(0) ?? 0;
      if (c === 0x0d || c === 0x2028 || c === 0x2029) return `line ${i + 1} holds ${codePoint(ch)}, a line break for node that a terminal does not show: end lines with a plain newline`;
      if (/[\p{Cc}\p{Cf}]/u.test(ch)) return `line ${i + 1} holds ${codePoint(ch)}: control characters and invisible characters are refused in a Measure script; write it as an escape inside a string (e.g. "\\u${c.toString(16).padStart(4, '0')}"), never raw`;
      if (opts.ascii === true && (c < 0x20 || c > 0x7e)) return `line ${i + 1} holds ${codePoint(ch)}: a Measure script you write is printable ASCII only (write any other character as a \\u escape inside a string), so what the owner reads is what runs`;
    }
  }
  return null;
}

/** A Measure script with Windows line endings read as plain newlines (what is written, shown and run). */
export function normalizeScript(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

const Scenario = z.object({
  when: text().describe('The condition, in the owner\'s terms (no leading "WHEN")'),
  then: text().describe('The observable result (no leading "THEN")'),
}).strict();

export const ProposeContractInput = z
  .object({
    slug: text(0).describe('Short id of the work item: lower-case letters, digits and dashes, 2-63 characters (e.g. login-redirect)'),
    problem: text().describe('What breaks or is missing, in the owner\'s words, with the evidence you found (files, lines)'),
    owner: text(0).optional().describe('The team or person this work is for; leave it out and the harness names the person at this terminal'),
    stakeholder: z.string().optional().describe('Leave it out: the harness fills Stakeholder with the person at this terminal (the repository\'s git user), whose typed yes approves the contract; a value sent here is ignored'),
    metric: z.object({ name: text(), window: text().describe('When it is read, e.g. "per test run" or "7 days after release"') }).strict(),
    scenarios: z.array(Scenario).min(1).describe('One per behaviour the change must have: WHEN <condition> THEN <observable result>'),
    notIncluded: z.array(text()).min(1).describe('What this change deliberately does not do'),
    commit: text().describe('The Conventional Commits header the harness will commit with: type(scope): subject naming what changes, at most 100 characters, no full stop'),
    ticket: text().optional().describe('A ticket id or URL, when the owner gave one'),
    base: text().optional().describe('The branch the PR will target; omit it and the harness uses the repository\'s default branch'),
    measureScript: z
      .string()
      .min(1)
      .superRefine((s, ctx) => {
        const problem = measureScriptProblem(s, { ascii: true });
        if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
      })
      .optional()
      .describe('Optional: the content of a small read-only Node .mjs script the harness runs, confined and offline, at a commit of this repository (cwd = repository root, no .env* files, no writes) only after the owner approves; it prints one line {"metric":"<name>","value":<number>}. Printable ASCII and newlines only (write any other character as a \\u escape inside a string). You never see what it prints. Omit it when no script can measure the metric (the contract then says Measure: none).'),
  })
  .strict();

export type ProposeContractInputT = z.infer<typeof ProposeContractInput>;

export default defineTool({
  name: 'propose_contract',
  description:
    'Before your first edit: propose the work item\'s contract (problem, scenarios, not included, metric, commit header) to the owner. The harness fills Repo, Base and Stakeholder, writes and shows it; only the owner\'s typed reply approves it. End your turn right after calling it and wait.',
  input: ProposeContractInput,
  effect: 'control',
  sessionOnly: true,
  async run(input, ctx) {
    if (ctx.session === undefined) {
      return { ok: false, summary: 'propose_contract: only an interactive session can propose a contract; in file mode the owner runs harness item propose <slug>' };
    }
    return ctx.session.proposeContract(input);
  },
});
