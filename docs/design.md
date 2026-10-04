# Design note: sf-ai-harness

## 1. Architecture: the loop, where the hooks sit, who decides what

```
task file ──► harness run ──► git worktree on harness/<task>-<driver>-<stamp>   (your checkout untouched)
                 │               greenfield: scaffold templates/express-zod
                 ▼
   ┌──────────────── agent loop (src/core/loop.ts) ─────────────────┐
   │ request = system + tools + brief + digest + last 2 turns        │
   │ driver.complete(request) ─► tool calls                          │
   │   for each call:  zod-validate input                            │
   │                   PRE hooks  ── block ─► error result + reason  │
   │                   run tool (compact summary; raw → runs/<id>/logs)
   │                   POST hooks ── record ─► note appended         │
   │   finish ─► GATES (fresh) ── any fail/unproven ─► FINISH REFUSED│
   └──────────────────────── all gates green ───────────────────────┘
                 │
                 ▼
   final gates (fresh) ─► run.json, gates.json, standards.txt, tokens/<id>.json
                 │  --ship
                 ▼
   ship (src/core/ship.ts): gates again, stage API root only, secret scan, commit,
                 push feature branch (never protected, never --force), gh pr create
```

**Deterministic (code):** scaffolding, worktrees, git, the test runner (Vitest via the
harness's own `runVitest`, the only source of "observed red"), the import-graph test map,
tsc, the four standards checks (TypeScript AST + type checker + runtime probes), contract
extraction, every gate, token accounting and shipping. **The model decides:** task
breakdown (`plan`), which context to fetch, test design, and code.

**Hooks** (`plugins/hooks/`, all fail closed: a crashing hook blocks):
- `observed-red`: a `src/` file is writable only after a test whose import closure reaches it
  was run by the harness and a case failed for a valid reason: an `expect()` subject uses a value
  imported from `src/` (or derived from one) and is not a constant. A variable declared in a
  `describe` and assigned in `beforeEach` (`let app; beforeEach(() => { app = createApp(); })`)
  counts as derived, and a supertest `.expect(201)` chain asserts on its receiver (F9). A
  side-effect import, `void x`, `typeof x` or `expect(true).toBe(false)` does not count.
- `test-preservation`: tests that existed at run start are append-only. Existing cases keep
  their title, stay enabled and keep every original statement verbatim and in order (new
  statements only after the last one, no hoisted `function`/`var`); their setup hooks, imports,
  top-level statements and test helpers stay as they were; new code in such a file may not add
  side-effect or helper imports, shadow names, or call `expect.extend`, `vi.mock` and similar,
  `Object.defineProperty` or `Reflect`. A brownfield task with `allowBreaking: true` may change
  bodies, hooks, mocks and helpers, but still may not remove, rename or skip a case. The
  `append_file` tool (same hooks) is the safe way to add a `describe` block, and the block
  message names it (F11).
- `path-guard` (API root, task scope, harness-owned files, `.ts` only, case-insensitive),
  `source-boundary` (no importing test code, leaving `src/`, `createRequire`-style loaders or
  `vitest` from source), `unsafe-code-guard` (`any`, `x!`, `@ts-ignore`), `secret-guard`, `elision-guard`
  (refuses the history placeholder `<omitted N chars>` as file content).

A test file is one thing everywhere (`src/core/testmap.ts`): `*.test.ts` / `*.spec.ts` is a
runnable test; any other file in a dedicated test dir (`test/` for the template) is test support,
never runnable, never governed.

**Target profile** (`src/core/target.ts`, computed at preflight, printed and kept in `run.json`):
the harness reads the target's own layout and toolchain instead of assuming the template: source
roots from tsconfig (`rootDir`/`include`/references), test globs and dedicated test dirs from the
runner's config (vitest `include`, jest `testMatch`/`roots`, `node --test` arguments), import
resolution (tsconfig `paths`/`baseUrl`, package `imports`, vite/jest aliases, `require()`), the
runner (vitest, jest 29+ or node:test; the target's own binary first), where express, zod, vitest
and typescript resolve from (every `node_modules` from the API up to the repository top is linked
into the worktree; the harness's is the fallback) and the zod major (Zod 3 schemas need
`zod-to-json-schema`). What it cannot support (another framework or runner) is UNPROVEN.
The rest of the harness reads the same layout: the check context's source and test lists (and
`ctx.layout`), the contract extractor's source set, app-entry discovery (the source roots are
searched after `src/` and tsconfig `rootDir`), the source-boundary hook, and a brownfield task
that declares no `scope` (the task front end decides, whatever the file's format), whose write
scope becomes the profile's roots (`run.json` `target.defaultScope`). The type check stays
layout-independent on purpose: every TypeScript file of the API. Runner binaries and loaders are
executed from their real path, which the sandbox's read fence allows from the worktree, a revert
copy or a snapshot alike (it allows each linked `node_modules` by its real path).

**Gates** (`plugins/gates/`, run fresh at finish and again at ship): `tests-green`;
`observed-red` (every changed source file has a covering case that was seen red and now passes,
and a **revert check**: in a copy of the API with every changed source file put back to its
run-start content, kept in `runs/<id>/initial/`, that case must fail again, so a flip caused
by a new mock, a changed constant, the clock or randomness does not count. The case is hashed
over its whole call: title, callback, options, timeout, `.each` table. A case edited after its
red counts only through this differential proof, on its current body: an edit that makes it
pass regardless of the source fails the revert check (F10)); `standards` (greenfield: the
four standards rules 100% over the whole API; any other check, e.g. a dropped-in ORM or lint
rule, blocks only in files the run changed; brownfield: every rule is compared with a baseline
measured on the base commit and only what the run introduced blocks); `scope`; `contract-lock` (brownfield); `secrets`
(ship only).

**Isolation** (`src/core/sandbox.ts`). Agent-written code runs in three places: the Vitest
runner, the contract extractor (imports its Zod schemas) and the runtime probe (imports
`createApp`). Each runs under the OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux): API
root read-only, writes only to a per-call OS temp dir, network loopback only (none for contract
extraction), credential stores unreadable, credential env vars stripped. So executed agent code
cannot write to your checkout (a `git commit` there fails), reach the internet, or edit
source/tests behind the hooked write tools. The git worktree protects your checkout from the
agent's tool writes; the sandbox protects it from the code the agent wrote. Agent code also does
not control a result: Vitest (`--pool=forks`) writes its JSON report to `/dev/fd/3`, a pipe test
workers do not inherit; the probe child only serves `createApp` while the harness sends and
judges every request; the extractor imports a changed module only if it is declarative Zod
(`plugins/lib/schema-purity.ts`), converts with an empty metadata registry so `.meta()` cannot
widen a schema, and otherwise falls back to the source hash (changed = UNPROVEN). With no working
mechanism a run refuses to start; `HARNESS_SANDBOX=off` (or `"sandbox": "off"`) runs unconfined
and is recorded as UNPROVEN. `harness doctor` self-tests it (an outside write and an outbound
connect must both be refused); `run.json` records `isolation`.

**Run_tests summaries** name, for a suite that failed to load, the first in-project frame of
that file's block in the runner's console and its line of code (`ERROR test/users.test.ts: suite
error: app.use() requires a middleware function (at src/routes/index.ts:10:7  app.use(usersRouter);)`).
**Stopping:** Ctrl-C or SIGTERM (a CI timeout, `kill`) stops the loop after the current step and
still writes every piece of evidence (`run.json` status `aborted`; exit 130 / 143); a second
signal exits at once. A signal that lands after the loop ended (e.g. while the gates of an
accepted `finish` run) still stops the run: the fresh final gates, the checks and `--ship` are
skipped, `run.json` is `aborted` (the loop's own outcome kept as `loopStatus`) and the exit code
is 130 / 143.

## 2. Driver abstraction

The core speaks one neutral model (`src/core/types.ts`): `Message{role, parts}`, where a
part is `text`, `tool_call`, `tool_result` or `opaque`. `ToolSpec` is `{name,
description, inputSchema}`, a plain JSON Schema generated from each tool's Zod input. Every
provider implements:

```ts
interface Driver {
  name: string; model: string; tokenCounter: string;
  complete(req: ModelRequest): Promise<ModelResponse>;   // parts, stop, usage
  countTokens(req: ModelRequest): Promise<number>;        // same counter for actual and baseline
}
```

`plugins/drivers/claude.ts` maps this to the Messages API (adaptive thinking, automatic
prompt caching, server-side fallback, `drop_block` for thinking blocks the compactor
retires). `openai.ts` maps it to Chat Completions function tools. Both leave 429/5xx retries
to the SDK, and on a 400 that rejects an optional parameter they switch the session to a
compatible request (the model id then reads `<id> (compat)`). One real case: `gpt-6-luna`
rejects function tools on Chat Completions while reasoning is on, so the openai driver retries
once with `reasoning_effort: 'none'` (F7).
Fields a provider adds to a tool call beyond id/type/function (an OpenAI-compatible gateway's
`extra_content` carrying a thought signature, which it requires back on later turns) are kept
by the openai driver as its own `opaque` part next to the call and merged back on replay; they
are digested together with their call, so none outlives it. When a rate-limit error names its
wait ("retry in 37.6s", `"retryDelay": "37s"`, `Retry-After`, or an echoed `X-RateLimit-Reset`
epoch timestamp, read as the time left until it), the loop waits it out if it is
at most 120 s (up to 30 times per request, outside the normal retry budget; an abort cuts the
wait short) and stops the run at once on a longer one (a daily quota).

**Refused to leak through the interface:** provider names, model ids, vendor tool-schema
formats, vendor message shapes, vendor stop reasons and reasoning blocks. Reasoning blocks
travel as `opaque` parts that only their own driver replays. Task files are read leniently
(docs/task-format.md), but a `model:` or `provider:` key is always a load error. `harness doctor`
scans `src/core/`, `tasks/` and every file under every plugin directory except driver plugins
and `drivers/` for provider vocabulary.
`run.json` fingerprints the task file, every tool/hook/gate/check file and every shared helper
under the plugin directories (`plugins/lib/**`; driver code excluded), and lists the tools offered
and checks registered, so `harness agnostic <runA> <runB>` proves "zero diff" between the two
drivers' runs, shared check and gate logic included.

## 3. Token budget: baseline vs actual, per turn

Every run writes `tokens/<runId>.json` with, per turn, `actual_input_tokens` (the request
sent) and `baseline_input_tokens`, a **shadow baseline**: the same turn's request rebuilt with
JIT fetchers and compaction disabled (the whole API root and every standards doc front-loaded
into the system prompt, raw tool returns, no elision or history compaction), counted with the
driver's own counter (`messages.countTokens` for Claude, o200k for OpenAI). When an endpoint has
no count API, both requests fall back to chars/4, `events.jsonl` says so every turn, and the
report's `counter` names the fallback (`chars/4 estimate for N count(s): … was unavailable`), so
it never names a counter that did not produce the numbers. A shadow baseline
follows the JIT run's trajectory, so it is cheap but hypothetical. To measure instead,
`--baseline` runs that configuration for real and `harness tokens compare <jit> <baseline>`
compares the two runs. On the scripted greenfield script both give the same number: shadow
19,305 vs 178,301 (89.2%), real `--baseline` run 178,301, turn for turn (`tokens/compare-…json`,
89.2%). Those evidence runs predate the working set and the scaffold API; on the current code the
same script measures 27,035 vs 185,015 (85.4%) both ways. With a real model the two runs can
diverge, so real-driver numbers come only from real runs' `tokens/` files.

**The >90% target is not met on real runs.** Measured, per-turn shadow baseline, local o200k:

| runs | turns | reduction | file |
|---|---|---|---|
| the two real DONE runs (official OpenAI) | 19, 12 | 77.3%, 81.2% | `tokens/users-api-openai-…185149.json`, `tokens/projects-change-openai-…190927.json` |
| real runs that did not finish, 40–60 turns (8 runs) | 40–60 | 84.8–88.1% | `runs/real-model/<id>/tokens.json` |
| scripted demo runs | 9 | 89.2%, 85.4% | `tokens/*-scripted-*.json` |
| 40-turn simulation, shipped policy | 40 | 86.3% | `test/token-efficiency/long-run.test.ts` |
| 40-turn simulation, compaction only | 40 | **90.7%** | same test |

There are two reasons:
- **A fixed per-turn floor.** System prompt, tool schemas and task brief are sent every turn. On
  turn 1 of the greenfield DONE run they already come to 2,465 tokens, against an 11,075-token
  baseline. The ratio rises with run length, because the baseline grows by every raw return
  while the actual stays nearly flat (4,747 per turn on average in that run). A model that
  finishes in 12–19 turns never reaches the steep part of the curve.
- **Deliberate anti-thrashing context.** The working set, the scaffold API and two kept turns
  cost tokens on every request. Real models proved them necessary (F1, F6, F12 in §6).

| mechanism (40-turn simulation printed by `test/token-efficiency/long-run.test.ts --reporter=verbose`, o200k) | actual input tokens | reduction |
|---|---|---|
| baseline: front-load + raw returns + full history (brief with the scaffold API) | 1,337,976 | — |
| + JIT context (rules index and file tree only; `read_file` ranges, `outline`, `search_code`, `test_map`, `fetch_standard`) | 993,536 | 25.7% |
| + compact tool returns (pass/fail lines and diff stats; raw output to `runs/<id>/logs`) | 529,076 | 60.5% |
| + input elision (tool-call input strings over 300 characters, e.g. file contents, replayed as `<omitted N chars>`) | 404,303 | 69.8% |
| + digest of turns older than 2 (one line per call, append-only so the prefix stays cacheable) = **shipped** | **183,854** | **86.3%** |
| of which working set: +35,861 tokens over 36 requests (largest 6,948 characters, budget 12,000) | | |
| of which scaffold API in the greenfield brief: +25,720 (643 per request, added to the baseline too) | | |
| shipped without both (compaction only; baseline 1,312,256) | 122,273 | 90.7% |

The working set sits after the digest, so the digest prefix stays append-only. Per file read in
a folded turn and not written since, it holds that file's latest read, most recent first, in a
12,000-character budget. Reads that folded at most 3 turns ago stay **in full**, within 6,000
characters (F12). Older reads keep only their signature lines with line numbers (40 per file). A
write drops the file's entry, matched by the canonical path the write tool reported (so
`src//a.ts`, an absolute path or another letter case count as `src/a.ts`). Only a successful
re-read in the kept turns replaces it. A read whose fresh result is byte-identical to that of the
same call (canonical input) still shown in the kept turns is answered with a pointer (`unchanged
since t<N>: …`). The read always runs, so a change made earlier in the same turn or by code during
a test run is never hidden, and the baseline keeps the full content.

The simulation's scripted model never re-reads, so it pays these costs without being credited
for the re-reads they prevent. The test asserts that compaction alone stays above 90% and the
shipped total above 85%. History keeps the last `keepRecentTurns` turns verbatim (default 2 in
`harness.config.json`). The same test prints the trade-off: 1 → 87.0%, 2 → 86.3%, 3 → 85.5%.
Keeping 1 turn would save 0.7 points but leave a model only the working set of what it read two
turns ago.

## 4. Extension points

A plugin is any file under `plugins/` (`.ts`/`.mts`/`.js`/`.mjs`; `lib/`, `_*`, `*.test.*`,
`*.spec.*` and `*.d.ts` are skipped) whose default export comes from a `define*` helper in
`src/core/plugin-api.ts`: `defineTool`, `defineCheck` (category `standards`, `orm`, `lint`
or any label), `defineHook`, `defineGate`, `defineDriver`. Dropping the file in is the
whole registration: the registry discovers it, validates it with Zod, and fingerprints it.
Tool names match `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/` (so `openapi-diff` is valid);
descriptions, a check's `unit` and its `doc` are optional. A new check automatically gets
its own report lines, appears in the system prompt's rules index, and joins the `standards`
gate: strict over the whole API for category `standards`, diff-aware (blocking only in files
the run changed) for any other category, so a new rule can never deadlock a run on read-only
scaffold files. A non-standards check that returns no findings has status `n/a`: not counted,
never proven. A new tool appears in the next run's tool list. Checks also receive the task kind, the run's base commit and the API's
`package.json` dependencies. Disable a plugin with `"disabled"` in `harness.config.json`.
**Trust boundary:** plugins are trusted code, executed when imported (like eslint or Vitest
plugins); Zod validation runs after the import, so it checks shape, not intent. Agent output
persists only in the worktree dir (sandboxed agent code writes only per-call OS temp dirs, which
are deleted), and the registry refuses any plugin directory inside it without importing it.
**Core = `src/core/`. It never changes to extend.** `docs/extending.md` has a minimal,
type-checked `openapi-diff` tool, ORM validator and lint rule; `examples/plugins/` holds
fuller versions (`openapi_diff`, `orm-explicit-columns`, `no-console`), and
`scripts/simulate-extensions.mjs` adds them one at a time to a throwaway copy of the repo
and asserts that `git diff --stat` touches only `plugins/**`.

## 5. Honesty boundary

**Proven by the harness:** the agent's tests pass when run fresh by the harness; every changed
source file has a covering test case that the harness saw fail (asserting on values from `src/`,
with a non-constant subject), then pass, and fail again with the run-start source put back (an
edited case counts only through that differential proof); pre-existing test cases were only appended to; agent code ran under the OS sandbox
(`isolation:<mechanism>`); `tsc --strict --noUncheckedIndexedAccess` is clean with no
`any`/`x!`/`@ts-ignore` (and, in `src/`, no value whose type is `any`); every handler parses
params/query/body/headers and its 2xx body with Zod; every non-2xx path seen statically and by
runtime probes (404, 400 malformed JSON, 422, unknown id, an injected 500) is
`application/problem+json` with all five fields; the routes follow the REST rules; no breaking
contract change; nothing outside scope; no secrets.

**Reported as UNPROVEN, never green:** a check that crashed or was skipped, a rule with zero
units (e.g. an empty scaffold), runtime probes when the app cannot start, a changed schema whose
runtime shape could not be extracted (or whose module is not declarative Zod), a revert check
that could not run, and `isolation: off` (agent code ran unconfined because the operator set
`HARNESS_SANDBOX=off`). A PR step without `gh` or a remote ends as `committed`, never `shipped`.

**A human still has to verify:** that the agent's tests cover the intended behaviour (green
only means its own tests pass), semantics beyond those tests, any change admitted with
`allowBreaking`, and persistence, performance, security and concurrency.
Residual risks, documented rather than hidden:
- **Code under test shares a process with what reports on it.** A test file runs in the Vitest
  worker that reports its own cases, and `src/` code runs next to the tests: code written to
  tamper with the runner in memory (rather than the report, which it can no longer reach) could
  forge its own results. The revert check limits this (a forged pass must also fail with the
  original source) and `vitest` imports are refused in `src/`, but a separate trusted reporter
  process would be needed to rule it out.
- **Measurement can be detected.** The probe proves what the app served to the harness on the
  wire; an app that detects the probe could serve something else in production.
- **The revert check reverts all changed files together.** It proves the source changes as a
  whole cause every flip; an unneeded edit that rides along with a needed one, covered by the
  same case, is not caught per file (a human reviews the diff).
- **A weak test can still satisfy observed red.** Any failing non-constant assertion whose
  subject uses `src/` values, and that flips with the source change, counts, whatever it checks.
  The harness proves the test is change-sensitive, not that it tests the right behaviour.
- **Leftover processes on macOS.** A test can start a detached process that outlives the run
  (no pid namespace; `bwrap` uses `--unshare-pid --die-with-parent`). It stays confined (writes
  only its deleted temp dir, loopback only) and cannot reach the report pipe, but it is not
  killed and could interfere with later loopback calls (e.g. race to bind a probe's port).
- **Refinements are opaque to the contract.** Constraints that only live in refinements
  (`.refine`, `.transform`) are invisible to JSON Schema: a changed schema source with an identical
  JSON Schema is UNPROVEN, but what changed is not classified. Error statuses are diffed as a set
  per endpoint; which condition produces which status is not visible.
- **`any` without the keyword** is found by the type checker in `src/` only (tests may read
  untyped library values such as supertest's `res.body`), and the write-time
  `unsafe-code-guard` stays syntactic; the finish gate (`tsc-strict`) is the authority.
- The `bwrap` path is unit-tested but was not exercised on Linux here.
`run.json` lists what a human must verify for every run.

## 6. Evidence: real-model runs

**Two real runs reached DONE**, both on the official OpenAI API with the openai driver (Chat
Completions). Their evidence is at the top level of `runs/` and `tokens/`:

| run | task | model | turns | gates | tokens (reduction) | approx. cost |
|---|---|---|---|---|---|---|
| `users-api-openai-20261003-185149` | greenfield | `gpt-5.4-mini` | 19 | all green: observed red (1 source file red → green, red again on revert), 28/28 tests, standards 100% | 90,195 / 397,317 (77.3%) | ~USD 0.08 |
| `projects-change-openai-20261003-190927` | brownfield | `gpt-5.4` | 12 | all green: contract-lock (2 additive), observed red (3 files + revert check), 21/21 tests, standards 100% | 50,550 / 268,600 (81.2%) | ~USD 0.15 |

The brownfield run used the final code. The greenfield run predates F11 and F12, which changed
only `append_file`, the hooks and `plugins/lib/diff.ts` that govern it, and the working set. Each run directory also holds:
- `cli-output.txt`;
- `ship-dry-run.txt`: `harness ship <id> --dry-run` re-ran every gate fresh on the final code,
  `secrets` included, and all were green. Nothing was staged, committed or pushed, and the target
  repositories have no remote;
- the output of `harness check --api` on the API root (`check-generated-api.txt` /
  `check-existing-api.txt`): verdict 100%.

The costs are the operator's approximate figures. The harness records tokens, not prices.

`runs/real-model/` (its README has the per-run table and the file behind each claim) holds
the **fifteen real runs that did not reach DONE**: seven on the official OpenAI API (six
`gpt-5.4-mini`, one `gpt-6-luna`) and eight on free tiers (OpenRouter, Google AI Studio).
Each exposed a defect, and every defect is now fixed and tested offline (F13 was also caught by
the gates when it happened).

| finding (run) | fix | test |
|---|---|---|
| F1: once a read folded into the digest, models re-read it in a loop (121 `read_file` calls on an already-read path) | working set (§3) and repeated-read pointer | `test/core-loop/working-set.test.ts`, `repeat-read.test.ts` |
| F2: Gemini 3 answers 400 unless each tool call's `extra_content` (thought signature) comes back | the openai driver keeps per-call extras as an opaque part and replays them (§2) | `test/drivers/openai-extras.test.ts`, `test/live-shape/tool-call-extras.test.ts` |
| F3: a per-minute 429 ("retry in 37.7s") ended a run once the normal retries ran out | wait out a stated wait of 120 s or less, stop on a longer one (§2) | `test/core-loop/rate-limit.test.ts` |
| F4: "app.use() requires a middleware function" without a location; the model looped to `max_turns` | in-project frame and code line in the summary (§1) | `test/core-quality/error-location.test.ts` |
| F5: SIGTERM-killed runs left `status: running` and no evidence | SIGTERM = graceful stop, exit 143 (§1) | `test/e2e/sigterm.test.ts` |
| F6: models read every scaffold file up front | scaffold API in the greenfield brief (§3) | `test/core-loop/scaffold-api.test.ts` |
| F7: `gpt-6-luna` rejects function tools with reasoning on Chat Completions (400) | retry once with `reasoning_effort: 'none'` (compat, §2) | `test/drivers/openai-reasoning.test.ts` |
| F8: a module-level store leaked state across `createApp()` calls (pagination off by one) | the brief says every `createApp()` starts with empty state | `test/core-loop/scaffold-api.test.ts` |
| F9: a real red was rejected for the supertest idiom (`let app` in `describe` + `beforeEach`, `.expect(201)` chains) | the test map follows describe-scoped variables and supertest chains (§1) | `test/core-quality/testmap.test.ts` |
| F10: finish refused 7 times because the red case was edited before it went green | an edited case counts through the revert check (differential proof, §1) | `test/red-green/red-green.test.ts` |
| F11: 7 whole-file rewrites of a pre-existing test file, all blocked by test-preservation; the run changed nothing | `append_file` tool, named in the block message (§1) | `test/plugins/append-file.test.ts` |
| F12: a read loop over 3 related files whose folded reads survived only as skeletons | the working set keeps the latest folded reads in full for 3 turns within 6,000 characters (§3) | `test/core-loop/working-set.test.ts` |
| F13: the model overwrote 3 source files with the history placeholder `<omitted N chars>` (4 → 0 endpoints) | **contract-lock failed it** (and tsc-strict and tests); the `elision-guard` hook now refuses such a write at write time | `test/plugins/elision-guard.test.ts`, `test/contract-ship/diff.test.ts` |

**Model agnosticism: what is proven for real.**
- *openai driver:* official OpenAI (DONE on both tasks; `gpt-6-luna` in compat mode), Google AI
  Studio's OpenAI-compatible endpoint (Gemini 3 Flash, 3.5 Flash-Lite, Gemma 4; F2 thought
  signatures replayed on every turn), and OpenRouter.
- *claude driver:* only OpenRouter's Anthropic-compatible endpoint, with a smoke call
  (`claude-haiku-4.5`) and two partial free-model runs (15 and 7 turns, killed). In the smoke call
  the proxy rejected optional parameters with a 400 and the driver switched to compat mode; its
  missing `count_tokens` made every count in the runs a chars/4 estimate.
- *Not proven:* the claude driver against `api.anthropic.com` needs an Anthropic key. That
  covers prompt caching, adaptive thinking, server-side `countTokens`, a DONE run, and a real
  `harness agnostic <claudeRun> <openaiRun>` on the same task. The offline tests cover the claude
  driver's wire shape (`test/drivers/claude.test.ts`, `test/drivers/sdk-wire.test.ts`), and
  `harness agnostic` is proven on scripted runs.

The repeated-read pointer, the SIGTERM stop and the rate-limit waits never triggered in a real run,
so they are proven only offline.
