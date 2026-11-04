# Learnings: assignment 02

State on 5 November: three backlog items and the two 01 tasks have contracts that the harness proposed,
with before values it read itself (10, 1, 50; and 5, 1 for the 01 tasks). None is approved yet, so none
has run. This note will gain what the runs show; until then it says only what already happened.

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
  `.ts` modules, which narrowed which React and Admin items I could pick.
- I nearly pushed company details (contract text, a live security gap) to a public repository. The push
  was blocked, and the repository is private now.

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
