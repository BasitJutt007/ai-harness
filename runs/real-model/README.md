# Real-model runs that did not reach DONE (2026-10-03 and 2026-10-04)

This directory holds **eighteen real-model runs that did not reach `verdict DONE`**:
- 3 Oct, eight on free tiers (OpenRouter, Google AI Studio), which exposed F1–F6;
- 3 Oct, seven on the official OpenAI API, which exposed F7–F13;
- 4 Oct, three brownfield runs on the official OpenAI API, on the current code.

Two more 4 Oct runs that did not reach DONE sit at the top level of `runs/` and `tokens/` because
the README cites them (`users-api-openai-20261004-045424`, the normal side of the measured token
comparison, and `projects-change-openai-20261004-050613`); they are in the 4 Oct table below too.
The real runs that **did** reach DONE are at the top level, all on the official OpenAI API with the
openai driver:

| run id (top level) | task | model | turns | result | tokens actual / shadow baseline (reduction) |
|---|---|---|---|---|---|
| `users-api-openai-20261003-185149` | greenfield `users-api` | `gpt-5.4-mini` | 19 | DONE on 3 Oct code: 28/28 tests, observed red with revert check, standards 100% | 90,195 / 397,317 (77.3%) |
| `projects-change-openai-20261003-190927` | brownfield `projects-change` | `gpt-5.4` | 12 | DONE on 3 Oct code: contract-lock pass (2 additive), observed red 3 files + revert check, 21/21 tests, standards 100% | 50,550 / 268,600 (81.2%) |
| `users-api-openai-20261004-045649` | greenfield `users-api` | `gpt-5.4` | 23 | DONE: 6 gates pass, contract-lock n/a (spec-coverage 17/17, 41/41 tests, standards 100%) | 150,910 / 576,904 (73.8%) |
| `users-api-openai-20261004-045825` | greenfield `users-api`, `--baseline` | `gpt-5.4-mini` | 16 | DONE in baseline mode (31/31 tests, spec-coverage 17/17, standards 100%) | 277,791 sent (measured baseline: no shadow) |

The runs in this directory are kept because each one exposed a defect, or showed a gate refusing
real model output. They are not evidence of a finished task.

## Layout

```
<runId>/                 run.json, events.jsonl, transcript.jsonl, state.json
                         (+ gates.json, standards.txt, logs/ when the run ended on its own;
                            + initial/ (run-start sources for the revert check) on the official
                            OpenAI runs except …183608, whose snapshot had no revert check;
                            + task.normalized.json on the 4 Oct runs)
<runId>/tokens.json      the run's token report (written by the harness as tokens/<runId>.json),
                         for every run that wrote one
<runId>/cli-output.txt   the CLI output of the run (3 Oct official OpenAI runs only)
cli-output/              the CLI output of the eight free-tier runs (run-*.log, run2-*.log)
provider-smoke.txt       one complete() + countTokens() call per driver through OpenRouter
```

The absolute paths inside `run.json`, the logs and the CLI output are the paths at run time
(scratch snapshots, `.harness/worktrees/…`, `.harness/tmp/…`). They are left as recorded.
The worktrees of the official OpenAI runs stay under the gitignored `.harness/worktrees/`.

## Secret scan

Re-run on 2026-10-04 over every file under `runs/` and `tokens/` (1,054 files: this directory,
every top-level run and token report, the 4 Oct evidence included) for the key prefixes `sk-proj-`,
`sk-or-v1`, `AQ.Ab8`, `xpl_`, `crsr_`, `sk-ant` and `ghp_`: **the only file containing any of them
is this README** (the pattern names above). `AIza`, `xoxb-`, `xoxp-`, `Bearer `, `AKIA` and `sk-`
followed by 20+ key characters occur in no other file either. Nothing was redacted. A
classification of every token-like string of 30+ characters found only these kinds:
- sha256 plugin fingerprints, git SHAs and other hex;
- UUIDs that the agent's tests and the probes use as resource ids;
- tool-call ids (`chatcmpl-…`, `call_…`) and OpenRouter request ids (`gen-…`): the only mixed-case
  random-looking strings;
- the probe's per-run canary `harness-probe-secret-<12 hex>`, a random marker the probe checks a
  500 does not leak. Despite its name, it is not a credential;
- file paths, code identifiers, run ids and `--strict…` compiler flag names;
- 84 Gemini `thought_signature` values inside the openai driver's `toolCallExtras` opaque parts
  (free-tier Google runs). These are the model's opaque reasoning signatures that F2 is about.

Keys came from the environment and were never written to disk. Outside `runs/` and `tokens/`, the
same prefixes and `AKIA` occur only in the detector patterns (`plugins/lib/secrets.ts`,
`src/core/ship.ts`) and in the harness's own tests: patterns, values built at run time, and three
canary `AKIA…` AWS key ids in the env red-team fixtures (`test/plugins/redteam-exec.test.ts`,
`test/sandbox/env.test.ts`, `test/sandbox/helpers.ts`), next to values such as
`postgres://canary:canary@127.0.0.1:5/canary`.

## Runs

`turns` counts completed turns in `transcript.jsonl`. The tokens column gives actual, baseline
and reduction against the per-turn **shadow** baseline (an estimate, never sent; docs/design.md
§3). All official OpenAI runs count with local o200k; their `tokens.json` also holds the provider's
own count (`provider_reported_input_tokens`). The harness records tokens, not prices.

### 4 Oct: official OpenAI API, current code (openai driver, Chat Completions)

| run id | task | model | turns (limit) | outcome | tokens actual / shadow baseline (reduction) | finding |
|---|---|---|---|---|---|---|
| `users-api-openai-20261004-045424` (top level) | greenfield | `gpt-5.4-mini` | 60 (60, task) | `max_turns`, NOT DONE. Finish refused at turns 12 and 19 (tests-green: 1 of 31 failed); from turn 20 the model worked on a failing case of its own test file and never called finish again. Its last edit (turn 60) made the suite pass, so the fresh final gates were all green (31/31 tests, spec-coverage 17/17, standards 100%), but DONE needs an accepted finish | 387,022 / 1,568,197 (75.3%) | a model can stop asking to finish; the normal side of the measured token comparison (−39.3% per run) |
| `real-model/projects-change-openai-20261004-045936` | brownfield | `gpt-5.4` | 40 (40, task) | `max_turns`, NOT DONE; finish never called. tests-green fail: 1 of 23 (`filters by status before paginating…`: length 1 expected, 2 found); contract-lock pass (2 additive), observed-red pass, standards 100% | 212,646 / 706,012 (69.9%) | shared module-level state (below) |
| `real-model/projects-change-openai-20261004-050115` | brownfield | `gpt-5.4` | 40 (40, task) | `max_turns`, NOT DONE; finish never called. tests-green fail: 1 of 23 (`applies the status filter before cursor pagination`: length 3 expected, 5 found); contract-lock pass (2 additive), observed-red pass, standards 100% | 203,091 / 831,518 (75.6%) | shared module-level state |
| `real-model/projects-change-openai-20261004-050306` | brownfield | `gpt-5.6-luna` | 20 (40, task) | finish **accepted** at turn 20 (contract-lock 2 additive, observed red with revert check, 19/19 tests, standards 100%); stopped by the operator while the fresh final gates ran, so `run.json` stays `finalizing` with no verdict, `gates.json` or token report. Whether the driver switched to compat mode is not recorded (`run.json` was never finalised) | 76,908 / 259,024 (70.3%), summed from the transcript | none; not counted as DONE |
| `projects-change-openai-20261004-050613` (top level) | brownfield | `gpt-5.6-luna (compat)` | 40 (40, task) | `max_turns`, NOT DONE; finish never called. tests-green fail: 1 of 21 (`filters by status and paginates the filtered set`: 4 items where 3 were expected); contract-lock pass (2 additive), observed-red pass, standards 100% | 203,685 / 720,162 (71.7%) | shared module-level state |

**Shared module-level state.** The sample API (`samples/existing-api`) keeps its projects in a
module-level `Map` (`src/modules/projects/store.ts`), so every test in a file shares one store. In
the three failed brownfield runs the model wrote exact-count assertions that fail once earlier tests
in the same file have created matching projects, then spent the rest of its turns (from turn 7–14
to 40) on that one failing case without calling finish. tests-green refused DONE each time. The
committed harness has no fix for this yet: nothing tells the model that a case depends on test
order.

### 3 Oct: official OpenAI API (openai driver, Chat Completions)

The harness was the working tree of `feat/typescript-api-harness`. Each fix landed after the run
that exposed it and before the next run (file mtimes, UTC: F8 `src/core/prompt.ts` 18:41, F9
`src/core/testmap.ts` 18:44, F10 `plugins/gates/observed-red.ts` 18:48, F11
`plugins/tools/append_file.ts` 18:57 and the hooks 18:55, F12 `src/core/context.ts` 19:02).
`users-api-openai-20261003-183608` instead ran on a snapshot of `cb49d13` plus the free-tier
fixes and F7. That snapshot had no OS sandbox yet, so its `run.json` has no `isolation`.

| run id | model | harness | turns | outcome | tokens actual / shadow baseline (reduction) | finding |
|---|---|---|---|---|---|---|
| `users-api-openai-20261003-183608` | `gpt-6-luna (compat)` | cb49d13 snapshot + F1–F7 | 50 | `max_turns`; 30/31 tests (pagination saw 6 users, expected 5); standards 83% (routes without `/v1`, 0/5) | 278,960 / 2,011,066 (86.1%) | F7 (F8 visible too) |
| `users-api-openai-20261003-183914` | `gpt-5.4-mini` | working tree before F8 | 60 | `max_turns`; 29/30 tests; standards 86% | 346,742 / 2,340,234 (85.2%) | F8 |
| `users-api-openai-20261003-184219` | `gpt-5.4-mini` | + F8 | 43 | `aborted` (SIGINT by the operator); gates not run, reported UNPROVEN | 241,075 / 1,582,497 (84.8%) | F9 |
| `users-api-openai-20261003-184627` | `gpt-5.4-mini` | + F8, F9 | 60 | `max_turns`; finish refused 7 times; 29/29 tests, standards 100%, observed-red fail | 330,915 / 2,310,173 (85.7%) | F10 |
| `projects-change-openai-20261003-185304` | `gpt-5.4-mini` | + F8–F10 | 40 | `max_turns`; 0 files changed; observed-red fail ("no observed red in this run") | 171,861 / 1,445,390 (88.1%) | F11 |
| `projects-change-openai-20261003-190028` | `gpt-5.4-mini` | + F8–F11 | 40 | `max_turns`; 18/21 tests; standards 86% | 180,284 / 1,279,048 (85.9%) | F12 |
| `projects-change-openai-20261003-190756` | `gpt-5.4-mini` | + F8–F12 (3 Oct final code) | 40 | `max_turns`; **contract-lock fail: 4 breaking (4 → 0 endpoints)**; tests failed to load | 147,114 / 1,122,854 (86.9%) | F13 |

### Free tiers (OpenRouter, Google AI Studio)

Every run is the greenfield task on a frozen copy of `cb49d13`, with the free-tier fixes applied
to the snapshot between runs (mtimes, UTC): (a) tool-call extras in `plugins/drivers/openai.ts`
16:56; (b) the working set, (d) the scaffold API and (f) SIGTERM in `src/core/context.ts`,
`prompt.ts`, `run.ts`, `cli.ts` 16:58; (e) error location in `src/core/testing.ts` 17:09; (c) the
repeated-read pointer and (g) rate-limit waits in `src/core/loop.ts` 17:23. The second OpenRouter
pair (16:41) ran an earlier working-set draft that was overwritten at 16:58.

| run id | provider | driver / wire | model (free tier) | harness | turns | outcome | tokens actual / baseline (reduction) | counter | finding |
|---|---|---|---|---|---|---|---|---|---|
| `users-api-claude-20261003-163824` | OpenRouter | claude / Messages | `poolside/laguna-s-2.1:free` | cb49d13 | 15 | killed (SIGTERM); `run.json` still `running` | 76,581 / 332,243 (77.0%), from the transcript | chars/4 estimate (note 1) | F1, F5, F6 |
| `users-api-openai-20261003-163826` | OpenRouter | openai / Chat Completions | `poolside/laguna-s-2.1:free` | cb49d13 | 15 | killed (SIGTERM); `running` | 107,004 / 401,959 (73.4%), from the transcript | local o200k | F1, F5, F6 |
| `users-api-claude-20261003-164131` | OpenRouter | claude / Messages | `poolside/laguna-s-2.1:free` | + working-set draft | 7 | killed (SIGTERM); `running` | 39,157 / 103,356 (62.1%), from the transcript | chars/4 estimate | F1, F5 |
| `users-api-openai-20261003-164133` | OpenRouter | openai / Chat Completions | `poolside/laguna-s-2.1:free` | + working-set draft | 12 | killed (SIGTERM); `running` | 109,971 / 291,531 (62.3%), from the transcript | local o200k | F1, F5 |
| `users-api-openai-20261003-165940` | Google AI Studio | openai / Chat Completions | `gemini-3-flash-preview` | + a, b, d, f | 15 | `error`: daily quota (20 requests/day) | 59,594 / 252,991 (76.4%) | local o200k | F2 (fix in use), F3 |
| `users-api-openai-20261003-170624` | Google AI Studio | openai / Chat Completions | `gemini-3.5-flash-lite` | + a, b, d, f | 45 | `max_turns` | 212,363 / 1,417,784 (85.0%) | local o200k | F4, F1 |
| `users-api-openai-20261003-170930` | Google AI Studio | openai / Chat Completions | `gemma-4-31b-it` | + a, b, d, e, f | 7 | `error`: per-minute input-token quota (16,000/min) | 30,104 / 104,650 (71.2%) | local o200k | F3 |
| `users-api-openai-20261003-172357` | Google AI Studio | openai / Chat Completions | `gemma-4-31b-it` | + a–g | 17 | `error`: "Connection error." after 4 attempts | 60,910 / 260,610 (76.6%) | local o200k | none new |

CLI output of the free-tier runs: `run-claude.log` belongs to `…163824`, `run-openai.log` to
`…163826`, `run2-claude.log` to `…164131`, `run2-openai.log` to `…164133`, `run-gemini1.log` to
`…165940`, `run-gemini2.log` to `…170624`, `run-gemma.log` to `…170930`, and `run-gemma2.log` to
`…172357`. The four OpenRouter files are empty: the processes were killed before they printed
a summary (F5).

Notes:
1. On the claude-driver runs, OpenRouter has no `/v1/messages/count_tokens`. Every count got a
   404 and fell back to chars/4 for both the actual and the baseline request (`events.jsonl`,
   every turn). The ratio compares like with like, but the absolute numbers are estimates. At the
   time, `run.json` still said `anthropic messages.countTokens`. The token report now names the
   fallback instead (see "Other fixes").
2. The four OpenRouter runs were killed before they wrote a token report, so their numbers are
   sums of the per-turn `tokens` in `transcript.jsonl`.

## Findings and fixes

| # | finding (run) | fix | test |
|---|---|---|---|
| F1 | once a read folded into the digest, models re-read it in a loop: 121 `read_file` calls on an already-read path across the free-tier transcripts | working set of file skeletons after the digest; repeated-read pointer | `test/core-loop/working-set.test.ts`, `repeat-read.test.ts` |
| F2 | Gemini 3 answers 400 unless each tool call's `extra_content` (thought signature) is echoed back | the openai driver keeps per-call extras as an opaque part and replays them | `test/drivers/openai-extras.test.ts`, `test/live-shape/tool-call-extras.test.ts` |
| F3 | a per-minute 429 ("retry in 37.7s") ended `…170930` once the normal retries ran out | wait out a stated wait of 120 s or less, stop on a longer one | `test/core-loop/rate-limit.test.ts` |
| F4 | `app.use() requires a middleware function` without a location; `…170624` looped to `max_turns` | in-project frame and code line in the load-error summary | `test/core-quality/error-location.test.ts` |
| F5 | SIGTERM-killed runs left `status: running` and no gates or token report | SIGTERM is a graceful stop, exit 143 | `test/e2e/sigterm.test.ts` |
| F6 | models read every scaffold file up front | scaffold API in the greenfield brief | `test/core-loop/scaffold-api.test.ts` |
| F7 | `gpt-6-luna` on Chat Completions rejects function tools while reasoning is on (400 naming `reasoning_effort` and `'none'`) | on that 400 the openai driver retries once with `reasoning_effort: 'none'`; the model then reads `gpt-6-luna (compat)` | `test/drivers/openai-reasoning.test.ts` (uses the real 400 text) |
| F8 | the agent's store lived at module level, so state leaked across `createApp()` calls: pagination saw 2 users where 1 was expected (`…183914`, turns 18–58) and 6 where 5 were expected (`…183608`) | the greenfield brief says every `createApp()` starts with empty state (stores built per app, never at module level) | `test/core-loop/scaffold-api.test.ts` ("greenfield brief: per-app state") |
| F9 | a real red was rejected as "do not assert on anything imported from src/" (`…184219`, `run_tests` at turns 7, 15, 28 and 33; the `observed-red` blocks at turns 10, 12 and 18 repeat it) because the test used the standard idiom: `let app` in `describe`, reassigned in `beforeEach`, and supertest `.expect(201)` chains | the test map follows describe-scoped variables into each case, and a supertest `.expect()` chain asserts on its receiver chain | `test/core-quality/testmap.test.ts` |
| F10 | finish was refused 7 times in `…184627`: the model edited its red case before it went green, and only an unchanged case counted ("edited after red") | an edited case now counts through differential execution only: its current body must pass now and fail with the run-start source (revert check). An edit that passes regardless of the source still fails | `test/red-green/red-green.test.ts` |
| F11 | in `…185304` the model rewrote the whole pre-existing `test/projects.test.ts` with `write_file` 7 times (turns 5–30); `test-preservation` blocked every attempt and the repository was left untouched | a new `append_file` tool (governed by the same hooks), and the block message names it as the safe way to add a describe block | `test/plugins/append-file.test.ts` |
| F12 | in `…190028` the model read the same 3 related files 34 times with `read_file` or `outline` (`routes.ts` 13, `store.ts` 12, `schema.ts` 9) because folded reads came back only as skeletons | the working set keeps the latest folded reads in full for 3 turns, within 6,000 characters (`WORKING_SET_FULL_TURNS`, `WORKING_SET_FULL_CHARS`), then falls back to the skeleton | `test/core-loop/working-set.test.ts` |
| F13 | in `…190756` the model overwrote `store.ts`, `routes.ts` and `schema.ts` with the history placeholder `<omitted N chars>` (turns 14, 15, 29, 30), deleting every route | **contract-lock failed the run** (4 breaking: all 4 routes removed), and tsc-strict, tests-green and observed-red failed too; after this run the `elision-guard` hook was added to refuse such writes outright | `test/plugins/elision-guard.test.ts`, `test/contract-ship/diff.test.ts` |

### Other fixes

- **Counter label.** The token report never names a counter that did not produce the numbers.
  When any count fell back to chars/4, `counter` reads
  `chars/4 estimate for N count(s): <counter> was unavailable`
  (`src/core/tokens.ts`; `test/core-loop/counter-label.test.ts`). This closes the open point of note 1.

## What the runs prove

- **The openai driver works against three real endpoints:** the official OpenAI API
  (`gpt-5.4-mini`, `gpt-5.4`, `gpt-6-luna` and `gpt-5.6-luna` in compat mode), Google AI Studio's
  OpenAI-compatible endpoint (Gemini 3 Flash, Gemini 3.5 Flash-Lite, Gemma 4) and OpenRouter. On
  the official API, both task kinds reached DONE on 3 Oct code, and the greenfield task again on
  4 Oct (normal and `--baseline`); no brownfield run reached DONE on 4 Oct code.
- **The claude driver works against OpenRouter's Anthropic-compatible endpoint:** two partial
  runs on a free model (15 and 7 turns, both killed), and a smoke call (`provider-smoke.txt`).
  In the smoke call the proxy rejected optional parameters with a 400, so the driver switched to
  its compat request (the run artifacts do not record the mode). The proxy has no `count_tokens`,
  so the runs' counts fell back to chars/4. **The claude driver has
  not run against `api.anthropic.com`:** there is no Claude DONE run and no real
  `harness agnostic <claudeRun> <openaiRun>`. Prompt caching, adaptive thinking, server-side
  `countTokens` and a DONE run on the Messages API all need an Anthropic key.
- **The gates refuse real model mistakes:**
  - contract-lock failed an API with every route deleted (`…190756`);
  - observed-red refused `src/` writes before a covering red (`…165940`, `…170930`, `…172357`,
    `…184219`, `…185304`, `…190756`);
  - test-preservation refused 7 whole-file rewrites (`…185304`);
  - finish was refused while a gate was red (`…184627`, 7 times; `…045424`, twice);
  - tests-green refused DONE on every 4 Oct brownfield run with one failing agent-written test
    (`…045936`, `…050115`, `…050613`);
  - `unsafe-code-guard` refused test files that introduced `any` (`…170930`, `…172357`).

  The decisions are in `events.jsonl` (`"decision":"block"`).
- **Reporting stays honest.** Every run that ended on its own ran its final gates fresh and
  reported `NOT DONE` with its failing and UNPROVEN gates, even with 29/29 tests and 100%
  standards (`…184627`), and even with every final gate green but no accepted finish (`…045424`).
  The aborted run reported its gates as not run (UNPROVEN), not as green (`…184219`).
- **Token numbers on real models, and what they are.** The only measured baseline is
  `tokens/compare-users-api-openai-20261004-045424-vs-users-api-openai-20261004-045825.json`:
  62.8% fewer input tokens per turn, but 39.3% more per run (60 turns against 16). Every other
  number in this file is a shadow estimate: 84.8–88.1% on the 3 Oct runs of 40–60 turns, 62–77%
  on the shorter free-tier runs, 77.3% and 81.2% on the 3 Oct DONE runs, 69.9–75.6% on the 4 Oct
  runs. No real run reached 90%, measured or estimated (docs/design.md §3).

## Open points

- **F13 is now guarded at write time** (`plugins/hooks/elision-guard.ts`): a write, edit or append
  containing the history placeholder `<omitted N chars>` is refused with the way out. The run that
  revealed it (…190756) predates the hook; its gates caught the damage at finish.
- The repeated-read pointer, the SIGTERM stop and the rate-limit waits were present in later
  runs but were never triggered by a real model. They are proven only by the offline tests above.
  The same holds for the turn-limit extension and the context-overflow shrink, which no 4 Oct
  run triggered (every 4 Oct run had an explicit, hard limit: the task's `maxTurns`, or
  `--max-turns 30` for the `--baseline` run).
- **Shared module-level state (4 Oct)** has no harness fix yet: three brownfield runs ended NOT DONE
  on one order-dependent agent-written test each (see the 4 Oct table).
- **Models that stop calling finish.** `…045424` never called finish after turn 19, and the three
  failed 4 Oct brownfield runs never called it at all; DONE requires an accepted finish, so they
  ended at the turn limit.
