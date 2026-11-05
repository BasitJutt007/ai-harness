# sf-ai-harness

A **harness, not an agent**, for TypeScript REST API work. It drives a model through a provider-neutral
driver, runs every tool call through hooks that can block it, fetches context just in time, and ends
only when deterministic gates (not the model) say the work is done. The harness, never the agent,
opens the pull request.

- **Greenfield:** from a task file it scaffolds an Express 5 + Zod 4 + Vitest API and drives the model
  test-first until every gate is green.
- **Brownfield:** on an existing API it reads the target's own layout and toolchain, gates every source
  edit on a test it has seen fail, and refuses breaking contract changes.
- **Any driver:** `--driver claude` and `--driver openai` run the identical task file, hooks, gates and
  checks.

**Design note:** [docs/design.md](docs/design.md) (architecture, driver abstraction, token budget,
extension points, honesty boundary). Detail: [docs/reference.md](docs/reference.md). Extending:
[docs/extending.md](docs/extending.md). Task files: [docs/task-format.md](docs/task-format.md).

**The core directory is [`src/core/`](src/core)**: the loop, hook bus, gate runner, items, ship and
CLI. Everything else is a plugin that registers by being dropped into `plugins/`.

## Assignment 02: my harness, my workflow

Assignment 02 sits on top of the 01 harness: `git log main..feat/assignment-02` starts at `f24e226`,
after the 01 merge (`85fe886`). It encodes how I work as hooks and checks, adds the briefing's three
gates, and puts items from my own backlog through them. The harness code names no codebase: what a
check needs to know about a repository comes from configuration, and real items live outside this
repository ([below](#where-real-items-live)).

| Deliverable | Where |
|---|---|
| How I work, mapped gate by gate | [docs/workflow.md](docs/workflow.md) |
| Backlog items | one contract per item in [docs/contracts/](docs/contracts), the harness's records in [items/](items) (`ledger.jsonl`: proposal, typed yes, metric readings, runs, ship, close), metric scripts in [metrics/](metrics), runs in [runs/](runs). This repository holds only the two 01 demo items (`users-api`, `projects-change`); see [Where real items live](#where-real-items-live) |
| Learnings note | [docs/learnings.md](docs/learnings.md) |
| Setup | `npm run setup` (below); the repository holds no secrets |

`node bin/harness.mjs item status` prints each item's stage from its ledger.

### Where real items live

Real work items are no longer kept in the harness repository: the harness has to work on any web
repository, and an item's contract, ledger and metric describe the repository it changes. The design
([docs/design/interactive-session.md](docs/design/interactive-session.md)) keeps them in a
per-repository state directory outside the harness; that is not built yet. Until it is,
`HARNESS_ITEMS_ROOT=<dir>` points the item commands and runs at contracts and ledgers in a directory
outside this repository (Measure scripts are still read from this repository's `metrics/`). The three
items the harness proposed on 5 November 2026 (none was approved, so none ran) were moved to an
archive outside the repository on 6 November 2026.

### The three gates

| Gate | What it blocks | Where |
|---|---|---|
| Problem statement | Every edit, until `docs/contracts/<slug>.md` names Problem, Owner, Stakeholder, Repo, Base, Commit, Metric (with before/after), Measure, WHEN/THEN Scenarios and Not included. The refusal names each missing field. A run without one is refused before its first model turn, and so is a run of a closed item, or one whose clone is not the contract's Repo (its origin) on the contract's Base (its current branch) | `plugins/hooks/problem-gate.ts`, `bindItem` in `src/core/run.ts`, `targetRepoProblem` in `src/core/item-cli.ts` |
| Human yes | Every edit, and the Stop (`finish`), until the stakeholder types a plain yes at a terminal after the harness proposed this exact contract text. Each reply records the contract text on disk when it was typed, and counts only for that text. Assistant text, tool output, hook output, a piped reply, a reply to an older proposal or typed against another text, and a hand-written Signed line never count | `plugins/hooks/contract-gate.ts`, `plugins/gates/stakeholder-yes.ts`, `approvalVerdict` in `src/core/items.ts` |
| Outcome | Closing an item, until a person (not a bot: gh's `is_bot`, an `app/...` or `...[bot]` login) merged the PR the harness opened after a DONE run of the approved contract, and the harness read the metric at that merge commit (same script, run twice, confined: a reading from an unconfined Measure is UNPROVEN) and compared it with a before reading taken before the merge. A contract with `Measure: none` can ship but never closes | `src/core/close.ts` (`harness item close`) |

`harness gate <problem-statement|human-yes|outcome> <slug> [--repo <dir>]` prints one gate's verdict
on an item now (`PASS` or `REFUSE` with the reason, exit 0 or 2) and records nothing; the outcome gate
passes only on a closed item, and with `--repo` it checks every close fact as a dry run. A gate's
source file run on its own (`node plugins/hooks/problem-gate.ts`) prints a pointer to that command and
exits 2.

**Trust model: a terminal proves a terminal, not a person.** Only a line typed at an interactive
terminal while a proposal is open can approve. The harness cannot tell who typed it: an AI agent's
shell can drive a terminal too. It does not refuse on that (the operator at a terminal is trusted, and
anything typed there acts with their authority); it records the truth instead. Every reply in
`items/<slug>/ledger.jsonl` carries its channel and the names (never the values) of the agent-shell
environment markers present when it was typed (`agentEnvMarkers` in `harness.config.json`), and item
status, the approval message and the human-yes verdict say "typed at a terminal inside an AI agent's
shell (...)" when there were any. A reviewer reads exactly what was proven.

The item lifecycle, each step a command:

```bash
node bin/harness.mjs item new <slug>                                     # contract template, every field a placeholder
node bin/harness.mjs item propose <slug> --repo <clone>                  # reads the before value, records the proposal
node bin/harness.mjs item reply <slug>                                   # the stakeholder types their reply (terminal only)
node bin/harness.mjs run tasks/<slug>.md --repo <clone> --driver openai --model gpt-5.6-luna --ship
node bin/harness.mjs item close <slug> --repo <clone>                    # after a person merged the PR
node bin/harness.mjs item status                                         # each item's stage
node bin/harness.mjs gate human-yes <slug>                               # one gate's verdict now (read-only)
```

### Try to skip them

Each attempt is refused with the reason. The output below is real, captured against a copy of `items/`:

```text
$ node bin/harness.mjs run tasks/users-api.task.yaml --driver scripted --driver-opt script=fixtures/scripted/users-api.json --item no-contract-here
error: refused before the first model turn (no tokens spent): item "no-contract-here" (no-contract)
           problem-statement  REFUSE  no contract for item "no-contract-here": write docs/contracts/no-contract-here.md (Problem, Owner, Stakeholder, Repo, Base, Commit, Metric, Measure, Scenario, Not included) before any source edit

$ echo yes | node bin/harness.mjs item reply users-api
note: stdin is not a terminal, so this reply is recorded as piped and cannot approve (only a reply typed at a terminal counts)
... recorded, not an approval: no typed yes from Abdul Basit after the proposal (seq 1); not counted: "yes" (seq 3) arrived on a pipe, not typed at a terminal

$ node bin/harness.mjs item close users-api --repo ../harness-demo
outcome  REFUSE  no stakeholder yes: no typed yes from Abdul Basit after the proposal (seq 1); ...
$ node bin/harness.mjs item close users-api --repo ../harness-demo --after 0
unknown option --after: no item command takes a value from the command line (the harness reads the metric and the reply itself)
```

Inside a run, a "yes" in tool output or assistant text is listed as "not counted" when the Stop is
held. The skip attempts are tests ([test/items/skip-attempts.test.ts](test/items/skip-attempts.test.ts),
[test/items/close.test.ts](test/items/close.test.ts)). `npm run audit:mutations` applies 67 mutations
(23 to contracts, 15 to approvals, 29 to runs, merges and readings) to items that pass each gate
([test/audit/item-gates.audit.ts](test/audit/item-gates.audit.ts)), and every one must be refused.

### What the harness enforces from my workflow

Each row of [docs/workflow.md](docs/workflow.md) names its mechanism. The ones added for 02:

- **Stacks I work in:** NestJS + Prisma + Jest and React + Vite are profiled next to Express. Each
  check and gate declares its stacks, and the prompt names the stack and the approved contract.
- **Routes without the access check** (`nest-route-guard`) and **removed or moved routes** (`route-lock`).
  Which decorators mark a route admin-only or public is the repository's own: `harness.config.json`
  `checkOptions["nest-route-guard"]` (`adminDecorators`, `publicDecorators`) names them, and the model
  sees the configured names next to the rule. An admin-facing route the options cannot judge is
  UNPROVEN, never a pass; the rule is n/a only when nothing is configured and no route is admin-facing.
  Options for a check id no plugin defines are a load error (runs refuse, doctor fails).
- **Type checks that check nothing** (`repo-typecheck` expands solution-style tsconfigs), **lint that
  lints no TypeScript** (`repo-lint`, n/a with the reason), and **builds broken only at deploy** (`vite-build`).
- **Unbounded queries** (`prisma-unbounded`: every findMany has a take or selects by id).
- **Large PRs that draw review round-trips** (`diff-budget`: a brownfield change over 400 changed lines,
  or the task's `limits.maxDiffLines`, is refused; the evidence for the budget is in docs/workflow.md).
- **Commits and PRs that say nothing:** the contract's Commit header is checked at propose and at
  ship. The repository's own commitlint runs confined, and a config that accepts "patch" is reported
  as checking nothing. The repository's PR template is filled from the contract, and a box is ticked
  only when a gate proved it.
- **Cost blow-ups:** `harness.config.json` `models` allows `gpt-5.6-luna` and
  `claude-haiku-4-5-20251001` only, with upper-bound prices and a $2 cap per run. Any other model, a
  driver's default included, is refused before the first turn. A request that could pass the cap is
  never sent.

### The 01 rubric under the 02 gates

The 01 task files are items too ([docs/contracts/users-api.md](docs/contracts/users-api.md),
[docs/contracts/projects-change.md](docs/contracts/projects-change.md)), so they run only once the
stakeholder has approved their contracts. They target `harness-demo` at `rubric-01`, the commit
before the 01 PRs merged:

```bash
git clone https://github.com/BasitJutt007/harness-demo.git ../harness-demo
git -C ../harness-demo checkout rubric-01
node bin/harness.mjs run tasks/users-api.task.yaml --repo ../harness-demo --driver openai --model gpt-5.6-luna
node bin/harness.mjs run tasks/users-api.task.yaml --repo ../harness-demo --driver claude --model claude-haiku-4-5-20251001
node bin/harness.mjs agnostic <openaiRunId> <claudeRunId>
```

## Assignment 01 deliverables

| | Deliverable | Where |
|---|---|---|
| 01 | Harness source: core engine, driver adapters, hooks, checks, registry; one-command setup; README | `src/core/` (engine), `plugins/drivers/`, `plugins/hooks/`, `plugins/checks/`, `plugins/gates/`, `plugins/tools/`, registry in `src/core/registry.ts`; [Setup](#setup-one-command) |
| 02 | Two governed APIs | [`governed/users-api`](governed/users-api) (new, from `tasks/users-api.task.yaml`) and [`governed/projects-change`](governed/projects-change) (the change to `samples/existing-api` from `tasks/projects-change.task.yaml`); see [governed/README.md](governed/README.md) |
| 03 | Run evidence: logs for both drivers, token report, standards check output, the PRs | [Run evidence](#03-run-evidence) |
| 04 | Our own addition | [Contract Lock](#04-our-own-addition-contract-lock), plus the fail-closed checks listed there |
| | Design note | [docs/design.md](docs/design.md) |

## Setup (one command)

```bash
npm run setup          # npm install, then `harness doctor`: environment, plugin load, provider-leak scan, sandbox self-test
```

Node ≥ 22, git, and `gh` (authenticated) for the PR step. Provider keys come only from the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); the repository holds no secrets. Agent-written code (its tests,
its schemas, its app during probes) runs only inside the OS sandbox (`sandbox-exec` on macOS, `bwrap` on
Linux): writes to a per-call temp dir, reads fenced to its own tree, an env allow-list without keys,
loopback network. Without a working sandbox a run refuses to start.

## Run it

```bash
export OPENAI_API_KEY=…   ANTHROPIC_API_KEY=…
export HARNESS_OPENAI_MODEL=gpt-5.6-luna HARNESS_CLAUDE_MODEL=claude-haiku-4-5-20251001   # the allowlisted models
git -C ../harness-demo checkout rubric-01                                         # the base before the 01 PRs merged
node bin/harness.mjs run tasks/users-api.task.yaml       --repo ../harness-demo --driver openai --ship   # greenfield → PR
node bin/harness.mjs run tasks/users-api.task.yaml       --repo ../harness-demo --driver claude          # same task, other provider
node bin/harness.mjs agnostic <runA> <runB>                                       # zero governing diff between two runs
node bin/harness.mjs run tasks/projects-change.task.yaml --repo ../harness-demo --driver openai --ship   # brownfield → PR
node bin/harness.mjs check --api governed/users-api                               # the standards check: verdict 100%
node bin/harness.mjs run tasks/users-api.task.yaml --repo ../harness-demo --driver openai --baseline     # measured token baseline
node bin/harness.mjs tokens compare <jitRun> <baselineRun>                        # baseline vs actual
```

`--model <id>` picks the model (else `HARNESS_OPENAI_MODEL` / `HARNESS_CLAUDE_MODEL`); task files cannot
name one, and since 02 it must be on `harness.config.json` `models.allow` (`gpt-5.6-luna`,
`claude-haiku-4-5-20251001`). Since 02 every run is also bound to an item whose contract was approved
in a typed turn: the task id names the item unless `--item <slug>` says otherwise (see above). Each run works in a fresh git worktree on its own branch, so your checkout is never touched;
`--repo <dir>` targets another repository. Without keys, the offline `scripted` driver replays recorded
tool calls through the real loop, hooks and gates (`fixtures/scripted/*.json`; harness demos, never
model evidence).

### Step by step: your own change on any repository

The harness is not a chat: you describe the change in a file, one command runs it to a verdict, and
one more opens the PR. Ctrl-C stops a run between steps and still writes its evidence. All commands
run from the `ai-harness` folder.

1. **Set up once:** `npm run setup` (above), and `gh auth login` if you want the PR step.

2. **Clone the repository you want to change** next to `ai-harness` (here the demo repository):

   ```bash
   git clone https://github.com/BasitJutt007/harness-demo.git ../harness-demo
   ```

3. **In each new terminal, set the provider key and the model.** Keys are read only from the
   environment and never written anywhere. For OpenAI:

   ```bash
   export OPENAI_API_KEY=sk-...
   export HARNESS_OPENAI_MODEL=gpt-5.6-luna
   ```

   For Claude: `export ANTHROPIC_API_KEY=...` and `HARNESS_CLAUDE_MODEL=<model id>`, then use
   `--driver claude` below. `--model <id>` on the command line overrides either variable. Optional:
   `export HARNESS_RUNS_DIR=.harness/my-runs HARNESS_TOKENS_DIR=.harness/my-tokens` keeps your runs out
   of the committed `runs/` and `tokens/`.

4. **Describe the change** in a Markdown file outside the target repository (format:
   [docs/task-format.md](docs/task-format.md)). `target` is the API folder inside the repository:
   `samples/existing-api` (Projects API) or `generated/users-api` (Users API) in the demo repository.
   Concrete behaviours (statuses, edge cases) give the model a precise goal.

   ```markdown
   ---
   target: samples/existing-api
   ---
   # Add search to projects

   GET /v1/projects accepts an optional `q` query parameter and returns only projects whose
   name contains it (case-insensitive). Pagination keeps working on the filtered list.

   - GET /v1/projects?q=alp returns only projects whose name contains "alp".
   - GET /v1/projects?q= with an empty value returns 422 application/problem+json.
   ```

5. **Check how the harness reads it** (no model call, no cost):

   ```bash
   node bin/harness.mjs task check ../my-tasks/add-search.md
   ```

6. **Run it:**

   ```bash
   node bin/harness.mjs run ../my-tasks/add-search.md --driver openai --repo ../harness-demo
   ```

   The run works on its own branch in a worktree under `.harness/worktrees/`, so your clone is never
   touched. It prints progress, then one line per gate, `verdict DONE` or `NOT DONE`, and the run id
   (e.g. `add-search-openai-20261004-160000`). On NOT DONE the gate lines say why; run it again or
   make the description more precise. A change that would break existing clients is refused by
   Contract Lock unless the file sets `allowBreaking: true`. The full evidence is in `runs/<run-id>/`.

7. **Open the PR** when it is DONE: every gate re-runs fresh, then the harness commits, pushes the run
   branch to the clone's `origin` and opens the PR with `gh` (or add `--ship` to step 6).

   ```bash
   node bin/harness.mjs ship <run-id>
   ```

8. **Clean up** a finished run's worktree when you no longer need it:

   ```bash
   git worktree remove --force .harness/worktrees/<run-id>
   ```

Every run ends with a summary. The shipped greenfield run (`runs/users-api-openai-20261004-145143`):

```
status     done  turns 14  finish attempts 1  driver openai  model gpt-5.6-luna (compat)
gate  contract-lock  n/a       not applicable to greenfield tasks
gate  observed-red   pass      1 red observations (1 test files); 1 changed source files went red -> green (…), red again with the original source (each file reverted alone)
gate  orphans        pass      no new non-test files
gate  scope          pass      2 changed files, all in scope
gate  spec-coverage  pass      18/18 units passed (1 resource(s), 5 endpoint(s)) [app: src/app.ts: export createApp()]
gate  standards      pass      verdict 100% (4 rules)
gate  tests-green    pass      33/33 tests passed in 5 files
tokens     actual 80289  baseline 280643  reduction 71.4%  over 14 turns  (output 3497, provider-reported input 76295)
verdict    DONE (all gates green)
```

## 01 Harness source

```
src/core/        the engine: loop, hook bus, gate runner, context and compaction, token ledger, check runner,
                 test runner, target profile, import-graph test map, type check, sandbox, worktree, ship, CLI;
                 since 02: items (contract, ledger, typed yes), measure, close, ship text, spend
plugins/         drivers/ (claude, openai, scripted)   tools/ (15)   hooks/ (11)   gates/ (11)   checks/ (9)
templates/       the greenfield scaffold (express-zod)
samples/         the brownfield sample API (existing-api)
tasks/           the two 01 task files
governed/        the two governed APIs
docs/contracts/  one contract per demo item; items/ the harness's ledger per item; metrics/ the Measure script
runs/ tokens/    run evidence and token reports
```

Extensions never edit `src/core/`: dropping one file into `plugins/` registers it
(`node scripts/simulate-extensions.mjs` proves it on three examples). `npm run verify` runs strict `tsc`
and the test suite (2063 tests on 5 Nov 2026, including end-to-end runs and real sandbox tests);
`npm run audit:mutations` checks that 31 broken or unmodelled variants of a shipped API never read 100%,
and that 51 mutated items never pass the 02 gates.

## 02 The two governed APIs

| API | task | run | result | PR opened by the harness |
|---|---|---|---|---|
| [`governed/users-api`](governed/users-api) | greenfield `tasks/users-api.task.yaml` | `runs/users-api-openai-20261004-145143` | **DONE**, 14 turns: spec-coverage 18/18, 33/33 tests, standards 100% | [harness-demo#10](https://github.com/BasitJutt007/harness-demo/pull/10) |
| [`governed/projects-change`](governed/projects-change) | brownfield `tasks/projects-change.task.yaml` on `samples/existing-api` | `runs/projects-change-openai-20261004-145700` | **DONE**, 21 turns: contract-lock pass (2 additive changes), 20/20 tests, standards 100% | [harness-demo#11](https://github.com/BasitJutt007/harness-demo/pull/11) |

Both ran on the final code with the openai driver and `gpt-5.6-luna`: every plugin and `src/core` hash
in their `run.json` matches the committed files. `governed/` holds the shipped commits unchanged.

## 03 Run evidence

Each run directory holds `run.json` (verdict, gate statuses, what is proven, unproven and left to a
human, governance hashes), `events.jsonl`, `transcript.jsonl`, `gates.json`, `logs/` (raw tool output),
`cli-output.txt`, the standards check output and `ship.txt`.

| Evidence | Files |
|---|---|
| **Logs, openai driver** | `runs/users-api-openai-20261004-145143/`, `runs/projects-change-openai-20261004-145700/` (the two DONE runs above, official OpenAI API) |
| **Logs, claude driver** | `runs/real-model/users-api-claude-20261003-163824/` and `…164131/`: two runs through OpenRouter's Anthropic-compatible endpoint on 3 Oct code, stopped before finishing. **No Claude run has reached DONE and none ran against `api.anthropic.com`** (no Anthropic key was available); the driver is covered by offline tests (`test/drivers/`) |
| **Token report** | `tokens/users-api-openai-20261004-145143.json` and `tokens/projects-change-openai-20261004-145700.json` (per turn: actual vs baseline); the measured comparison `tokens/compare-users-api-openai-20261004-145143-vs-users-api-openai-20261004-145009.json`: **67.2% fewer input tokens per turn, 54.1% per run** against a real `--baseline` run (design note §3). The >90% target is not met |
| **Standards check output** | `runs/users-api-openai-20261004-145143/check-generated-api.txt` and `runs/projects-change-openai-20261004-145700/check-existing-api.txt` (`harness check --api`, verdict 100%); `standards.txt` in each run |
| **Pull requests** | [harness-demo#10](https://github.com/BasitJutt007/harness-demo/pull/10) (greenfield) and [harness-demo#11](https://github.com/BasitJutt007/harness-demo/pull/11) (brownfield), opened by `harness ship` after every gate re-ran fresh |

The demo repository's `main` holds the sample API. Earlier harness versions opened #1–#4, #7 and #8;
#5, #6 and #9 revert them so that #10 and #11 apply to the same base. Every other run, including every
one that did not reach DONE and why, is in [runs/README.md](runs/README.md).

## 04 Our own addition: Contract Lock

`plugins/lib/contract.ts` + the `contract-lock` gate. For a brownfield change it extracts the public
contract (every route, the JSON Schema of each request part and of each 2xx response, generated from
the real Zod schemas at runtime) at the base commit and in the worktree, and diffs them. Removed routes,
new required fields, narrowed enums or constraints, removed response fields, changed types and a new 4xx
on an existing endpoint are **breaking**, and the gate refuses finish and ship unless the task sets
`allowBreaking: true`. A change it cannot classify (`.refine`, validation moved out of sight, a body
without an extractable schema) is UNPROVEN, never "preserved". In the shipped brownfield run it reported
`4 → 5 endpoints: 2 additive`; in `runs/real-model/projects-change-openai-20261003-190756` a model
overwrote three source files with a placeholder and Contract Lock failed the run (4 → 0 endpoints).

Further additions beyond a plain harness:
- **Observed red with a per-file revert check** (`observed-red` hook and gate): a source file is writable
  only after the harness ran a covering test and saw it fail; at finish that test must pass and fail again
  with that one file reverted.
- **Spec coverage** (`spec-coverage` gate): probes generated from the task's field specs (required, enum,
  bounds, unique, CRUD, idempotent replay) run against the live app.
- **Fail-closed checks:** whatever a check does not model (an unresolved handler, `res.redirect`, a
  router it cannot see mounted, a `.js` file, a route the running app serves that the analysis missed)
  is UNPROVEN, never pass ([design note §5](docs/design.md#5-honesty-boundary)).

## What it proves, and what it does not

- **Proves, mechanically:** writes stay in scope; no source edit without an observed red; red → green
  caused by each changed file; tests green when run fresh; standards at 100%; the task's endpoints behave
  per their field specs (greenfield); no breaking contract change (brownfield); no secrets ship.
- **Does not prove:** that the agent's tests test the intended behaviour; behaviours written only as free
  text; persistence, performance, security, concurrency. These are listed in each `run.json` for a human.
- **Known limits:** spec coverage and Contract Lock model Express only. NestJS and React + Vite targets
  get route, type, lint, build and query checks, not the live probes. No Claude run has reached DONE
  yet: the claude driver has answered live requests on claude-haiku-4-5-20251001, and the full re-run
  waits for the users-api contract's yes. The jest adapter has not yet run
  inside a governed run. The Linux sandbox is tested without a live Linux host. The ledger is tamper-evident against hand edits, not against someone who
  recomputes its hash chain: the operator is trusted. Prices in `models.prices` are upper bounds from
  public listings, not the provider's bill.
