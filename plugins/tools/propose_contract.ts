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
 * override): what the model writes here is shown to the owner, and must read as it is.
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
      .refine((s) => controlChars(s, '\n\t\r').length === 0, { message: 'contains control characters other than newline and tab: write escapes (e.g. "\\x1b") as text, not raw bytes' })
      .optional()
      .describe('Optional: the content of a small read-only Node .mjs script the harness runs, confined and offline, at a commit of this repository (cwd = repository root, no .env* files, no writes) only after the owner approves; it prints one line {"metric":"<name>","value":<number>}. You never see what it prints. Omit it when no script can measure the metric (the contract then says Measure: none).'),
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
