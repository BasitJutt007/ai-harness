# Design: the harness after assignments 01 and 02

One document for the whole structure: what assignment 01 built, what assignment 02 added on top, and
what was actually run. The 01 design note ([design.md](design.md)) still holds for the parts it covers;
this note is the map of both.

## 1. What it is

A **harness, not an agent**. A model writes the code; the harness decides what it may touch, checks
every tool call as it happens, and only the harness can say DONE and open the pull request. Since 02,
nothing starts without a written problem and the stakeholder's typed yes, and nothing is finished until
the harness has measured that the problem moved.

```
                 assignment 02 wraps the work                       assignment 01 governs the run
  contract -> propose (before) -> typed yes -> [ task -> worktree -> model loop -> hooks -> gates -> ship ] -> human merge -> close (after)
```

## 2. Repository layout

| Path | What lives there |
|---|---|
| `bin/harness.mjs` | The CLI: `run`, `check`, `item new/propose/reply/close/status`, `doctor`, `agnostic` |
| `src/core/` | **The core**: the loop (`loop.ts`), run orchestration (`run.ts`), hook bus (`hooks.ts`), gate runner (`gates.ts`), items and ledger (`items.ts`, `item-cli.ts`, `close.ts`), metric readings (`measure.ts`), sandbox, spend cap, ship |
| `plugins/hooks/` | Checks on every tool call; they can block it |
| `plugins/gates/` | Checks at the end of a run; all must pass for DONE |
| `plugins/checks/` | Standards rules the `standards` gate runs (per stack) |
| `plugins/tools/` | What the model can call: read, write, edit, run tests, plan, finish |
| `plugins/drivers/` | Provider adapters: `openai`, `claude`, and `scripted` (offline replay) |
| `docs/contracts/`, `items/` | One contract and one hash-chained ledger per backlog item |
| `metrics/` | The scripts that turn each item's problem into a number |
| `tasks/` | Task files (what to change, where, limits) |
| `runs/`, `tokens/` | Evidence of every run: verdict, gates, transcript, logs, token report |
| `templates/`, `samples/` | The greenfield scaffold (Express + Zod) and the sample existing API |

Everything outside `src/core/` is a plugin: dropping a file into `plugins/` registers it.

## 3. Assignment 01: governing one run

### The run, step by step

1. **Read the task and the target.** The task file is normalized (aliases, free text) and the target
   repository is profiled: stack, test runner, source and test roots.
2. **Fresh worktree.** Each run gets its own git worktree under `.harness/worktrees/`; the user's
   checkout is never touched.
3. **Model loop.** The driver sends the brief and the tools; the model reads, writes and runs tests.
   Context is fetched just in time and old turns are compacted to save tokens.
4. **Hooks on every call.** A blocked call returns the reason to the model as an error.
5. **Fresh gates at the end.** Every gate re-runs from scratch; the model's own claims count for nothing.
6. **Ship.** Only after every gate is green, the harness (never the model) commits, pushes a feature
   branch and opens the PR. A human merges.

### Hooks (per tool call)

| Hook | Blocks |
|---|---|
| `path-guard` | Writes outside the task scope, and to config, lockfiles, dot-files, env, git internals |
| `observed-red` | Editing a source file before a test that uses it has been seen failing |
| `secret-guard` | Key-like secrets in written content |
| `unsafe-code-guard` | `any`, non-null assertions, `@ts-ignore` and friends |
| `dependency-policy` | Imports of packages the API does not declare (nothing can be installed during a run) |
| `source-boundary` | Source files that import test code, reach outside the API's source roots, or detect the test runner |
| `elision-guard` | Writes that leave a placeholder or gut an existing source file |
| `test-preservation` | Removing, renaming, disabling or rewriting existing test cases |
| `typecheck-feedback` | Never blocks: reports type errors of the file just written |

### Gates (end of run)

| Gate | Passes when |
|---|---|
| `tests-green` | The whole suite passes in a fresh run |
| `observed-red` | Each changed file has a case seen red, now green, and red again with that file alone reverted |
| `scope`, `orphans` | Only allowed files changed; every new file is used |
| `standards` | The stack's rules hold (REST conventions, strict TypeScript, Zod at the boundary, problem+json errors) |
| `contract-lock` | No breaking change to the public API (brownfield) |
| `spec-coverage` | The new API answers the task's endpoints (greenfield) |
| `diff-budget` | The change is at most 400 changed lines |
| `secrets` | Nothing secret is shipped |

**Verdicts:** DONE (every required gate passed), NOT DONE (a gate failed, named), UNPROVEN (something
could not be checked; never counted as green).

**Our own 01 addition: Contract Lock** (`plugins/lib/contract.ts`): extracts the routes and the JSON
Schemas of each request and response from the real Zod schemas at the base commit and in the worktree,
and refuses any breaking difference.

## 4. Assignment 02: the work around the run

### The item lifecycle

| Step | Command | What the harness records |
|---|---|---|
| Contract | `item new <slug>` | `docs/contracts/<slug>.md`: problem, owner, stakeholder, repo, base, commit title, metric, measure, WHEN/THEN scenarios, not included |
| Propose | `item propose <slug> --repo <clone>` | Runs the Measure script at `origin/<base>` (twice, sandboxed): the **before** value |
| Yes | `item reply <slug>` | Shows the proposed contract, then the stakeholder's reply typed at a terminal |
| Run | `run tasks/<slug>.md --repo <clone> --ship` | The governed run of section 3, bound to the item |
| Merge | (a person, on GitHub) | |
| Close | `item close <slug> --repo <clone>` | Checks the PR was merged by a person, reads the metric at the merge commit: the **after** value |

The ledger (`items/<slug>/ledger.jsonl`) gets one line per event; each line carries its own hash and the
previous line's, so a hand edit breaks the chain and every verdict that needs the ledger becomes UNPROVEN.

### The three briefing gates

| Gate | Blocks | Where |
|---|---|---|
| Problem statement | Any edit until the contract names every required field; a run without one is refused before the first model turn | `plugins/hooks/problem-gate.ts`, `bindItem` in `src/core/run.ts` |
| Human yes | Any edit and `finish` until a plain yes is typed at a terminal after the proposal of that exact text; piped input, model text, tool or hook output never count | `plugins/hooks/contract-gate.ts`, `plugins/gates/stakeholder-yes.ts` |
| Outcome | Closing an item until a person merged the harness-opened PR and the harness read the metric after the merge; no flag accepts a typed value | `src/core/close.ts` |

### Added from my own workflow

| Mechanism | Why |
|---|---|
| Stack profiles: NestJS + Prisma + Jest, React + Vite | The repositories I work in, each with its own checks |
| `route-lock`, `nest-route-guard` | Removed routes the frontends still call; routes without the access check |
| `repo-typecheck`, `repo-lint`, `vite-build` | A type check over zero files, lint that skips TypeScript, a build broken only at deploy |
| `prisma-unbounded` | Queries without a bound |
| `diff-budget` | Large PRs that draw review round-trips |
| Commit and PR text from the contract | Commits and PRs that say nothing |
| Model allowlist + $2 cap per run | Cost: only `gpt-5.6-luna` and `claude-haiku-4-5-20251001`; a request that could pass the cap is never sent |

### Added while running a real item (8 November)

| Mechanism | The gap it closes |
|---|---|
| `item-metric` gate (required) | A run said DONE while the item's own metric had not moved. Now the harness reads the metric on the run's tree before DONE |
| `measured` task field | A React screen no unit test can load could not be edited under "test first". Its red is now the harness's before value, and `item-metric` reverts each such file alone and re-reads the metric |
| `read-loop-guard` hook | A model re-read one long file 45 times instead of editing it |
| `edit_file` indentation | Edits failed on a one-space indentation slip; one uniform shift matching one place is now accepted |
| `item reply` summary | The reply prompt now shows what is being approved |

## 5. What was run

### Assignment 01 (3-4 October, on `harness-demo`)

About 40 runs while building, all in `runs/` with their verdicts ([runs/README.md](../runs/README.md)).
The two that shipped: `users-api` (greenfield) as harness-demo#10 and `projects-change` (brownfield) as
harness-demo#11, both DONE with `gpt-5.6-luna`, standards 100%. Scripted cheat runs (a test edited to
pass, a breaking change) were refused by `observed-red`, `standards` and `contract-lock`. Token report:
67.2% fewer input tokens per turn than a real `--baseline` run.

### Assignment 02 (8 November)

Public items, on `harness-demo` at `rubric-01` (the base before the 01 PRs):

"NOT DONE (correct)" means the model said it had finished, but a gate found the work short, so the
harness refused it and opened no PR: the refusal is the harness working, not the harness failing.

| Item | Driver, model | Verdict | Refused by | Spend |
|---|---|---|---|---|
| projects-change | openai, gpt-5.6-luna | **DONE**, shipped as harness-demo#12 | | $0.07 |
| health-route | openai, gpt-5.6-luna | NOT DONE (correct) | standards (REST rules) | $0.08 |
| users-api | openai, gpt-5.6-luna | NOT DONE (correct) | standards | $0.37 |
| users-api | claude, claude-haiku-4-5 | NOT DONE (correct) | standards, tests-green | $0.48 |
| labels | openai, gpt-5.6-luna | NOT DONE (correct) | standards | $0.20 |
| labels | claude, claude-haiku-4-5 (40, then 60 turns) | NOT DONE (correct) | observed-red, standards, tests-green | $0.47, $0.68 |

`projects-change` then went the whole way: harness-demo#12 merged by a person, and `item close` read
**before 1, after 0** at the merge commit. It is the item with every record the brief asks for.

A real item on a work repository (a login email step in a React app: untrimmed input sent, malformed
addresses let through, a button left loading, the wrong address shown) ran privately with
claude-haiku-4-5. Its metric (cases mishandled, of 4) read 4 at proposal. Six runs, about $2.65:

| Run | Verdict | What it showed |
|---|---|---|
| 1 | DONE, wrongly | A tested helper never wired into the screen; metric still 4. Led to `item-metric` |
| 2 | NOT DONE (correct) | 45 re-reads of one file. Led to `read-loop-guard` |
| 3 | NOT DONE (correct) | "Test first" made the screen impossible to edit. Led to `measured` files |
| 4, 5 | NOT DONE (correct) | Metric down to 1; stuck on a one-space indentation slip. Led to the `edit_file` fix |
| 6 | **DONE** | Metric 4 to 0, the screen's change proven by its own revert, no new type errors |

It was applied to a local branch for review and verified by signing in through the changed screen. It
was not shipped: the code belongs to the company, and its contract, ledger and runs stay outside this
repository.

### Verification at submission

`npm run typecheck` clean, `npm test` 2092/2092, `npm run audit:mutations` 86/86 (each gate's mutation
is caught). Submission tagged `assignment-02` on `main`.

## 6. What it does not prove

- That the model's tests test the intended behaviour (any failing, non-constant assertion counts as red).
- Performance, security and concurrency beyond what the tests exercise.
- Which way a metric should move, and by how much: `item-metric` checks that it moved; the human
  judges the size at close.
- Behaviour changes that keep the API's shape (Contract Lock compares schemas and status codes).

Each run's `run.json` lists these under "human must verify".
