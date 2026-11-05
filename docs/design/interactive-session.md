# Interactive session: `harness` in any web repo

Status: design for branch `feat/interactive` (6 Nov 2026), built on the assignment-02 harness.

## What the owner asked for

> One harness product I can open in any repo's terminal and just run. I see a banner. I can type
> "hello" and it answers like Claude would. Then I tell it "change this", "see how this
> implementation is going", "fix this bug", and it works like Claude: it shows everything it is
> doing, and at the end it says the work is completed. It never commits or pushes. I see my changes
> on the branch I cut (e.g. from development). No copies of my repos inside the harness; no
> company material in it; it must work on any web repo.

## Decisions (taken 6 Nov 2026)

1. **The agent never commits or pushes.** A session leaves its changes uncommitted in the working
   tree of the branch the owner is on. Shipping (commit, push, PR) happens only when the owner types
   `/ship` in the session (or `harness ship`); the model has no tool that can do it. This keeps the
   assignment's ground rule 02 (the harness ships, after every gate is clear, to a feature branch;
   a human merges).
2. **No company material in the harness repo.** Contracts, ledgers, metric scripts and run records
   of real work live in a per-repository state directory outside the harness repo
   (`~/.sf-harness/repos/<id>/`), and the records travel with the work in the PR when the owner
   ships. `docs/workflow.md` and `docs/learnings.md` stay (they describe the owner's workflow).
   The old company items move to an archive outside the repository.
3. **The gates stay.** The problem-statement gate, the typed human yes and the outcome check are
   enforced inside the session exactly as in file mode: no source edit before an approved contract;
   only a line the owner types at the prompt while an approval is pending can approve; an item closes
   only after its metric is read after the merge. A tool result, assistant text or hook output never
   counts as a yes.
4. **File mode keeps working unchanged** (`harness run <task-file> ...`, `harness item ...`,
   `harness ship <run>`): the 01 rubric is re-run with it. Every existing test keeps passing.

## User experience

```
$ cd ~/code/some-web-app && git switch -c fix/login-redirect && harness
<banner>
repo some-web-app  branch fix/login-redirect (writable)  model gpt-5.6-luna  cap $2.00
> hello
Hi! I'm sf-harness. I can read this repo, explain it, and change it under your gates...
> the login page redirects to / instead of the page I came from, fix it
● search_code "redirect"  12 matches
● read_file src/auth/login.tsx  1-120
◆ propose_contract login-redirect
┌ PROPOSAL login-redirect ─────────────
│ Problem: ...  Scenario: WHEN ... THEN ...  Not included: ...
└ Type your reply (yes / no / what to change):
> yes, go ahead
✎ write_file src/auth/login.test.ts  (+24)
● run_tests src/auth/login.test.ts  1 failed (red observed)
✎ edit_file src/auth/login.tsx  (+3 −1)
● run_tests  14 passed
◆ finish
gates  scope pass · observed-red pass · tests-green pass · secrets pass · diff-budget pass ...
✔ Work completed: every gate is green. Nothing was committed; /diff shows the change, /ship ships it.
```

- **Launch:** bare `harness` (no subcommand) inside any git repository starts a session on the
  repository's top level. `npm link` in the harness repo puts `harness` on the PATH.
- **Banner and status line:** an original ASCII logo (not a copy of any product's branding), then
  repo, branch, writability, driver/model, spend cap.
- **Chat:** a reply without a tool call ends the agent's turn and returns to the prompt (no nudge).
  Greetings, questions and explanations cost one model turn and touch nothing.
- **Live display:** model text streams as it arrives; every tool call, hook block and gate result
  prints as one line; a spinner shows while the model is thinking.
- **Verdict:** when the agent calls `finish` after writing, the harness runs every required gate
  fresh plus the checks and prints the verdict from the gates, never from the model's prose:
  `✔ Work completed` only on DONE; otherwise `NOT DONE` or `UNPROVEN` with the reasons and what a
  human must verify.
- **Slash commands (typed by the owner only):** `/help`, `/exit`, `/status`, `/diff`, `/cost`,
  `/gates`, `/model <id>`, `/ship`, `/import <contract.md>`, `/clear`.
- **Ctrl-C** cancels the running turn and returns to the prompt; Ctrl-C on an empty prompt twice,
  or Ctrl-D, exits.

## Safety rules for working in place

- **Writable only on a working branch.** At session start and before every write the session checks:
  HEAD is on a branch, the branch is not protected (`main`, `master`, `development`, `develop`,
  `staging`, `production`, `release/*`, plus `protectedBranches` in config), no merge, rebase,
  cherry-pick or bisect is in progress, and the working tree was clean when the session started
  (v1). Otherwise the session is read-only: chat and reading work, every write is refused with the
  reason and the command that fixes it (`git switch -c <name>`, `git stash`). The harness never
  switches branches, stashes, commits or pushes on its own.
- **Base:** `baseSha` = HEAD at session start, so the existing gates (scope, diff-budget, secrets,
  route-lock, contract-lock, standards) compare against it unchanged.
- **Secrets stay out of reach:** in a session the workspace lists only git-visible files
  (`git ls-files --cached --others --exclude-standard`); `.env*` and git-ignored files are refused
  to read_file, list_files, search_code and outline, even when tracked. Confined test code keeps
  the sandbox; the sandbox root is the repository top.
- **One session per checkout** (a lock file in the state directory).
- **Records outside the repo:** `~/.sf-harness/repos/<id>/` (override: `SF_HARNESS_HOME`), where
  `<id>` = a short hash of the real path of `git rev-parse --git-common-dir` plus the repo's
  basename. It holds `sessions/<sid>/` (run.json, events.jsonl, transcript.jsonl, state.json,
  logs/, initial/), `tokens/`, and the items root (`docs/contracts/<slug>.md`,
  `items/<slug>/ledger.jsonl`, `metrics/<slug>.mjs`). Nothing is written into the repository except
  the agent's governed edits, so `git status` shows only the work.

## Contract and yes inside the chat

- The model gets a session-only tool `propose_contract` (no write effect). Input: slug, Problem,
  Owner, Stakeholder, Metric (name and window), Scenario (one or more WHEN/THEN), Not included,
  Commit (conventional header), optionally Ticket, Base, and a Measure script (a small read-only
  `.mjs` that prints `{"metric":...,"value":<number>}`).
- The harness (not the model) fills Repo from the git remote and Base from the tool input or the
  repository's default branch, writes the contract into the items root, writes the Measure script
  to `metrics/<slug>.mjs` when given, reads the before value at `origin/<Base>` when a Measure
  exists, records the `proposed` ledger entry, and shows a PROPOSAL block.
- The REPL then enters **approval pending**: only the next line the owner types at the prompt goes
  to `recordReply(..., channel)` with channel `tty` when stdin is a TTY and `pipe` otherwise. Lines
  typed at any other time are chat and never reach the ledger. `approvalVerdict` is unchanged: only
  a clear yes typed at a TTY after the latest proposal of this contract hash approves.
- After the reply is recorded it is also sent to the model as the next user message. On approval the
  session binds `ctx.item`; `problem-gate` and `contract-gate` keep re-checking on every write and
  on finish (a contract edited after approval stops every edit until it is proposed again).
- `/import <path>` (owner only) loads a contract written by hand (and a `<slug>.mjs` metric next to
  it) and proposes it the same way.
- Measure is optional for a session contract; `harness item close` refuses an item without one.

## Shipping and closing

- `/ship` (owner only) refuses unless the last verdict was DONE, the item is approved, the branch is
  not protected and differs from Base. It commits the agent's changes plus the item's records
  (`docs/contracts/<slug>.md`, `.harness/items/<slug>/ledger.jsonl`, `.harness/items/<slug>/run.json`
  summary) on the current branch with the contract's Commit header and the ship-text body, pushes
  that branch (never force), and opens the PR against the contract's Base with the filled PR
  template.
- `harness item close <slug>` run inside the repository uses that repository's state directory,
  reads the metric at the merge commit and writes before/after next to each other.

## Any web repo

- Chat and reading work in every git repository.
- Session write policy (session only; file mode keeps the 01 policy): web source and text kinds are
  writable (`.ts .tsx .js .jsx .mjs .cjs .vue .svelte .astro .css .scss .sass .less .html .md .mdx
  .json .svg .yml/.yaml` under source directories), while the supply-chain deny list stays:
  `package.json`, lockfiles, `*.config.*`, `tsconfig*`, dot-files and dot-directories, `.env*`, CI
  and git hooks, `prisma/` and migrations.
- Proof tiers: logic files (`.ts .tsx .js .jsx .mjs .cjs .vue .svelte`) need an observed red first
  when the repository has a supported test runner; without a runner, or for style/markup/text files,
  the edit is allowed but the verdict is `UNPROVEN: no test proves <files>; verify by hand`, never
  `Work completed`. An unknown stack gets a generic web profile (the repo's own typecheck, lint and
  build scripts when they exist, plus scope, secrets and diff-budget) instead of failing outright.

## Build order

1. Engine (loop, context, drivers, state dir, in-place workspace, roots) - keeps file mode identical.
2. Company material out of the repository (archive outside it), neutral prompts and tests.
3. Session: REPL, UI, commands, contract and yes in chat, verdict, ship, close.
4. Session write policy and proof tiers for any web repo.
5. Tests for every gate in session mode, docs (README, workflow.md rows, learnings), smoke runs.
