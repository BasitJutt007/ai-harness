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
  not protected and differs from Base, and the tree holds only the agent's changes. It commits them plus the item's records
  (`docs/contracts/<slug>.md`, `.harness/items/<slug>/ledger.jsonl`, `.harness/items/<slug>/session.json`
  summary) on the current branch with the contract's Commit header and the ship-text body, pushes
  that branch (never force), and opens the PR against the contract's Base with the filled PR
  template.
- `harness item close <slug>` run inside the repository uses that repository's state directory,
  reads the metric at the merge commit and writes before/after next to each other.

## Any web repo

- Chat and reading work in every git repository.
- Session write policy (session only; file mode keeps the 01 policy): web source and text kinds are
  writable (`.ts .tsx .js .jsx .mjs .cjs .vue .svelte .astro .css .scss .sass .less .html .md .mdx
  .json .svg .yml/.yaml`) anywhere in the git-visible tree, while the supply-chain deny list stays
  absolute: `package.json`, lockfiles, `*.config.*`, `tsconfig*`, dot-files and dot-directories,
  `.env*`, CI and git hooks, `prisma/` and migrations, `node_modules`, build output.
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

## Build status

Step 1 (engine) is in place; nothing below changes file mode (every option is opt-in, and the
suite that covers file mode passes unchanged).

| Piece | Where |
|---|---|
| Conversation across calls: `history`, `message`, `yieldOnText` (status `yielded`), `keepChat`, `onText` | `src/core/loop.ts` (`RunAgentOptions`), `src/core/context.ts` (`JitViewOptions.keepChat`, `digestTurn`) |
| Streaming: optional `Driver.stream` (same retry, rate-limit and overflow handling as `complete`) | `src/core/types.ts`, `plugins/drivers/{claude,openai,scripted}.ts` |
| Live events: `buildContext({ onEvent })`; in-place flag `RunContext.inPlace` | `src/core/run.ts`, `src/core/types.ts` |
| State directory and one session per checkout | `src/core/state-home.ts` |
| Measure script under the items root (then the harness's `metrics/`) | `src/core/measure.ts` (`measureScriptPath`) |
| Protected-branch defaults (a config adds, never removes) | `src/core/config.ts` |
| Git-visible workspace: `createWorkspace(..., { visibility: 'git' })`, `hidden()` | `src/core/workspace.ts`, the read tools in `plugins/tools/` |
| In-place writability and the `branch-guard` hook (required for in-place runs) | `src/core/inplace.ts`, `plugins/hooks/branch-guard.ts`, `src/core/hooks.ts` |
| Explicit confined root, `.git` and `.env*` unreadable inside it | `src/core/sandbox.ts` (`setConfinedRoot`), `src/core/ts-fence.ts` |

Gate hardening and review fixes (after step 1; file mode keeps working, each refusal has its twin):

| Piece | Where |
|---|---|
| A listed symlink is judged by its target (outside the root, `.env*`, `.git`, git-ignored: dropped) | `src/core/workspace.ts` (`list` with visibility 'git') |
| In place is read from the context (an in-place record or a git-visibility workspace), never a flag; buildContext and branch-guard refuse a git-visibility run without its record | `src/core/hooks.ts` (`writesInPlace`), `src/core/run.ts`, `plugins/hooks/branch-guard.ts` |
| The harness's `metrics/` is a fallback for the file-mode CLI only | `src/core/measure.ts` (`harnessMetrics`), `src/core/item-cli.ts` |
| Overflow shrink cuts folded chat prose to its first line; a failed call's turn number is never reused; the owner's message is recorded before it joins the history | `src/core/context.ts`, `src/core/loop.ts` |
| One stale-lock taker at a time (`<lock>.takeover`) | `src/core/state-home.ts` |
| A reply records the contract hash it was typed against and the operator's provenance (agent-shell markers, names only); `Measure: none` | `src/core/items.ts`, `src/core/provenance.ts` |
| A file-mode run binds only an open item whose Repo is the clone's origin and whose Base is its branch | `bindItem` and `executeRun` in `src/core/run.ts`, `targetRepoProblem` in `src/core/item-cli.ts` |
| Close: bot mergers from gh's `is_bot`/login, before reading taken before the merge, shipped after a DONE run of the approved text, unconfined readings UNPROVEN, no Measure never closes | `src/core/close.ts`, `src/core/measure.ts` (`readingUnproven`) |
| `harness gate <problem-statement\|human-yes\|outcome> <slug>`; gate files run alone point to it | `src/core/item-cli.ts` (`cmdGate`), `src/core/main-module.ts` |

For a session: `/ship` must append the item's `run` ledger entry (DONE, the approved contract hash)
before its `shipped` entry, or `harness item close` refuses the item; a session contract may say
`Measure: none` (proposed with before = null; such an item ships but never closes).

Step 4 (any web repo) is in place for in-place runs (`RunContext.inPlace`); file mode keeps the 01
policy, and every widening has its file-mode twin in the tests.

| Piece | Where |
|---|---|
| In-place write policy: web source and text kinds anywhere in the git-visible tree, the supply-chain deny list absolute, git-ignored paths refused (`writePolicyFor`, `inPlaceWritePolicy`, `gitHidden`) | `plugins/lib/path-policy.ts`, `plugins/hooks/path-guard.ts`, `plugins/gates/scope.ts`, `plugins/gates/standards.ts` |
| Package imports checked in JavaScript and in `.vue`/`.svelte`/`.astro` script blocks (`scriptSource`) | `plugins/lib/dependencies.ts`, `plugins/hooks/dependency-policy.ts` |
| Web layout (`TargetLayout.codeKinds: 'web'`): JavaScript and components are code, `*.test.js(x)` are tests, test dirs learned from JS tests; `inPlaceProfile`, `targetProfile(ws, { inPlace })` | `src/core/target.ts`, `src/core/testmap.ts`, `src/core/testing.ts`, `src/core/run.ts` (`buildContext`) |
| Proof tiers: logic needs a red where a supported runner can run a test for it (`RunContext.runner`, `TestRunnerInfo.components`); everything else is allowed and the observed-red gate reports `UNPROVEN: no test proves <files>; verify by hand` | `plugins/lib/proof.ts`, `plugins/hooks/observed-red.ts`, `plugins/gates/observed-red.ts` |
| Run-start snapshot keeps every governable kind (`.tsx`, `.js(x)`, `.vue`, `.svelte`) | `src/core/initial.ts` |
| Generic web profile (`stack: 'web'`, in place only): `web-typecheck` (tsc or vue-tsc, confined, n/a without TypeScript), `repo-lint`, no API lock (named in the profile) | `src/core/target.ts`, `src/core/gates.ts`, `plugins/checks/web-typecheck.ts`, `plugins/checks/repo-lint.ts` |
| Unsupported runners named with the reason: bun, react-scripts/craco, ng, nx, vue-cli-service, ember | `src/core/target.ts` (`WRAPPED_RUNNERS`) |
| jest: tsconfig paths/baseUrl the config does not map passed as `--moduleNameMapper` | `src/core/target.ts` (`jestPathMapper`), `src/core/testing.ts` |
| Vite apps under node:test: `import.meta.env` defined for modules under the API root | `src/core/import-meta-env.mjs`, `src/core/import-meta-env-hooks.mjs` |
| Re-detection keeps tsx for React + Vite trees with node:test files; the brownfield test baseline uses the profile's runner | `src/core/target.ts`, `src/core/test-baseline.ts`, `src/core/run.ts` |
| vite-build gets the repository's browserslist config as `BROWSERSLIST` (`SandboxPolicy.env`) | `plugins/checks/vite-build.ts`, `src/core/types.ts` |
| orphans traces imports through JavaScript and component scripts in a web layout | `plugins/gates/orphans.ts` |

Still open for step 4: the session must compute its profile with `targetProfile(ws, { inPlace: true })`
(buildContext applies the web layout either way, but the generic `web` stack and JavaScript test dirs come
from that call); a `build` script other than Vite is not run; a `format_file` tool needs a core service for
a governed write (a tool's `preview()` has no context to run the repository's prettier).

Known limits: on Linux (bwrap) the `.git`/`.env*` masks are the entries found by a bounded walk at
each call (every `.git` at any depth, node_modules not walked), checked on the generated argv only (no
bwrap on the development machine); on macOS the Seatbelt regexes are verified against the real
`sandbox-exec`. The session lock treats any live pid as the holder (a reused pid keeps a stale lock
until its file is removed by hand), and a takeover file left by a crash mid-takeover is reported with
the path to remove.

Step 3 (the session) is in place: bare `harness` / `harness chat` runs it; file mode is unchanged
(`propose_contract` is never offered there, and the loop options are opt-in).

| Piece | Where |
|---|---|
| Entry, options, the terminal (readline: channel from stdin itself; lines typed while the agent works are dropped, never queued) | `src/session/main.ts`, `src/session/input.ts`, `src/core/cli.ts` (`isSessionCommand`) |
| Provider keys from `SF_HARNESS_ENV_FILE`, else `~/.sf-harness/env.development`, else `~/.sf-harness/.env` (names the drivers read and `HARNESS_*` only; never overriding; names reported by `doctor`) | `src/core/env-file.ts`, `bin/harness.mjs`, `loadUserEnv` in `src/core/cli.ts` |
| Default model: first allowlisted model whose driver serves it and starts; `/model` keeps one cap | `src/session/models.ts`, `DriverPlugin.serves` |
| Session setup: state dir, lock, git-visibility workspace, confined root, writability, synthetic brownfield task (baseline standards), initial hashes; test baseline measured once, at approval | `src/session/session.ts` |
| Loop: `skipShadowBaseline` (no per-message front-load), `yieldAfterTurn` (stop at a proposal) | `src/core/loop.ts` |
| Contract in chat: `propose_contract` (session-only, effect control) → the harness writes, validates, reads the before value, proposes; `/import` | `plugins/tools/propose_contract.ts`, `src/session/contract.ts`, `RunContext.session` |
| The reply: only the next line typed after the PROPOSAL box reaches `recordReply`, on the input's channel | `Session.reply` in `src/session/session.ts` |
| Verdict: required finish gates fresh + checks + honesty; DONE also needs an approved item and a change | `src/session/verdict.ts` |
| `/ship`: agent's files + item records on the current branch, push (no force), PR against Base | `src/session/ship.ts` (reuses `shipText`, `scanDiffForSecrets`, `NO_HOOKS`, `ghStatus` from `src/core/ship.ts`) |
| `harness item <cmd> <slug>` inside the repository uses its state-dir items root | `repoItemRoot` in `src/core/item-cli.ts` |
| UI: banner, status line, tool/hook/gate lines, proposal box, verdict block, spinner, NO_COLOR | `src/session/ui.ts`, `src/session/prompt.ts` (system prompt) |
| Scripted end-to-end demo (real hooks and gates; DONE in a small React + Vite repo) | `fixtures/scripted/session-demo*`, `test/session/demo.test.ts` |

Known limits of step 3: a contract with `Measure: none` and a `local:<name>` Repo are accepted by a
minimal change in `items.ts` (the hardening branch makes them explicit and has close name the
refusal; close already refuses such an item because it has no before reading). Ctrl-C does not cancel
a fresh gate run, the test-baseline measurement or `/ship` (they finish first). `/clear` restarts turn
numbering in the transcript (a `cleared` marker separates the two conversations). A session item's
before value is read at `origin/<Base>` when it exists locally, else `<Base>`, else the session's start
commit (no fetch). The session write policy for any web repo and the proof tiers (build step 4) are not
part of this step: the existing scope and observed-red rules apply.

Session safety and UX (phase 3; each refusal has its paired twin in `test/session/`; where this table
and the limits above differ, the table is current):

| Piece | Where |
|---|---|
| Nothing the model wrote runs before the yes: propose_contract writes the contract and the Measure script (shown in full in the PROPOSAL box) and reads nothing; the before value is read after the typed yes and recorded as the ledger's `metric` entry (phase before) | `src/session/contract.ts` (`proposeDrafted`, `readBefore`), `Session.reply` in `src/session/session.ts`, `src/session/ui.ts` (`proposal`) |
| A Measure's output reaches neither the model nor a record: failures say how (`exited N`, `printed no number`), a reading keeps the number and its metadata (`excerpt` empty) | `src/core/measure.ts` (`readMetric`, `MeasureFailure`), `readingFailureForModel` in `src/session/contract.ts`, `test/audit/measure-output.audit.ts` |
| The measure checkout has no `.env*` entry (nor a link to one); a reading is refused if one remains | `envEntries` in `src/core/measure.ts` |
| Base resolves only through `refs/remotes/origin/<base>` or `refs/heads/<base>` and must pass `git check-ref-format --branch` (no stash, revision or option) | `baseRef` in `src/session/contract.ts` |
| A model-written Measure is refused where the sandbox is off or unavailable | `measureConfinement` in `src/session/session.ts` |
| Stakeholder (and an empty Owner) from `git config user.name`, else the OS user; a Stakeholder the model sends is ignored and the tool result says so | `personName` in `src/session/contract.ts`, `plugins/tools/propose_contract.ts` |
| A refused (re-)proposal writes nothing: every check runs first, the files go through temp files and are put back if the ledger refuses the entry | `replaceFiles` and `propose` in `src/session/contract.ts` |
| No control character reaches the terminal (stream, tool, hook and gate lines, proposal box, diffs); a contract or a propose_contract field with one is refused; the model's prose has its own gutter (`┆`) so column 0 is the harness's | `src/session/sanitize.ts`, `src/session/ui.ts`, `controlChars` in `src/core/items.ts` (`parseContract`) |
| A verdict after every turn that changes the tree (the same code as finish); leaving with unjudged files says UNPROVEN and names them | `Session.turn`, `Session.end` in `src/session/session.ts`, `src/session/verdict.ts` (`VerdictTrigger`) |
| `/ship` ships only what a DONE verdict judged, byte for byte (git blob ids, checked before the ship gates and on the index), records the session's DONE `run` right before `shipped`, and keeps absolute local paths out of session.json, the commit and the PR | `src/session/ship.ts` (`treeFingerprint`, `scrubPaths`) |
| Ctrl-C never ends a running session: every awaited command, the baseline and the before reading say what finishes first; exit only at startup; Ctrl-C on a half-typed line only clears it | `src/session/input.ts` (`terminalInput`), `Session.guarded` |
| Pasted lines are one message (bracketed paste, else a burst window); lines typed while busy are dropped with one notice; a reply read clears the type-ahead | `src/session/input.ts` |
| A second contract cannot take over the bound item's unshipped work (the same slug can be re-proposed) | `Session.takeOverProblem` |
| Refusals the model cannot fix (sandbox off, commitlint missing, a read-only checkout, the branch moved) end its turn and are reported to the owner | `Session.stopTurn`, `ENVIRONMENT_HOOKS` in `src/session/session.ts` |
| A session starts only with path-guard (it keeps writes off ignored and `.env*` files); the profile is computed in place (`targetProfile(ws, { inPlace: true })`); checkOptions reach the rule list; the read-only prompt offers no proposal | `runSession` in `src/session/session.ts`, `src/session/prompt.ts` |
| State directories are 0700; run.json's `baseBranch` is the contract's Base (null before one); run-start content is copied lazily before a file's first write, and copies older than the last 5 sessions are pruned | `repoStateDir` in `src/core/state-home.ts`, `initialCopyHook` and `pruneSessionCopies` in `src/session/session.ts` |
