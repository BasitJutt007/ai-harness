# Workflow — Abdul Basit

Full-stack engineer on the web product: `api-backend` (NestJS + Prisma + Jest, Supabase
Postgres), `web-app` (vendor app, React + Vite) and `admin-app` (admin app,
React + Vite). Evidence comes from the three repositories' git history and PRs (503, 444 and 244
PRs of mine), their review threads, CLAUDE.md, `.cursor/` rules, commitlint and CI, and my own typed
turns in 278 Claude Code sessions on these repositories and on this harness. Counts are from that
evidence. Every habit below has a mechanism in the last section, and every mechanism points back
to a habit.

## How work reaches me

- **People, not tickets.** Of 56 backend work conversations, 10 start with a task whose source I
  never named, 7 with a design (Figma image, HTML prototype), 6 with a pasted Jira ticket (relayed in
  Teams, often in Roman Urdu), 6 with a decision relayed from a meeting with the lead, and 5 with a QA
  or bug report. Jira keys (`MYSF-####`) appear in 12 of 503 backend branch names, and in none of
  my last 198 Admin PRs. The PR template's "Ticket #" line was left untouched on 495 of 503.
- **Feedback batches.** Since October work arrives as dated feedback rounds (`16 oct feedback`,
  `badges-feedback-29-oct`), and each round becomes one branch bundling several unrelated fixes.
- **Mid-flight changes.** In 10 conversations over 16 days I relayed a new decision while the code
  was half built (27 turns); 6 built changes were reverted after such a decision.
- **What I act on first:** a production or beta issue, then review comments on an open PR (69 pastes
  in 19 backend conversations), then the current feature.
- **Always three repos.** 20 of 58 backend conversations open by asserting access to the admin and
  vendor repos, and 36 of 54 touch a frontend. Until August I couriered notes between three per-repo
  agents by hand (12 relays, "round 5").

## Where I lose time

1. **Waiting for a go-ahead I give myself.** "Don't implement yet, tell me what you understood, then I
   will give go-ahead" is my most repeated instruction: about 40 turns in 18 backend conversations,
   14 more on React. The agent starts coding anyway, and I spend turns undoing it.
2. **Review round-trips on large PRs.** Since July 2026 reviewers request changes on 26% of my React
   PRs (1% before). The backend PRs that drew blockers have a median of 487 changed lines, the rest 67.
3. **Promoting by hand.** 40% of my backend PRs and 34% of my Admin PRs go straight to `staging` or
   `main` from reused `cherry-pick` branches. One change is often three PRs, and a fix ships again per
   environment.
4. **Fix-and-recheck loops.** 20 to 26% of my commits are followed within 72 h by my own fix commit on
   the same file. There were about 18 "still not working" follow-ups.
5. **Re-establishing context.** 182 backend session files are 58 conversations: long chats get resumed
   and compacted, and then I re-brief the agent and search for "which chat had this".
6. **A shared dev database that drifts.** Each branch syncs its own schema with `prisma db push`, and
   the repository has no migrations (deleted 2026-07-02). This caused 5 incidents (columns dropped by
   another branch's push).

## What I repeat

| Instruction (sessions) | Now done by |
|---|---|
| "Understand first, don't implement; I'll give the go-ahead" (18 backend conversations) | contract + typed yes before any edit |
| "You have all three repos: check admin and vendor side" (20) | route-lock names what a backend change removes |
| "Only `prisma generate`; never `db push` or migrations; I do the db push myself" (10) | no harness clone has DB credentials; `prisma/` is unwritable |
| "Explain plainly: what is done, what is blocked, what needs me; no yapping" (18) | the run verdict: gates, UNPROVEN, human-must-verify |
| "No co-author line, no AI attribution" (9 corrections, 2 still merged) | ship commits as the harness, with no trailers |
| "Commit with a real title and description, not one-for-all" (3 dates) | the contract's Commit line, checked at propose and ship; the PR template filled from the contract |
| "Branch from the latest development; never push to development/staging/main" (7 corrections) | protected branches; ship pushes only `harness/<run>` |
| "Use only the cheapest model" (8 turns, 3 dates) | model allowlist and a per-run spend cap |

## What breaks

The mistakes I have made more than once. Each one has a check or a rule in the last section.

1. **Routes without the access check they need.** Review caught new admin or vendor-facing routes
   with no admin or tenant gating on 6 backend PRs (#662, #890, #992, #1128, #1141, #1159). The global
   admin guard lets any signed-in user through unless the route declares `@AdminOnly()`.
2. **Backend changes the frontends don't match.** A removed route answered 404 to the frontends
   (#1016), an error shape changed (#769), and on React 5 PRs had billing payload drift. 6 Admin fix
   commits only realign field names or endpoints with the backend.
3. **Nothing proves a change before review.**
   - None of the three repositories has a single test file. 12 specs were deleted in August, and the
     PR template's "added tests" box was ticked on 0 of 1,191 of my PRs.
   - CI runs only a build on the backend and nothing on the frontends.
   - web-app's build runs `tsc --noEmit` on a solution-style tsconfig, which checks zero
     files. Its app project has 33 type errors, including an undefined `user`.
   - Both frontends' ESLint configs match only `.js`/`.jsx`, so "0 lint errors" covers no TypeScript.
4. **Unbounded queries.** `findMany` with no `take`, in-memory filters over growing tables, and a full
   scan per request, flagged on 5 backend PRs (#933, #1037, #1049, #1083, #1124).
5. **Commits and PRs that say nothing.**
   - My first backend commit commented out every husky hook; commitlint has not run since.
   - I have 22 content-free subjects (`patch`, `fix: comment fixes`) and 58 numbered checkpoints.
   - 95.8% of my backend PR bodies are empty or the untouched template.
6. **Supply-chain payloads in tooling files.** An obfuscated loader arrived through `eslint.config.mjs`
   (cleaned in #832). On 2026-10-20 about 20 branches were rewritten to add `.vscode/*`, `init`,
   font files and an ESLint change.
7. **Schema changes without what deployment needs.** Missing migrations, missing backfills and
   template rows that don't exist (5 backend PRs). A db push from one branch drops another
   branch's columns.
8. **Claims without proof, from me and from the agent.** On this harness I corrected false
   PASS/DONE claims 4 times. In the product repos, a "fixed" report was not actually fixed 7 times
   (Admin) and 7 times (React).
9. **Cost blow-ups.** An expensive model was used after I had asked for cheap ones 3 times. My
   billing showed about $2.10 on gpt-5.4 against $0.04 on Luna.
10. **Caches that go stale or repeat after a change.** RTK Query tags do not cross API slices, and
    merges append a refetched page. Reviewers flagged stale lists or wrong tags on 7 of my Admin PRs
    (13 comments). Pagination and merge bugs were flagged on 6 of my React PRs. Two of the three
    items are this class.

## Backlog items

Items from my own backlog run on private copies of the work repositories: their contracts, ledgers,
metric scripts and runs stay outside this repository, and none of them is pushed. One was found by
using the vendor app on a local stack: the login email step sent an untrimmed address, let a
malformed one through, left Continue loading after an error, and showed the live input instead of the
address the code went to. The harness read its metric (cases mishandled, of 4) at the base commit
when it proposed the contract, and I typed the yes. Its runs are what produced the item-metric gate,
the read-loop guard and measured files (see the learnings note).

The public items run the same lifecycle on `harness-demo` at `rubric-01` (the README lists them):
the two 01 tasks (`users-api`, `projects-change`) and two new changes (`health-route`, `labels`).

I am the stakeholder for all of them. The team lead is on vacation, so the yes is mine, typed at a
terminal after the harness proposed each contract (`items/<slug>/ledger.jsonl`).

## Gate by gate

`habit or failure → mechanism → file in this repo`

| Habit or failure | Mechanism | File |
|---|---|---|
| Problem statement before any edit ("understand first, I'll give the go-ahead") | hook | `plugins/hooks/problem-gate.ts` |
| My yes, typed by me, after the proposal; the Stop holds without it | hook + gate | `plugins/hooks/contract-gate.ts`, `plugins/gates/stakeholder-yes.ts` |
| Metric read after the merge, next to its before value, before an item closes | check | `src/core/close.ts` (`harness item close`) |
| "Done" when the problem is not (a helper written and tested, never called from the screen) | gate | `plugins/gates/item-metric.ts`: the item's metric read on the run's tree must have moved |
| A screen no unit test can load still has to be proven | task field + gate | `measured` in the task (`docs/task-format.md`); `item-metric` reverts each such file alone and re-reads the metric |
| An agent re-reading a long file instead of editing it | hook | `plugins/hooks/read-loop-guard.ts` |
| Mid-flight changes (a decision relayed while the code is half built) | hook | `plugins/hooks/problem-gate.ts`: a contract changed mid-run stops every edit until it is proposed again and approved |
| Re-briefing the agent every session | context | `src/core/prompt.ts` (`taskBrief`): the approved contract opens every run's brief; `items/<slug>/ledger.jsonl` is the item's record |
| Work that arrives without a ticket | check at ship | `src/core/ship-text.ts`: the contract's optional Ticket fills the template's ticket line; without one the PR says the approved contract is the ticket |
| Review round-trips on large PRs (blocked PRs: median 487 changed lines, the rest 67) | gate | `plugins/gates/diff-budget.ts`: a brownfield change over 400 changed lines (or the task's `limits.maxDiffLines`) is refused |
| 1. Routes without the access check they need | check | `plugins/checks/nest-route-guard.ts` |
| 2. Backend changes the frontends don't match (removed or moved routes) | gate | `plugins/gates/route-lock.ts` |
| 3. No test proves a change | hook + gate (01) | `plugins/hooks/observed-red.ts`, `plugins/gates/observed-red.ts`, `plugins/gates/tests-green.ts` |
| 3. A type check that checks zero files | check | `plugins/checks/repo-typecheck.ts` |
| 3. Lint that lints no TypeScript | check | `plugins/checks/repo-lint.ts` |
| 3. A build broken only at deploy | check | `plugins/checks/vite-build.ts` |
| 4. Unbounded queries | check | `plugins/checks/prisma-unbounded.ts` |
| 5. Commits and PRs that say nothing | check (contract field, then propose and ship) | `src/core/ship-text.ts`, `src/core/ship.ts`, `src/core/items.ts` (Commit) |
| 6. Supply-chain payloads in tooling files | rule (01) | `plugins/lib/path-policy.ts` (`BUILTIN_DENY`): config, lockfiles, dot-directories, non-TS files are unwritable |
| 7. Schema changes, db push drift | rule | `plugins/lib/path-policy.ts` (`prisma/` is not TypeScript: unwritable); clones carry no DB credentials |
| 8. Claims without proof | gate (01) | `src/core/gates.ts`: DONE only when every required gate passes; UNPROVEN is never green |
| 9. Cost blow-ups | check before the first turn + loop limit | `src/core/spend.ts`, `harness.config.json` (`models`) |
| 10. Caches that go stale or repeat after a change | rule + regression specs | `src/core/prompt.ts` (react-vite rule: tags never cross slices; a refetched page replaces, never appends); each item's spec stays in the repository |
| Branch discipline | rule (01) | `harness.config.json` `protectedBranches`, `src/core/ship.ts` |
