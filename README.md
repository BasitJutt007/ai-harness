# sf-ai-harness

A **harness, not an agent**, for TypeScript REST API work. It drives a model through a provider-neutral
driver, runs every tool call through hooks that can block it, fetches context just in time, and ends
only when deterministic gates (not the model) say the work is done. The harness, never the agent,
opens the pull request. ss

- **Greenfield:** from a task file it scaffolds an Express 5 + Zod 4 + Vitest API and drives the model
  test-first until every gate is green.
- **Brownfield:** on an existing API it reads the target's own layout and toolchain, gates every source
  edit on a test it has seen fail, and refuses breaking contract changes.
- **Any driver:** `--driver claude` and `--driver openai` run the identical task file, hooks, gates and
  checks.

**Design note:** [docs/design.md](docs/design.md) (architecture, driver abstraction, token budget,
extension points, honesty boundary). Detail: [docs/reference.md](docs/reference.md). Extending:
[docs/extending.md](docs/extending.md). Task files: [docs/task-format.md](docs/task-format.md).

## Deliverables

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
node bin/harness.mjs run tasks/users-api.task.yaml       --driver openai --ship   # greenfield → PR
node bin/harness.mjs run tasks/users-api.task.yaml       --driver claude          # same task, other provider
node bin/harness.mjs agnostic <runA> <runB>                                       # zero governing diff between two runs
node bin/harness.mjs run tasks/projects-change.task.yaml --driver openai --ship   # brownfield → PR
node bin/harness.mjs check --api governed/users-api                               # the standards check: verdict 100%
node bin/harness.mjs run tasks/users-api.task.yaml --driver openai --baseline     # measured token baseline
node bin/harness.mjs tokens compare <jitRun> <baselineRun>                        # baseline vs actual
```

`--model <id>` picks the model (else `HARNESS_OPENAI_MODEL` / `HARNESS_CLAUDE_MODEL`); task files cannot
name one. Each run works in a fresh git worktree on its own branch, so your checkout is never touched;
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
                 test runner, target profile, import-graph test map, type check, sandbox, worktree, ship, CLI
plugins/         drivers/ (claude, openai, scripted)   tools/ (15)   hooks/ (9)   gates/ (8)   checks/ (4)
templates/       the greenfield scaffold (express-zod)
samples/         the brownfield sample API (existing-api)
tasks/           the two task files
governed/        the two governed APIs
runs/ tokens/    run evidence and token reports
```

Extensions never edit `src/core/`: dropping one file into `plugins/` registers it
(`node scripts/simulate-extensions.mjs` proves it on three examples). `npm run verify` runs strict `tsc`
and the test suite (1921 tests, including end-to-end runs and real sandbox tests);
`npm run audit:mutations` checks that 31 broken or unmodelled variants of a shipped API never read 100%.

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
- **Known limits:** Express only; the claude driver is unproven against Anthropic's API; the Linux
  sandbox and the jest adapter are tested without a live Linux host or jest install.
