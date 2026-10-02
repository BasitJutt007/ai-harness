# sf-ai-harness

A **harness, not an agent**, that governs TypeScript REST API work. It drives a model
through a provider-neutral driver, wraps every tool call in hooks that can block, record
or pass, fetches context just in time, and ends only when deterministic gates (not the
model) say the work is done. The harness, never the agent, ships the result.

- **Greenfield:** from a task file (resource, fields, behaviours) it scaffolds an
  Express 5 + Zod 4 + Vitest API and drives the model test-first until every gate is green.
- **Brownfield:** given an existing API it maps source to tests through the import graph,
  gates every edit on an observed red, and refuses breaking contract changes.
- **Same task, any driver:** `--driver claude` and `--driver openai` run the identical
  task file, hooks, gates and checks. An offline `scripted` driver replays JSON scripts for
  the harness's own tests and key-less demos. It is never presented as model evidence.

Design note (architecture, driver abstraction, token budget, extension points, honesty
boundary): **[docs/design.md](docs/design.md)**. Extending: **[docs/extending.md](docs/extending.md)**.

## Setup (one command)

```bash
npm run setup          # npm install + `harness doctor` (env, plugin load, provider-leak scan)
```

Node ≥ 22, git, and optionally `gh` (authenticated) for the PR step. Provider keys come
only from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). The repository holds no
secrets, and generated code never sees the keys: every subprocess the harness starts runs
with credential-shaped variables stripped, and the test runner also gets a throwaway `HOME`.

## The core directory: `src/core/`

**`src/core/` is the core engine. Extensions never edit it.** Everything else the harness
does is a plugin discovered from `plugins/` (drivers, tools, hooks, gates, checks):

```
src/core/        engine: loop, hook bus, gates runner, context/compaction, token ledger,
                 check runner, test runner, import-graph test map, worktree, ship, CLI
plugins/         drivers/ tools/ hooks/ gates/ checks/   (+ lib/ helpers, never loaded as plugins)
templates/       greenfield scaffold (express-zod)
samples/         brownfield sample API (existing-api: a projects API)
tasks/           task files (provider-free; unknown keys such as `model:` are rejected)
examples/plugins ready-to-drop extensions: openapi_diff tool, ORM validator, lint rule
runs/ tokens/    evidence written by the harness on every run
```

## What graders run

| Dimension | Command | What to read |
|---|---|---|
| Model agnosticism | `npx harness run tasks/users-api.task.yaml --driver claude`, then the same with `--driver openai` | both end `verdict DONE`; `npx harness agnostic <runA> <runB>` reports zero diff in task sha + every tool/hook/gate/check file |
| Token efficiency | any `harness run …` | `tokens/<runId>.json`: per-turn `actual_input_tokens` vs `baseline_input_tokens`, totals, attribution. A measured baseline: run again with `--baseline`, then `npx harness tokens compare <jitRun> <baselineRun>` |
| API standards | `npx harness check --api <generated-api-dir>` | one line per rule per file, then one summary line each for `problem-json`, `rest-conventions`, `tsc-strict`, `zod-boundary` and `verdict 100%` |
| Extensibility | `node scripts/simulate-extensions.mjs`, or add one file to `plugins/` yourself ([docs/extending.md](docs/extending.md) has a minimal `openapi-diff` tool, ORM validator and lint rule) | `git diff --stat` touches only the new plugin file; `src/core/**` sha256 unchanged |

```bash
export ANTHROPIC_API_KEY=… OPENAI_API_KEY=…
npx harness run tasks/users-api.task.yaml       --driver claude --ship  # greenfield → PR
npx harness run tasks/users-api.task.yaml       --driver openai         # same task, other provider
npx harness agnostic <claudeRunId> <openaiRunId>                        # zero diff
npx harness run tasks/projects-change.task.yaml --driver openai --ship  # brownfield → PR
npx harness check --api .harness/worktrees/<runId>/generated/users-api  # the generated API (also on the PR branch)
```

Models are chosen outside the task file: `--model <id>`, `HARNESS_CLAUDE_MODEL`
(default `claude-opus-5-5`) or `HARNESS_OPENAI_MODEL` (default `gpt-5.5`, falling back to
`gpt-5` when neither is set and the account cannot use it). Each run works in a fresh git
worktree on its own branch (`harness/<task>-<driver>-<stamp>`) under `.harness/worktrees/`,
so your checkout is never touched. `--repo <dir>` targets any other git repository, and
`HARNESS_RUNS_DIR` / `HARNESS_TOKENS_DIR` move the evidence directories.

Every `harness run` ends with a summary. An excerpt from the scripted greenfield run in `runs/`:

```
gate  contract-lock  n/a       not applicable to greenfield tasks
gate  observed-red   pass      1 red observations (1 test files); 4 changed source files covered
gate  scope          pass      5 changed files, all in scope
gate  standards      pass      verdict 100% (4 rules)
gate  tests-green    pass      54/54 tests passed in 5 files
standards  pass 100%  problem-json pass, rest-conventions pass, tsc-strict pass, zod-boundary pass
tokens     actual 19305  baseline 177536  reduction 89.1%  over 9 turns  (output 4476, provider-reported input 19305)
verdict    DONE (all gates green)
```

### Try it without keys

The offline `scripted` driver replays a fixed JSON script of tool calls through the real
loop, hooks, gates and checks. These runs are harness demos, **not model evidence**.
`script=` is relative to the harness root. Each run prints its run id (`<task>-scripted-<stamp>`).

```bash
S=fixtures/scripted
npx harness run tasks/users-api.task.yaml       --driver scripted --driver-opt script=$S/users-api.json          # greenfield: DONE
npx harness run tasks/projects-change.task.yaml --driver scripted --driver-opt script=$S/projects-change.json    # brownfield: DONE, 2 additive
npx harness run tasks/users-api.task.yaml       --driver scripted --driver-opt script=$S/users-api-cheat.json    # cheat: 4 writes blocked, exit 1
npx harness run tasks/projects-change.task.yaml --driver scripted --driver-opt script=$S/projects-breaking.json  # contract-lock fail, exit 1
npx harness run tasks/users-api.task.yaml       --driver scripted --driver-opt script=$S/users-api.json --baseline  # no JIT, no compaction
npx harness tokens compare <greenfieldRunId> <baselineRunId>                # measured reduction (89.1%)
npx harness agnostic <greenfieldRunId> <baselineRunId>                      # zero diff: same task sha and plugin files
npx harness ship <greenfieldRunId> --dry-run                                # gates re-run fresh; prints the plan, changes nothing
npx harness check --api .harness/worktrees/<greenfieldRunId>/generated/users-api   # verdict 100%
```

The hook blocks are in `runs/<id>/events.jsonl` (`"decision":"block"`). To target another
git repository add `--repo <dir>` (a brownfield target needs `samples/existing-api` in it;
the worktree still lives under the harness's `.harness/worktrees/`), and set
`HARNESS_RUNS_DIR` / `HARNESS_TOKENS_DIR` to keep the committed `runs/` and `tokens/` as they are.

## Principles, as code

| Principle | Where it lives |
|---|---|
| Deterministic tools for deterministic tasks | `src/core/testing.ts` (the harness's own Vitest runner), `checks.ts`, `testmap.ts`, `ship.ts`. The model never runs git, tsc or tests itself |
| Hooks, not prompts | `plugins/hooks/`: `path-guard`, `observed-red`, `unsafe-code-guard`, `secret-guard`, `source-boundary`, `test-preservation`. All fail closed |
| Observed red before source edits | `observed-red` hook + gate: a `src/` file is writable only after a test that imports it was **run by the harness and seen failing** at its current content |
| The harness ships, the agent never does | `harness ship` / `--ship`: re-runs every gate fresh, stages only the API root, scans for secrets, commits as `sf-harness`, pushes the feature branch (never a protected one, never `--force`), opens the PR with `gh` |
| Cheapest mechanism wins | checks > hooks > rules index (one line per rule) > tools > prompt. The standards text costs zero tokens until `fetch_standard` asks for it |
| Honesty boundary | a skipped check is `UNPROVEN`, an empty standards rule is `unproven 0/0`, `n/a` is never counted as green. `run.json` lists proven / failed / unproven / n/a / what a human must verify |

## Our own addition: Contract Lock

The brief does not ask for it. We added it so that brownfield changes cannot silently break
clients: `plugins/lib/contract.ts` extracts the public contract (every route, plus the
JSON Schemas of params/query/body/headers and of each 2xx response, generated from the
actual Zod schemas at runtime) from both the base commit and the worktree, then diffs them.
Removed routes, new required request fields, narrowed enums, removed or now-optional
response fields and changed types are **breaking**. The `contract-lock` gate refuses finish
and ship unless the task sets `allowBreaking: true`. The model can check itself first with
the `contract_diff` tool. Evidence: the scripted run `projects-change-scripted-…200829`
(script `projects-breaking.json`) is refused with 4 breaking changes, even though its tests
and standards are 100% green.

## Evidence in this repository

**`runs/` and `tokens/` currently hold only offline `scripted`-driver runs** (run ids
contain `scripted`). They prove the harness machinery end to end without API keys. They are
**not** model evidence:

| run | what it shows |
|---|---|
| `users-api-scripted-…200743` | greenfield, all gates green, standards 100%, 89.1% token reduction over 9 turns |
| `users-api-scripted-…200800` | same script in `--baseline` mode; `tokens/compare-…json` measures 89.1% against it |
| `projects-change-scripted-…200810` | brownfield, contract-lock pass (2 additive changes), standards 100%, 85.3% token reduction |
| `users-api-scripted-…200822` | cheating script: all 4 write attempts blocked by the named hook (`observed-red`, `path-guard` ×2, `unsafe-code-guard`), finish refused |
| `projects-change-scripted-…200829` | breaking change: contract-lock fail (4 breaking), finish refused |

`runs/users-api-scripted-…200743/` also holds `check-generated-api.txt` (`harness check` on
the generated API: verdict 100%) and `ship-dry-run.txt` (fresh ship gates, then the exact
git/gh plan).

These short runs sit below 90% because of a fixed per-turn floor; the 40-turn simulation in
`test/token-efficiency/long-run.test.ts` reaches 90.9% (see [docs/design.md](docs/design.md) §3).

**Real-driver evidence** (both drivers' run logs, their token reports, the PRs) is produced
by running the commands above with real keys; the harness writes all of it to `runs/` and
`tokens/`. No number in this README stands in for those runs.

Run the harness's own suite with `npm run verify` (strict `tsc`, then the Vitest suite,
including end-to-end runs in throwaway git repositories). Its budget and extensibility
assertions cover the shipped plugins and the examples only, so it stays green after you
drop your own tool, ORM validator or lint rule into `plugins/`.
