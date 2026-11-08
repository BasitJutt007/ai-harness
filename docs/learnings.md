# Learnings: assignment 02

State on 8 November. Every item has a contract the harness proposed, a before value it read itself and
a yes I typed at a terminal. Of the public items, `projects-change` ran DONE and shipped as a PR; the
other runs ended NOT DONE, each refused by a named gate (REST conventions, strict types, Zod at the
boundary). A private item on a real React app taught the most, below.

**Stakeholder.** I am the stakeholder for all three items, because the team lead is on vacation. The
gate still holds: each contract was proposed by the harness, and only a reply I type at a terminal after
that proposal approves it. A second person's yes would also check that each item is worth doing; mine
cannot, and nobody else read these contracts before they ran.

## What the harness caught

- **A type check that checks nothing.** web-app's build runs `tsc --noEmit` on a
  solution-style tsconfig and checks zero files. `repo-typecheck` expands the references and finds 33
  errors, among them an undefined `user` that breaks checkout purchases on development. My own
  baseline for this repo was "tsc: 0 errors". It was wrong.
- **Lint that lints nothing.** Both frontends' ESLint configs match only `.js`/`.jsx`, so "0 problems"
  covered no TypeScript. `repo-lint` now reports such files as n/a, with the reason.
- **Admin routes without the admin guard.** `nest-route-guard` found several; they go to the team through its normal process.
- **A commitlint config that accepts "patch".** The vendor app's config switches every rule off. The
  harness probes for this and says so instead of reporting a pass.
- **336 of 450 per-request `findMany` calls in the backend have no bound.** They are pre-existing, so
  they do not block; a new one does.

## What a real item taught (the login email step)

The harness ran one private item end to end on a production React app: a login screen that sent an
untrimmed email, let a malformed one through, left its button loading after an error and showed the
live input instead of the address the code went to. Its metric (cases mishandled, of 4) read 4.

- **Run 1 said DONE and fixed nothing.** The model wrote a correct helper and tests for it and never
  called it from the screen. Every gate looked only at the tests the model wrote, and `item close`
  records the after value without judging it. The `item-metric` gate now reads the item's own metric
  on the run's tree: a run is not DONE while it still reads its before value.
- **Run 2 was refused correctly, and showed a read loop.** The model read the 443-line screen 45 times
  in 60 turns and never edited it: history keeps only the latest turns in full, so the file never
  stayed in view. `read-loop-guard` now notes the third re-read of a file since the last write.
- **Run 3 showed the real block: my own rule.** Observed-red locks a file until a test that imports it
  is seen failing, and a node:test file cannot load that screen. The task was impossible as written. A
  task may now name such files `measured`: their red is the before value the harness read, and
  `item-metric` proves each change by reverting the file alone and reading the metric again.
- **Run 4 moved the metric from 4 to 1** and was still refused: one case left, and two unused variables
  the baseline type check would not let in.
- **Run 5 (90 turns) stalled on one line.** Its last edit failed seven times: the model's find text
  had 17 spaces of indentation where the file has 16, copied from numbered read_file output.
  `edit_file` now accepts one uniform indentation shift when exactly one block matches that way, and
  re-indents the replacement to match; anything ambiguous is still refused.
- Across five runs the model never called finish once: every verdict came from the fresh final gate
  run. Each NOT DONE was right, and each said exactly what was missing.

## What it got wrong (or I did)

- The first ledger hashed only the link to the previous line, so editing the last entry went unnoticed
  until a test tried it. Each entry now carries its own hash.
- The first `prisma-unbounded` design reported calls it could not read as skipped. On the backend that
  makes the rule UNPROVEN at the base and at the head, which would have blocked every backend run. A
  bound the check cannot see is now a violation of that one call.
- `item status` said "awaiting yes" for a contract I had changed after proposing it. A yes would then
  have answered the old text. It now says "unproposed".
- The outcome check would have closed an item merged by a bot account. It now refuses one.
- The sandbox broke Vite (its config loader writes into node_modules) and esbuild (symlinked
  node_modules), and backend specs could not load until a jest path mapping existed. No run may write
  package.json, so that one line has to be landed by a person first.
- Observed-red needs a covering test the harness can run. Under node:test that means plain importable
  `.ts` modules, which narrowed which React items I could pick, until measured files (above).
- I nearly pushed work details (contract text, a live security gap) to a public repository. The push
  was blocked; those items now live outside this repository and their history was rewritten.

## What I removed

- **Trust in the Signed line.** The harness writes it, but the human-yes gate reads only the ledger's
  typed turns.
- **Express rules on other stacks.** The 01 standards rules and Contract Lock no longer run on NestJS
  or React targets, where they could only fail or read n/a. Each stack gets its own checks.
- **Any model the CLI was given.** Only the allowlisted models run, and a driver's own default is
  refused.
- **Gate results in the commit message.** The commit carries the contract (why, scenarios, not
  included). The evidence lives in the PR.

## What I would add next

- **The stakeholder's yes inside an interactive session**, as a typed turn of the session transcript
  with its provenance, instead of a separate `item reply` command.
- **Live NestJS probes:** boot the app and call each route with a vendor and an admin token, instead of
  reading decorators.
- **Habit 2 as a check:** compare the frontends' API calls with the backend's routes and DTOs. Today
  `route-lock` only compares paths and methods.
- **Habit 7, schema changes:** a check that a Prisma schema change ships with its migration or backfill.
  Today `prisma/` is simply unwritable.
- **A ledger signed with a key outside the repository**, so recomputing the hash chain is not enough to
  forge a yes.
- **Spend from the provider's usage reports**, not upper-bound list prices.
