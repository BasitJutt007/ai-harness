# Run history

Every real and scripted run in this directory, in the order the harness changed. The README lists only
the runs that make up the deliverables; this file keeps the rest, including every run that did not reach
DONE and why. Runs that exposed a harness defect are in [real-model/](real-model/README.md) with the fix.

## The deliverable runs (final code)

`users-api-openai-20261004-145143` (greenfield, DONE, 14 turns) and `projects-change-openai-20261004-145700`
(brownfield, DONE, 21 turns) ran against a clone of the demo repository and were shipped as
[harness-demo#10](https://github.com/BasitJutt007/harness-demo/pull/10) and
[#11](https://github.com/BasitJutt007/harness-demo/pull/11) after [#9](https://github.com/BasitJutt007/harness-demo/pull/9)
reverted #7 and #8. `users-api-openai-20261004-145009` is the measured `--baseline` run (DONE, 10 turns).
`projects-change-openai-20261004-145143` stopped at turn 8 when the OpenAI account ran out of credits
(NOT DONE, `error`).

## The fail-closed code: DONE on gpt-5.6-luna (not shipped)

The checks and gates are now fail-closed: whatever they do not model is UNPROVEN, never a pass (see
`docs/design.md` §5). Route rules carry every unmodelled construct of a route's chain, the running app's
own route listing can withhold a pass, observed-red proves each changed file by reverting it alone, and
`npm run audit:mutations` requires that none of 31 mutations of a shipped Users API reads 100%. Both
tasks were run again on `gpt-5.6-luna` (compat: reasoning off). In both DONE `run.json` files every plugin
fingerprint (55) and every `src/core` file hash (31) matches the committed code.

| run | task | turns | result |
|---|---|---|---|
| `users-api-openai-20261004-144318` | greenfield | 17 | **DONE**: spec-coverage 18/18, 32/32 tests, standards 100%, each changed file proven by its own revert; the app's 5 routes match the static table (`problem-json-probe.txt`); POST and PATCH replayed (`replay-probe.txt`) |
| `projects-change-openai-20261004-144649` | brownfield | 24 | **DONE** (third attempt): contract-lock pass (2 additive), 20/20 tests, standards 100%, 3 changed files each proven by its own revert |
| `projects-change-openai-20261004-144318` | brownfield | 40 | **NOT DONE** (max_turns): the model's own status-filter pagination test stayed red |
| `projects-change-openai-20261004-144501` | brownfield | 40 | **NOT DONE** (max_turns): the same test red, and `schema.ts` UNPROVEN because no passing case depended on it |

The two NOT DONE attempts are kept as they ended. Runs on earlier versions are kept too
(`users-api-openai-20261004-131536`, `…122310`, `…105936`, `…103506`, `…100537`;
`projects-change-openai-20261004-131725`, `…131536`, `…122152`, `…105814`, `…103359`, `…095618`). None of
these were shipped; the PRs below come from the runs in the next section.

## Earlier code: DONE runs, shipped as #7 and #8 (since reverted by #9)

After an external review (idempotent replay returned updated state; checker bypasses for middleware
responses, mutated bodies, problem bodies without the problem Content-Type, header-only idempotency,
create without Location; cwd-dependent revert proofs; alias imports of test code; enforcement-blind
`agnostic`; a lenient brownfield policy), the code was fixed and run again on the official OpenAI API
with the openai driver. Both runs below used the code of that time: every plugin fingerprint matched it.

| run | task | model | turns | result |
|---|---|---|---|---|
| `users-api-openai-20261004-084807` | greenfield | `gpt-5.4` | 31 | **DONE**: spec-coverage 18/18 (including replay after an update), 37/37 tests, standards 100%, observed red + revert check in identical contexts. Shipped as [harness-demo#7](https://github.com/BasitJutt007/harness-demo/pull/7) |
| `projects-change-openai-20261004-085129` | brownfield | `gpt-5.6-luna` (compat) | 20 | **DONE**: contract-lock pass (2 additive), 22/22 tests, standards 100%, observed red on 3 source files. Shipped as [harness-demo#8](https://github.com/BasitJutt007/harness-demo/pull/8) |

Also DONE with that code: `projects-change-openai-20261004-081959` (brownfield, Luna, 29 turns)
and `users-api-openai-20261004-073321` (greenfield, Luna, a few commits earlier; re-gated with the final
code in `ship-dry-run-final-code.txt`: all green).

**Not DONE, kept in `runs/real-model/`:** on that code (or one commit before) greenfield missed
5 times on `gpt-5.6-luna` and once on `gpt-5.4` (a list endpoint answering 422 without `limit`, failing
agent tests, a permissive body schema, helpers the checker could not follow yet); brownfield missed 5
times on `gpt-5.6-luna` (mostly the shared-state trap below; once every gate was green but the model
never called finish, which is now DONE by rule). The harness refused every incomplete result. The models,
not the harness, are the bottleneck: Luna finishes brownfield about half the time and greenfield rarely.

## Earlier runs on 4 Oct (official OpenAI API, openai driver)

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

**The two governed APIs** were at that time the commits shipped as #7 and #8; they have since been replaced by the final-code runs shipped as #10 and #11 (see `governed/README.md`).

**Pull requests opened by the harness** (`harness ship`, every gate re-run fresh first, pushed to a
feature branch, opened with `gh`), on the demo repository whose `main` holds the sample API:
- [BasitJutt007/harness-demo#1](https://github.com/BasitJutt007/harness-demo/pull/1) (merged, then reverted by #5): greenfield, run `users-api-openai-20261004-045649`
- [BasitJutt007/harness-demo#2](https://github.com/BasitJutt007/harness-demo/pull/2) (merged, then reverted by #5): brownfield, run `projects-change-openai-20261004-052623`
- [BasitJutt007/harness-demo#3](https://github.com/BasitJutt007/harness-demo/pull/3) (merged, reverted by #6): greenfield, run `users-api-openai-20261004-055546`
- [BasitJutt007/harness-demo#4](https://github.com/BasitJutt007/harness-demo/pull/4) (merged, reverted by #6): brownfield, run `projects-change-openai-20261004-055658`

#3 and #4 were opened after #1 and #2 had been merged and were built on the same base.
[#5](https://github.com/BasitJutt007/harness-demo/pull/5) reverts #1 and #2 (two revert commits, no
history rewrite); #3 and #4 were then merged. Those four came from runs made before the external
review's fixes (the Users API carried the scaffold's old idempotency helper).
[#6](https://github.com/BasitJutt007/harness-demo/pull/6) reverts #3 and #4 and gives the sample the
fixed idempotency helper; [#7](https://github.com/BasitJutt007/harness-demo/pull/7) and
[#8](https://github.com/BasitJutt007/harness-demo/pull/8) are the final-code runs above. Merged in the
order #6, #7, #8, `main` then held what that code shipped; #9 reverts #7 and #8 for #10 and #11.

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

## Earlier real runs (3 Oct code)

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

## Offline scripted runs (harness demos, not model evidence)

The runs whose ids contain `scripted` replay fixed JSON scripts through the real loop, hooks,
gates and checks (recorded on 3 Oct code; `test/e2e/` re-runs the same scripts on the current
code on every `npm run verify`):

| run | what it shows |
|---|---|
| `users-api-scripted-…172502` | greenfield, all gates green |
| `projects-change-scripted-…172515` | brownfield, contract-lock pass (2 additive changes) |
| `users-api-scripted-…172529` | cheating script: every forbidden write blocked by the named hook, finish refused |
| `projects-change-scripted-…172537` | breaking change with green tests: contract-lock fail, finish refused |
