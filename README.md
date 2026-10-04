# sf-ai-harness

A **harness, not an agent**, that governs TypeScript REST API work. It drives a model
through a provider-neutral driver, wraps every tool call in hooks that can block, record
or pass, fetches context just in time, and ends only when deterministic gates (not the
model) say the work is done. The harness, never the agent, ships the result.

- **Greenfield:** from a task file (resources, fields, behaviours, or a plain-English brief)
  it scaffolds an Express 5 + Zod 4 + Vitest API and drives the model test-first until
  every gate is green.
- **Brownfield:** given an existing API it reads the target's own layout and toolchain,
  maps source to tests through the import graph, gates every edit on an observed red,
  and refuses breaking contract changes.
- **Same task, any driver:** `--driver claude` and `--driver openai` run the identical
  task file, hooks, gates and checks. An offline `scripted` driver replays JSON scripts for
  the harness's own tests and key-less demos. It is never presented as model evidence.

Design note (architecture, driver abstraction, token budget, extension points, honesty
boundary): **[docs/design.md](docs/design.md)**. Extending: **[docs/extending.md](docs/extending.md)**.
Task-file format: **[docs/task-format.md](docs/task-format.md)**.

## Setup (one command)

```bash
npm run setup          # npm install + `harness doctor` (env, plugin load, provider-leak scan, sandbox self-test)
```

Node ≥ 22, git, and optionally `gh` (authenticated) for the PR step. Provider keys come
only from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). The repository holds no
secrets.

Agent-written code (its tests, its Zod schemas during contract extraction, its app during
runtime probes) runs under the OS sandbox: `sandbox-exec` on macOS, `bwrap` on Linux.
- **Writes:** only to a per-call temp dir; the API root is read-only to it.
- **Reads:** only its own tree, the `node_modules` chain, the node install and the four
  harness runtime files it needs (`HARNESS_RUNTIME_FILES` in `src/core/sandbox.ts`). `$HOME`, other repositories, other runs and credential
  stores are refused (`src/core/sandbox.ts`).
- **Env:** an allow-list (PATH, locale, a scratch HOME/TMPDIR); provider keys and other
  credentials never reach it.
- **Network:** loopback only.
- **In-process TypeScript programs** (the type check, contract extraction, the post-write
  type-check hook) read through a fenced compiler host with the same boundary (`src/core/ts-fence.ts`).

`harness doctor` self-tests the write, read, network and env boundaries. Without a working
sandbox a run refuses to start; `HARNESS_SANDBOX=off` runs unconfined and marks the run
`isolation: off` under UNPROVEN. Agent code does not control a result channel: the test
runner's JSON report reaches the harness over a private pipe, the probe child only serves the
app while the harness sends and judges every request, and the contract extractor imports a
changed module only if it is declarative Zod.

## The core directory: `src/core/`

**`src/core/` is the core engine. Extensions never edit it.** Everything else the harness
does is a plugin discovered from `plugins/` (drivers, tools, hooks, gates, checks):

```
src/core/        engine: loop, hook bus, gates runner, context/compaction, token ledger, check runner,
                 test runner, target profile, import-graph test map, typecheck, sandbox, worktree, ship, CLI
plugins/         drivers/ tools/ hooks/ gates/ checks/   (+ lib/ helpers, never loaded as plugins)
templates/       greenfield scaffold (express-zod) with its manifest (harness.template.json)
samples/         brownfield sample API (existing-api: a projects API)
tasks/           task files (provider-free: `model:`/`provider:` keys are rejected)
examples/plugins ready-to-drop extensions: openapi_diff tool, ORM validator, lint rule
governed/        the two governed APIs the harness produced and shipped (snapshots; see governed/README.md)
runs/ tokens/    evidence written by the harness on every run
```

## What graders run

| Dimension | Command | What to read |
|---|---|---|
| Model agnosticism | `node bin/harness.mjs run tasks/users-api.task.yaml --driver claude`, then the same with `--driver openai` | both end `verdict DONE`; `node bin/harness.mjs agnostic <runA> <runB>` reports zero governing diff (task sha, active tool/hook/gate/check manifest, config hash, `src/core` hash, helper files) and exits 0 only when both runs are DONE. In this repository only the openai side has real DONE runs ([Evidence](#evidence-in-this-repository)) |
| Token efficiency | `harness run …`, then the same with `--baseline`, then `node bin/harness.mjs tokens compare <jitRun> <baselineRun>` | `tokens/<runId>.json` (per-turn actual vs a **shadow** baseline) and `tokens/compare-…json` (a **measured** baseline: fetchers withheld, repo front-loaded every turn, no compaction) |
| API standards | `node bin/harness.mjs check --api <generated-api-dir>` | one line per rule per file, then one summary line each for `problem-json`, `rest-conventions`, `tsc-strict`, `zod-boundary` and `verdict 100%` |
| Extensibility | `node scripts/simulate-extensions.mjs`, or add one file to `plugins/` yourself ([docs/extending.md](docs/extending.md)) | `git diff --stat` touches only the new plugin file; `src/core/**` sha256 unchanged |

```bash
export ANTHROPIC_API_KEY=… OPENAI_API_KEY=…
node bin/harness.mjs run tasks/users-api.task.yaml       --driver claude --ship  # greenfield → PR
node bin/harness.mjs run tasks/users-api.task.yaml       --driver openai         # same task, other provider
node bin/harness.mjs agnostic <claudeRunId> <openaiRunId>                        # zero diff
node bin/harness.mjs run tasks/projects-change.task.yaml --driver openai --ship  # brownfield → PR
node bin/harness.mjs check --api .harness/worktrees/<runId>/generated/users-api  # the generated API
node bin/harness.mjs task check <task-file>                                      # how a task file is read, no tokens spent
```

Models are chosen outside the task file: `--model <id>`, `HARNESS_CLAUDE_MODEL`
(default `claude-opus-5-5`) or `HARNESS_OPENAI_MODEL` (default `gpt-5.5`, falling back to
`gpt-5` when the account cannot use it). Each run works in a fresh git worktree on its own
branch (`harness/<task>-<driver>-<stamp>`) under `.harness/worktrees/`, so your checkout is
never touched. `--repo <dir>` targets any other git repository, and `HARNESS_RUNS_DIR` /
`HARNESS_TOKENS_DIR` move the evidence directories.

Every `harness run` ends with a summary. From the real greenfield run
`runs/users-api-openai-20261004-045649` (official OpenAI API, `gpt-5.4`, current code):

```
status     done  turns 23  finish attempts 1  driver openai  model gpt-5.4
gate  contract-lock  n/a       not applicable to greenfield tasks
gate  observed-red   pass      3 red observations (1 test files); 1 changed source files went red -> green (1 on unchanged cases, 0 on edited cases by differential proof), red again with the original source
gate  orphans        pass      no new non-test files
gate  scope          pass      2 changed files, all in scope
gate  spec-coverage  pass      17/17 units passed (1 resource(s), 5 endpoint(s)) [app: src/app.ts: export createApp()]
gate  standards      pass      verdict 100% (4 rules)
gate  tests-green    pass      41/41 tests passed in 5 files
tokens     actual 150910  baseline 576904  reduction 73.8%  over 23 turns  (output 5651, provider-reported input 145090)
           baseline is a shadow estimate (never sent); measured: harness run <task> --baseline, then harness tokens compare …
verdict    DONE (all gates green)
```

### Try it without keys

The offline `scripted` driver replays a fixed JSON script of tool calls through the real
loop, hooks, gates and checks. These runs are harness demos, **not model evidence**.

```bash
S=fixtures/scripted
node bin/harness.mjs run tasks/users-api.task.yaml       --driver scripted --driver-opt script=$S/users-api.json          # greenfield: DONE
node bin/harness.mjs run tasks/projects-change.task.yaml --driver scripted --driver-opt script=$S/projects-change.json    # brownfield: DONE, 2 additive
node bin/harness.mjs run tasks/users-api.task.yaml       --driver scripted --driver-opt script=$S/users-api-cheat.json    # cheat: forbidden writes blocked, exit 1
node bin/harness.mjs run tasks/projects-change.task.yaml --driver scripted --driver-opt script=$S/projects-breaking.json  # tests green, contract-lock fail, exit 1
node bin/harness.mjs ship <greenfieldRunId> --dry-run                                # gates re-run fresh; prints the plan, changes nothing
```

A run without `--repo` creates a branch `harness/<runId>` and a worktree in this repository;
remove them with `git worktree remove --force .harness/worktrees/<runId>` and
`git branch -D harness/<runId>`. Set `HARNESS_RUNS_DIR` / `HARNESS_TOKENS_DIR` to keep the
committed `runs/` and `tokens/` as they are.

## Principles, as code

| Principle | Where it lives |
|---|---|
| Deterministic tools for deterministic tasks | `src/core/testing.ts` (the harness runs the target's own test runner), `checks.ts`, `typecheck.ts`, `testmap.ts`, `ship.ts`. The model has no shell, never runs git, tsc or tests itself |
| Hooks, not prompts | `plugins/hooks/` pre-tool: `path-guard`, `observed-red`, `unsafe-code-guard`, `secret-guard`, `source-boundary`, `test-preservation`, `elision-guard`, `dependency-policy`; post-tool: `typecheck-feedback` (records type errors, never blocks). Write tools declare their exact post-write content (`preview`), so content hooks judge what will be on disk; a write tool without `preview` is refused. A hook that crashes blocks the call |
| Observed red before source edits | `observed-red` hook + gate: a source file is writable only after a test case that asserts on its values (any assertion library) was **run by the harness and seen failing** at its current content; finish needs that case to pass, and to fail again when the harness puts the run-start source back (revert check). Whether a test checks the right thing is for a human |
| Existing tests only grow | `test-preservation` hook (`append_file` adds cases): pre-existing cases are append-only, their hooks and helpers stay as they were |
| The task is actually done | `spec-coverage` gate: every endpoint the task's resources × operations imply must exist, and probes generated from the field specs (required, enum, min/max, unique, CRUD, idempotency) must pass against the running app; `orphans` gate: every file the run created is used |
| Executed agent code is confined | `src/core/sandbox.ts`, `src/core/ts-fence.ts`; `run.json` records `isolation` |
| The harness ships, the agent never does | `harness ship` / `--ship`: re-runs every gate fresh, stages only the API root, scans for secrets, commits as `sf-harness`, pushes the feature branch (never a protected one, never `--force`), opens the PR with `gh` |
| Cheapest mechanism wins | checks > hooks > rules index (one line per rule) > tools > prompt. The standards text costs zero tokens until `fetch_standard` asks for it |
| Honesty boundary | a skipped check is `UNPROVEN`, an empty standards rule is `unproven 0/0`, `n/a` is never counted as green. `run.json` lists proven / failed / unproven / n/a / what a human must verify |

## Our own addition: Contract Lock

`plugins/lib/contract.ts` extracts the public contract (every route, plus the JSON Schemas
of params/query/body/headers and of each 2xx response, generated from the actual Zod schemas
at runtime) from both the base commit and the worktree, then diffs them. Removed routes, new
required request fields, narrowed enums, removed or now-optional response fields, changed
types, narrowed request constraints (bounds, lengths, pattern, format, multipleOf, a closed
object, a changed default), widened response constraints and a new 4xx on an existing endpoint
are **breaking**. A change JSON Schema cannot show (`.refine`), validation that moves out of
sight and a POST/PUT/PATCH body without an extractable schema are UNPROVEN, never "preserved".
The `contract-lock` gate refuses finish and ship unless the task sets `allowBreaking: true`.

**What it does not see:** behaviour behind an unchanged schema (filtering, sorting, cursor
meaning), changed error statuses for the same condition, response headers, and routes whose
path is not a resolvable constant. Those are for the tests and a human.

Evidence: the scripted run `projects-change-scripted-…172537` makes `POST /v1/projects` stop
accepting `status: "archived"` with all tests green; contract-lock alone refuses it. Against a
real model, `runs/real-model/projects-change-openai-…190756` overwrote three source files with a
placeholder and contract-lock failed the run (4 → 0 endpoints).

## Evidence in this repository

### The final code: DONE runs and the attempts that did not finish

After an external review (idempotent replay returned updated state; checker bypasses for middleware
responses, mutated bodies, problem bodies without the problem Content-Type, header-only idempotency,
create without Location; cwd-dependent revert proofs; alias imports of test code; enforcement-blind
`agnostic`; a lenient brownfield policy), the code was fixed and run again. Official OpenAI API,
openai driver, `gpt-5.6-luna` (compat: reasoning off, because Chat Completions refuses tools with
reasoning on for this model).

| run | task | turns | result |
|---|---|---|---|
| `projects-change-openai-20261004-081959` | brownfield | 29 | **DONE on the final code** (every plugin fingerprint matches): contract-lock pass (2 additive), 22/22 tests, standards 100%, observed red on 3 source files + revert check in identical contexts |
| `users-api-openai-20261004-073321` | greenfield | 22 | **DONE** on the code of a few commits earlier (4 plugin files differ: later checker changes and a Contract Lock fix). `ship-dry-run-final-code.txt` re-ran every gate of the final code on its output: all green, spec-coverage 18/18 (including the new replay-after-update probe), 32/32 tests, standards 100% |
| `real-model/users-api-openai-20261004-074452`, `…074855`, `…081728`, `…082126` | greenfield | 60 each | NOT DONE on the final code or one commit before it: the model wrote request/response helpers the checker could not follow (since fixed: helpers are followed by behaviour), a permissive body schema, or tests with wrong expectations; spec-coverage was 18/18 in every one |
| `real-model/projects-change-openai-20261004-073446`, `…073616`, `…073856` | brownfield | 40 each | NOT DONE: the shared-state trap (below) twice; once all gates were green at the end but the model never called finish (now DONE by rule: fresh green gates decide); one also exposed a Contract Lock false UNPROVEN on a reformatted schema (fixed) |

Gpt-5.6-luna finishes the brownfield task reliably but the greenfield task only sometimes; the
harness refused every incomplete result. `governed/` holds the two DONE outputs above.

### Earlier runs on 4 Oct (official OpenAI API, openai driver)

These ran before the last few plugin changes (the order-dependence diagnosis, the fenced
type-check hook); the two shipped as PRs are among them.

| run | task | model | turns | result |
|---|---|---|---|---|
| `users-api-openai-20261004-045649` | greenfield `users-api` | `gpt-5.4` | 23 | **DONE**: 6 gates pass, contract-lock n/a (spec-coverage 17/17 on the task's fields and operations, 41/41 tests, standards 100%) |
| `users-api-openai-20261004-045825` | greenfield `users-api`, **`--baseline`** | `gpt-5.4-mini` | 16 | **DONE** in baseline mode (fetchers withheld, repo front-loaded every turn, no compaction) |
| `users-api-openai-20261004-045424` | greenfield `users-api` | `gpt-5.4-mini` | 60 | NOT DONE (max turns): the model looped for ~40 turns on a failing test it wrote; the fresh final gates were green, but it never asked to finish again |
| `real-model/projects-change-openai-20261004-045936`, `…050115` | brownfield | `gpt-5.4` | 40, 40 | NOT DONE: one failing agent-written test each (see below) |
| `real-model/projects-change-openai-20261004-050306` | brownfield | `gpt-5.6-luna` | 20 | finish accepted with every finish gate green; stopped by the operator during the final fresh gate run, so `run.json` was never finalised (no verdict) |
| `projects-change-openai-20261004-050613` | brownfield | `gpt-5.6-luna` (compat) | 40 | NOT DONE: one failing agent-written test |
| `projects-change-openai-20261004-052623` | brownfield `projects-change` | `gpt-5.6-luna` (compat) | 20 | **DONE**: contract-lock pass (2 additive), observed red (3 source files + revert check), 22/22 tests, standards 100% |

The three failed brownfield runs share one cause: the sample API keeps its data in a
module-level `Map`, so tests in one file share state, and the model wrote exact-count
assertions that fail after earlier tests created records. The harness refused DONE each time
(tests-green failed). `run_tests` now diagnoses this case: it re-runs a failing case alone and,
if it passes alone, tells the model the test depends on test order. That diagnosis is covered by
offline tests (`test/red-green/order-dependence.test.ts`) and fired in two real brownfield runs
(`…055658`, DONE; `…073446`, not DONE).

Each run directory holds `run.json`, `events.jsonl`, `transcript.jsonl`, `gates.json`,
`standards.txt`, `logs/` and `cli-output.txt`; both DONE runs also have `check-generated-api.txt`
or `check-existing-api.txt` (`harness check --api`, verdict 100%) and `ship-dry-run.txt` (every
gate re-run fresh, `secrets` included, all green; nothing pushed).

**The two governed APIs** are in this repository under [`governed/`](governed/README.md): the outputs of
the two final-code DONE runs above; `node bin/harness.mjs check --api governed/users-api` reads 100%.

**Pull requests opened by the harness** (`harness ship`, every gate re-run fresh first, pushed to a
feature branch, opened with `gh`), on the demo repository whose `main` holds the sample API:
- [BasitJutt007/harness-demo#1](https://github.com/BasitJutt007/harness-demo/pull/1) (merged, then reverted by #5): greenfield, run `users-api-openai-20261004-045649`
- [BasitJutt007/harness-demo#2](https://github.com/BasitJutt007/harness-demo/pull/2) (merged, then reverted by #5): brownfield, run `projects-change-openai-20261004-052623`
- [BasitJutt007/harness-demo#3](https://github.com/BasitJutt007/harness-demo/pull/3) (merged): greenfield, run `users-api-openai-20261004-055546`
- [BasitJutt007/harness-demo#4](https://github.com/BasitJutt007/harness-demo/pull/4) (merged): brownfield, run `projects-change-openai-20261004-055658`

#3 and #4 were opened after #1 and #2 had been merged and were built on the same base.
[#5](https://github.com/BasitJutt007/harness-demo/pull/5) reverts #1 and #2 (two revert commits, no
history rewrite); #3 and #4 were then merged. These four PRs came from runs made before the external
review's fixes: the Users API on `main` still carries the scaffold's old idempotency helper (a replay
after an update returns the updated state). `governed/` holds the outputs of the fixed code; no PR has
been opened from them yet.

The PR bodies quote the run's token totals against the shadow baseline; #3 and #4 label it as a
shadow estimate (#1 and #2 predate that wording).

**Tokens, measured: the >90% target is not met.** `tokens/compare-users-api-openai-20261004-045424-vs-users-api-openai-20261004-045825.json`
compares a normal run with a real `--baseline` run on the same model (`gpt-5.4-mini`):

| | normal run (JIT + compaction) | `--baseline` run | reduction |
|---|---|---|---|
| input tokens per turn | 6,450 | 17,362 | **62.8%** |
| input tokens per run | 387,022 (60 turns) | 277,791 (16 turns) | **−39.3%** |

Per request, JIT context and compaction cut the input by 62.8%. Per run they did not pay off
here: with the whole repository in every request the model finished in 16 turns, while the
JIT run looped for 60. The shadow estimate a normal run prints (73.8% and 75.3% on these runs)
overstates the saving, because it assumes the same turns with a bigger context; it is labelled
`baseline_kind: shadow` in every report.

### Earlier real runs (3 Oct code)

`users-api-openai-20261003-185149` (`gpt-5.4-mini`, DONE in 19 turns) and
`projects-change-openai-20261003-190927` (`gpt-5.4`, DONE in 12 turns, contract-lock pass with
2 additive changes) ran on the code of 3 October, before the generality work below. Their
token reports use the shadow baseline only. `runs/real-model/` keeps every real run that did not
reach DONE, with the defect each one exposed and its fix (`runs/real-model/README.md`).

**Model agnosticism, as proven for real:** the openai driver ran on the official OpenAI API
(DONE on both tasks), Google AI Studio's OpenAI-compatible endpoint and OpenRouter. The claude
driver ran only through OpenRouter's Anthropic-compatible endpoint (a smoke call and two partial
free-model runs). It has never run against `api.anthropic.com`: no Claude run reached DONE, and
there is no real `harness agnostic <claudeRun> <openaiRun>`.

### Offline scripted runs (harness demos, not model evidence)

The runs whose ids contain `scripted` replay fixed JSON scripts through the real loop, hooks,
gates and checks (recorded on 3 Oct code; `test/e2e/` re-runs the same scripts on the current
code on every `npm run verify`):

| run | what it shows |
|---|---|
| `users-api-scripted-…172502` | greenfield, all gates green |
| `projects-change-scripted-…172515` | brownfield, contract-lock pass (2 additive changes) |
| `users-api-scripted-…172529` | cheating script: every forbidden write blocked by the named hook, finish refused |
| `projects-change-scripted-…172537` | breaking change with green tests: contract-lock fail, finish refused |

## What the harness proves, and what it does not

- **Proves (mechanically):** writes stay inside the scope; no source edit without an observed
  red; red → green caused by the source change (revert check); tests green when run fresh;
  standards rules at 100% (greenfield) or no worse than the base (brownfield); the task's
  resources and operations exist and behave per their field specs (greenfield, structured
  tasks); no breaking contract change (brownfield); no secrets in what ships.
- **Does not prove:** behaviours written only as free text; that the agent-written tests cover
  every listed behaviour; anything the four standards checks cannot see (their known limits are
  listed in `docs/design.md`); persistence, performance, security and concurrency.
- **Known limits:** Express only (other frameworks are UNPROVEN at preflight); the jest adapter
  is verified on recorded reports only (jest is not installed in the harness); the Linux `bwrap`
  sandbox is unit-tested on its argument list only (developed on macOS); `--baseline` cannot
  shrink a request that overflows the model's context window.

Run the harness's own suite with `npm run verify` (strict `tsc`, then the Vitest suite,
including end-to-end runs in throwaway git repositories and real sandbox tests).
