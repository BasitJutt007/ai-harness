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
boundary, real-model runs): **[docs/design.md](docs/design.md)**. Extending: **[docs/extending.md](docs/extending.md)**.

## Setup (one command)

```bash
npm run setup          # npm install + `harness doctor` (env, plugin load, provider-leak scan)
```

Node ≥ 22, git, and optionally `gh` (authenticated) for the PR step. Provider keys come
only from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). The repository holds no
secrets, and generated code never sees the keys: every subprocess the harness starts runs
with credential-shaped variables stripped, and the test runner also gets a throwaway `HOME`.

Agent-written code (its tests, its Zod schemas during contract extraction, its `createApp`
during runtime probes) runs under the OS sandbox: `sandbox-exec` on macOS, `bwrap` on Linux.
The API root is read-only to it, it can write only to a per-call temp dir, its network is
loopback only, and credential stores are unreadable. `harness doctor` self-tests this. Without
a working sandbox a run refuses to start; `HARNESS_SANDBOX=off` runs unconfined and the run is
marked `isolation: off` under UNPROVEN. The git worktree protects your checkout from the agent's
tool writes; the sandbox protects it from the code the agent wrote, when that code runs. Agent
code also does not control a result channel: Vitest's
JSON report reaches the harness over a private pipe (fd 3) that test workers do not inherit, the
probe child only serves the app while the harness sends and judges every request, and the
contract extractor imports a changed module only if it is declarative Zod.

## The core directory: `src/core/`

**`src/core/` is the core engine. Extensions never edit it.** Everything else the harness
does is a plugin discovered from `plugins/` (drivers, tools, hooks, gates, checks):

```
src/core/        engine: loop, hook bus, gates runner, context/compaction, token ledger,
                 check runner, test runner, import-graph test map, worktree, ship, CLI
plugins/         drivers/ tools/ hooks/ gates/ checks/   (+ lib/ helpers, never loaded as plugins)
templates/       greenfield scaffold (express-zod)
samples/         brownfield sample API (existing-api: a projects API)
tasks/           task files (provider-free: `model:`/`provider:` keys are rejected; format: docs/task-format.md)
examples/plugins ready-to-drop extensions: openapi_diff tool, ORM validator, lint rule
runs/ tokens/    evidence written by the harness on every run
```

## What graders run

| Dimension | Command | What to read |
|---|---|---|
| Model agnosticism | `npx harness run tasks/users-api.task.yaml --driver claude`, then the same with `--driver openai` | both end `verdict DONE`; `npx harness agnostic <runA> <runB>` reports zero diff in task sha + every tool/hook/gate/check file. In this repository only the openai side has a real DONE run; the claude side needs an Anthropic key ([Evidence](#evidence-in-this-repository)) |
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

Every `harness run` ends with a summary. An excerpt from the real greenfield run
`runs/users-api-openai-20261003-185149` (official OpenAI API, `gpt-5.4-mini`):

```
status     done  turns 19  finish attempts 1  driver openai  model gpt-5.4-mini
gate  contract-lock  n/a       not applicable to greenfield tasks
gate  observed-red   pass      1 red observations (1 test files); 1 changed source files went red -> green on unchanged cases, red again with the original source
gate  scope          pass      2 changed files, all in scope
gate  standards      pass      verdict 100% (4 rules)
gate  tests-green    pass      28/28 tests passed in 5 files
standards  pass 100%  problem-json pass, rest-conventions pass, tsc-strict pass, zod-boundary pass
tokens     actual 90195  baseline 397317  reduction 77.3%  over 19 turns  (output 2724, provider-reported input 85118)
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
npx harness run tasks/projects-change.task.yaml --driver scripted --driver-opt script=$S/projects-breaking.json  # tests green, contract-lock fail, exit 1
npx harness run tasks/users-api.task.yaml       --driver scripted --driver-opt script=$S/users-api.json --baseline  # no JIT, no compaction
npx harness tokens compare <greenfieldRunId> <baselineRunId>                # measured reduction (85.4% on the current code; 89.2% in the committed evidence run)
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
| Hooks, not prompts | `plugins/hooks/`: `path-guard`, `observed-red`, `unsafe-code-guard`, `secret-guard`, `source-boundary`, `test-preservation`, `elision-guard`. All fail closed |
| Observed red before source edits | `observed-red` hook + gate: a `src/` file is writable only after a test case that asserts on its values was **run by the harness and seen failing** on a non-constant assertion at its current content; finish needs that case to pass, and to fail again when the harness puts the run-start source back (revert check). A case edited after its red counts only through that differential proof. A weak but change-sensitive test still satisfies this; whether a test checks the right thing is for a human |
| One definition of a test file | `src/core/testmap.ts`: `*.test.ts` / `*.spec.ts` is a runnable test, any other file under `test/` is test support; the hooks, `run_tests`, `test_map`, the coverage map and observed red all use this one definition |
| Existing tests only grow | `test-preservation` hook (the `append_file` tool is the safe way to add a `describe` block): pre-existing test cases are append-only (no deleting, skipping, rewriting or mocking them out, nothing hoisted into them), their hooks, imports and top-level helpers stay as they were, new code in that file changes no shared state, and pre-existing test helpers are read-only. A brownfield task with `allowBreaking: true` may change existing bodies, but still not remove, rename or skip a case |
| Executed agent code is confined | `src/core/sandbox.ts`: tests, contract extraction and probes run under the OS sandbox (API root read-only, per-call temp dir, loopback only); `run.json` records `isolation` |
| Plugins are trusted code | `src/core/registry.ts`: a plugin is executed when imported (like an eslint or Vitest plugin), so the registry refuses any plugin dir inside the worktree dir, the only place agent output persists, without importing it |
| The harness ships, the agent never does | `harness ship` / `--ship`: re-runs every gate fresh, stages only the API root, scans for secrets, commits as `sf-harness`, pushes the feature branch (never a protected one, never `--force`), opens the PR with `gh` |
| Cheapest mechanism wins | checks > hooks > rules index (one line per rule) > tools > prompt. The standards text costs zero tokens until `fetch_standard` asks for it |
| Honesty boundary | a skipped check is `UNPROVEN`, an empty standards rule is `unproven 0/0`, `n/a` is never counted as green. `run.json` lists proven / failed / unproven / n/a / what a human must verify |

## Our own addition: Contract Lock

The brief does not ask for it. We added it so that brownfield changes cannot silently break
clients: `plugins/lib/contract.ts` extracts the public contract (every route, plus the
JSON Schemas of params/query/body/headers and of each 2xx response, generated from the
actual Zod schemas at runtime) from both the base commit and the worktree, then diffs them.
Removed routes, new required request fields, narrowed enums, removed or now-optional
response fields, changed types, request constraints that narrow (bounds, lengths, pattern, format,
multipleOf, a closed object, a changed default) or response constraints that widen, and a new 4xx
on an existing endpoint are **breaking**. A schema change JSON Schema cannot show (`.refine`),
validation that moves out of sight and a POST/PUT/PATCH body read without an extractable schema
are UNPROVEN, never "preserved". The `contract-lock` gate refuses finish
and ship unless the task sets `allowBreaking: true`. The model can check itself first with
the `contract_diff` tool. Evidence: the scripted run `projects-change-scripted-…172537`
(script `projects-breaking.json`) appends one red test, leaves every existing test untouched,
and makes `POST /v1/projects` stop accepting `status: "archived"`. No existing test pins that,
so tests, observed red and standards are all green; contract-lock alone refuses it (1
breaking change). Against a real model, `runs/real-model/projects-change-openai-…190756`
(`gpt-5.4-mini`) overwrote three source files with a placeholder, and contract-lock failed the run
with 4 breaking changes (4 → 0 endpoints). The real brownfield DONE run (`gpt-5.4`) passed it
with 2 additive changes.

## Evidence in this repository

### Real models: two DONE runs (graded evidence)

Both ran on the **official OpenAI API** with the openai driver (Chat Completions wire format).
Their evidence is at the top level of `runs/` and `tokens/`:

| run | task | model | turns | result | tokens actual / baseline (reduction) | approx. cost |
|---|---|---|---|---|---|---|
| `users-api-openai-20261003-185149` | greenfield `users-api` | `gpt-5.4-mini` | 19 | **DONE**: observed red (red → green, red again on revert), 28/28 tests, standards 100%, scope pass | 90,195 / 397,317 (**77.3%**) | ~USD 0.08 |
| `projects-change-openai-20261003-190927` | brownfield `projects-change` | `gpt-5.4` | 12 | **DONE**: contract-lock pass (2 additive), observed red (3 source files + revert check), 21/21 tests, standards 100% | 50,550 / 268,600 (**81.2%**) | ~USD 0.15 |

Each run directory holds `run.json`, `events.jsonl`, `transcript.jsonl`, `gates.json`,
`standards.txt` and `logs/`, plus these outputs:
- `cli-output.txt`: the run's summary;
- `ship-dry-run.txt`: `harness ship <id> --dry-run`, which re-ran every gate fresh on the final
  code (`secrets` included) and found all green. It staged, committed and pushed nothing;
- `check-generated-api.txt` (greenfield) and `check-existing-api.txt` (brownfield):
  `harness check --api` on the result, verdict 100%.

The brownfield run used the final code. The greenfield run predates F11 and F12 (`append_file`
and the working set's full-text window). The costs are the operator's approximate figures. The
harness records tokens, not prices.

**Tokens, honestly: the >90% target is not met on real runs.**

| runs | turns | reduction |
|---|---|---|
| the two DONE runs above | 19, 12 | 77.3%, 81.2% |
| the 8 real runs of 40–60 turns that did not finish (`runs/real-model/`; shorter ones were lower) | 40–60 | 84.8–88.1% |
| scripted demo runs (below) | 9 | 89.2%, 85.4% |
| 40-turn simulation, shipped policy | 40 | 86.3% |
| 40-turn simulation, compaction only | 40 | **90.7%** |

The simulation numbers come from `npx vitest run test/token-efficiency/long-run.test.ts
--reporter=verbose`. There are two reasons for the gap:
- **A fixed per-turn floor.** System prompt, tool schemas and brief are resent every turn: 2,465
  tokens on turn 1 of the greenfield run, against an 11,075-token baseline. The ratio rises with
  run length, so runs of 12–19 turns stay well below it.
- **Deliberate anti-thrashing context.** The working set of recently read files, the scaffold API
  in the brief and two verbatim turns cost tokens on every request. Real models proved them
  necessary: without them they re-read files in loops (F1, F6, F12).

Compaction alone reaches 90.7% only in the simulation, whose scripted model never re-reads.
[docs/design.md](docs/design.md) §3 has the per-mechanism ladder.

### Real models: fifteen runs that did not reach DONE

`runs/real-model/` keeps them with their token reports and CLI output:
- **seven on the official OpenAI API:** six with `gpt-5.4-mini` and one with `gpt-6-luna` in
  compat mode (`gpt-5.4` ran only the brownfield DONE run above);
- **eight on free tiers:** OpenRouter with both drivers, and Google AI Studio's
  OpenAI-compatible endpoint with Gemini 3 Flash, Gemini 3.5 Flash-Lite and Gemma 4.

Each exposed a defect. Every defect is now fixed and tested offline (F13 was also caught by
the gates when it happened):

| # | finding | fix |
|---|---|---|
| F1 | models re-read files in a loop once a read folded into the digest | working set of file skeletons, repeated-read pointer |
| F2 | Gemini 3 400s unless its tool-call thought signatures come back | openai driver replays tool-call extras |
| F3 | per-minute quota errors ended runs | wait out a stated wait of 120 s or less |
| F4 | a suite load error named no location | in-project frame and code line in the summary |
| F5 | SIGTERM left no evidence | SIGTERM is a graceful stop |
| F6 | models read every scaffold file up front | scaffold API in the greenfield brief |
| F7 | `gpt-6-luna` rejects function tools with reasoning on Chat Completions | retry once with `reasoning_effort: 'none'` (compat) |
| F8 | a module-level store leaked state across `createApp()` calls | brief: every `createApp()` starts with empty state |
| F9 | a real red was rejected for the standard supertest idiom (`describe`-scoped `app`, `.expect()` chains) | test map follows describe-scoped variables and supertest chains |
| F10 | finish refused 7 times: the red case was edited before it went green | an edited case counts through the revert check (differential proof) |
| F11 | 7 whole-file rewrites of a pre-existing test file, all blocked | `append_file` tool, named in the block message |
| F12 | a read loop over 3 related files whose folded reads showed only skeletons | latest folded reads stay in full for 3 turns (6,000 characters) |
| F13 | the model replaced 3 source files with the history placeholder `<omitted N chars>` (4 → 0 endpoints) | **contract-lock failed the run** when it happened; now also refused at write time by the new `elision-guard` hook (`test/plugins/elision-guard.test.ts`) |

In addition, the token report no longer names a counter that did not produce its numbers: a
chars/4 fallback is labelled as such.

**Model agnosticism, as proven for real:**
- **openai driver:** official OpenAI (DONE on both tasks), Google AI Studio's
  OpenAI-compatible endpoint and OpenRouter.
- **claude driver:** only OpenRouter's Anthropic-compatible endpoint, with a smoke call and two
  partial free-model runs. In the smoke call the proxy rejected the driver's optional parameters
  with a 400 and the driver switched to compat mode. The proxy has no `count_tokens`, so the runs'
  counts were chars/4 estimates.

The claude driver against `api.anthropic.com` needs an Anthropic key: prompt caching, adaptive
thinking, server-side token counting, a DONE run, and a real `harness agnostic <claudeRun>
<openaiRun>`. `runs/real-model/README.md` has the per-run table (provider, driver and wire,
model, outcome, turns, tokens, cost, finding), the secret scan, and the file and test behind
each claim.

### Offline scripted runs (harness demos, not model evidence)

The runs whose ids contain `scripted` replay fixed JSON scripts through the real loop, hooks,
gates and checks. They prove the machinery end to end without keys.

| run | what it shows |
|---|---|
| `users-api-scripted-…172502` | greenfield, all gates green (observed red: 4 source files red → green, red again with the original source), 54/54 tests, standards 100%, 89.2% token reduction over 9 turns |
| `users-api-scripted-…172549` | same script in `--baseline` mode: 178,301 input tokens, equal turn for turn to the greenfield run's shadow baseline; `tokens/compare-…json` measures 89.2% |
| `projects-change-scripted-…172515` | brownfield, contract-lock pass (2 additive changes, via runtime), 25/25 tests, standards 100%, 85.4% token reduction |
| `users-api-scripted-…172529` | cheating script: all 4 write attempts blocked by the named hook (`observed-red`, `path-guard` ×2, `unsafe-code-guard`), finish refused |
| `projects-change-scripted-…172537` | breaking change with green tests (18/18) and a valid observed red: contract-lock fail (1 breaking: `POST /v1/projects body.status enum loses values: "archived"`), finish refused |

`runs/users-api-scripted-…172502/` also holds `check-generated-api.txt` and `ship-dry-run.txt`.
These runs were made against a throwaway target repository with `--repo`. They predate the
working set, the scaffold API and F7–F12. Re-run on the current code, the same scripts give the
same verdicts and gate results. They cost more tokens, because the greenfield brief now carries the
scaffold API and every request carries the `append_file` schema and the working set: greenfield 27,035
against 185,015 (85.4%, and `tokens compare` against a fresh `--baseline` run also gives 85.4%),
brownfield 23,231 against 145,437 (84.0%). Every scripted `run.json`, and that of every
official-OpenAI run except `gpt-6-luna`, records `"isolation": { "mode": "auto", "mechanism":
"sandbox-exec", … }`. The free-tier runs and the `gpt-6-luna` run used a snapshot of `cb49d13`,
which had no OS sandbox yet.

Run the harness's own suite with `npm run verify` (strict `tsc`, then the Vitest suite,
including end-to-end runs in throwaway git repositories). Its budget and extensibility
assertions cover the shipped plugins and the examples only, so it stays green after you
drop your own tool, ORM validator or lint rule into `plugins/`.

## Generality and hardening update (4 Oct)

After an audit showed the harness was fitted to its own template and sample, these landed:
- **Task files:** a lenient, deterministic front end accepts other task-file shapes, including plain-English briefs (`docs/task-format.md`, `harness task check <file>`). Provider keys are still rejected.
- **App discovery:** probes find the app in any Express layout (factory, exported or default app, or an entry file that calls `listen()`), not only `src/app.ts#createApp`.
- **Static analyzers:** judge meaning rather than template syntax (constant paths, middleware validation, status codes by type, problem classes by behaviour).
- **tsc-strict:** forces every strict sub-flag and type-checks every TypeScript file.
- **Contract Lock:** diffs constraint keywords.
- **Brownfield standards:** compared to a baseline taken at run start, so pre-existing violations in untouched files no longer deadlock a run.
- **Sandbox:** agent code gets a read fence and an environment allow-list.
- **Target profile:** the harness reads the target's own layout and toolchain at preflight (source and test roots, import aliases, vitest / jest 29+ / node:test with the target's own binary first, where dependencies resolve from, the Zod major), prints it before the first model turn and records it in `run.json`; checks, contract extraction, app discovery, hooks and the default brownfield scope follow it. An unsupported framework or runner is UNPROVEN at preflight.

**Known gaps:**
- tsc-strict now type-checks in-process, outside the read fence.
- Nothing yet compares the API against the resources and operations the task listed, so DONE can be reached with a resource missing.
- The jest adapter is verified on recorded `--json` reports only (jest is not installed in the harness); a target without jest in its own `node_modules` is UNPROVEN at preflight.
- Not done yet: an honest real `--baseline` run, and generalised hooks.
- The DONE evidence runs predate these changes.
