/**
 * propose_contract (session only): the model drafts the work item's contract before its first edit.
 *
 * The tool is only the model-facing schema. The interactive session (RunContext.session) does the
 * work: the HARNESS fills Repo and Base, writes docs/contracts/<slug>.md (and metrics/<slug>.mjs) in
 * the session's items root outside the repository, validates the text with the same parser the gates
 * use, reads the before value, records the proposal in the item ledger and shows it to the owner. Only
 * the next line the owner types at the prompt can answer it; nothing the model says or a tool returns
 * is ever an approval.
 *
 * Its effect is 'control' (never 'write'): it changes no repository file, so the write hooks do not
 * apply, and it is never offered in file mode (sessionOnly), where items are proposed with
 * `harness item propose`. Called outside a session it refuses.
 */
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

const Scenario = z.object({
  when: z.string().min(1).describe('The condition, in the owner\'s terms (no leading "WHEN")'),
  then: z.string().min(1).describe('The observable result (no leading "THEN")'),
}).strict();

export const ProposeContractInput = z
  .object({
    slug: z.string().describe('Short id of the work item: lower-case letters, digits and dashes, 2-63 characters (e.g. login-redirect)'),
    problem: z.string().min(1).describe('What breaks or is missing, in the owner\'s words, with the evidence you found (files, lines)'),
    owner: z.string().min(1).describe('The team or person this work is for'),
    stakeholder: z.string().min(1).describe('The person whose typed yes approves this contract (the owner at this terminal unless they named someone)'),
    metric: z.object({ name: z.string().min(1), window: z.string().min(1).describe('When it is read, e.g. "per test run" or "7 days after release"') }).strict(),
    scenarios: z.array(Scenario).min(1).describe('One per behaviour the change must have: WHEN <condition> THEN <observable result>'),
    notIncluded: z.array(z.string().min(1)).min(1).describe('What this change deliberately does not do'),
    commit: z.string().min(1).describe('The Conventional Commits header the harness will commit with: type(scope): subject naming what changes, at most 100 characters, no full stop'),
    ticket: z.string().min(1).optional().describe('A ticket id or URL, when the owner gave one'),
    base: z.string().min(1).optional().describe('The branch the PR will target; omit it and the harness uses the repository\'s default branch'),
    measureScript: z
      .string()
      .min(1)
      .optional()
      .describe('Optional: the content of a small read-only Node .mjs script the harness runs at a commit of this repository (cwd = repository root, no network, no writes) that prints one line {"metric":"<name>","value":<number>}. Omit it when no script can measure the metric (the contract then says Measure: none).'),
  })
  .strict();

export type ProposeContractInputT = z.infer<typeof ProposeContractInput>;

export default defineTool({
  name: 'propose_contract',
  description:
    'Before your first edit: propose the work item\'s contract (problem, scenarios, not included, metric, commit header) to the owner. The harness writes and shows it; only the owner\'s typed reply approves it. End your turn right after calling it and wait.',
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
