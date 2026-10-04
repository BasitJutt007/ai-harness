# Design note: sf-ai-harness

A harness that governs a model writing TypeScript REST APIs. The model proposes; deterministic code
decides. Detail behind every paragraph (full hook list, loop rules, isolation, check limits) is in
[reference.md](reference.md); the runs behind every number are in the README.

## 1. Architecture

```
task file ─► front end (a model/provider key is an error) ─► preflight: target profile, baselines
          ─► git worktree on harness/<task>-<driver>-<stamp>
   ┌──────────────────────── loop (src/core/loop.ts) ────────────────────────┐
   │ request = system prompt + tool specs + brief + digest + working set     │
   │ driver.complete ─► for each tool call: validate input, compute preview  │
   │   PRE hooks  ── block ─► the reason goes back as the tool result        │
   │   run the tool (compact summary to the model; raw output to logs/)      │
   │   POST hooks ── record ─► a note on the result                          │
   │ finish ─► every gate, run fresh ── any fail/unproven ─► finish refused  │
   └──────────────────────────────────────────────────────────────────────────┘
   final gates, fresh ─► run.json, gates.json, standards.txt, tokens/<id>.json
   ship ─► gates again ─► stage the API root only ─► secret scan ─► commit ─► push ─► gh pr create
```

**Where the hooks sit.** Pre-tool hooks run before every tool call and can block it (a crashing hook
blocks): writes only inside the scope and only to `.ts` (`path-guard`), no source edit until a test
covering it was *run by the harness and seen failing* (`observed-red`), existing tests append-only
(`test-preservation`), no `any`/`x!`/`@ts-ignore` (`unsafe-code-guard`), no secrets, no undeclared
packages, no source that imports tests or detects the test runner, no placeholder or gutting writes.
Write tools declare their exact post-write content, so hooks judge what will be on disk. One post-tool
hook records type errors and never blocks.

**Deterministic vs model.** *Code decides:* scaffolding, git and worktrees, running the target's own
test runner (the only source of "observed red"), the import-graph test map, the type check, the four
standards checks, contract extraction, all eight gates, token accounting and shipping. *The model
decides:* the plan, which context to fetch, the tests and the code. It has no shell and never runs
git, tsc or tests itself. Agent-written code only ever runs inside the OS sandbox (writes to a temp
dir, reads fenced to its tree, env allow-list, loopback network).

**Done means gates, not the model.** `finish` is accepted only when every gate passes on a fresh run;
the same gates run again at the end and again at ship. Gates: `tests-green`, `observed-red` (each
changed file has a case seen red that now passes, and fails again with that file alone reverted),
`standards`, `scope`, `orphans`, `spec-coverage` (greenfield: the endpoints and field-spec probes the
task implies, against the running app), `contract-lock` (brownfield), `secrets` (ship).

## 2. Driver abstraction

```ts
interface Driver {
  name: string; model: string; tokenCounter: string;
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  countTokens(req: ModelRequest): Promise<number>;        // one counter for actual and baseline
  retryAfterMs?(error: unknown): number | null;            // the provider's rate-limit formats
  errorKind?(error: unknown): 'context_overflow' | null;   // the provider's overflow wording
}
```

Requests are neutral: `Message{role, parts}` with `text`, `tool_call`, `tool_result` and `opaque`
parts, and tools as JSON Schema generated from their Zod input. `plugins/drivers/claude.ts` maps this to
the Anthropic Messages API and `openai.ts` to Chat Completions; a third, `scripted`, replays recorded
tool calls offline for tests.

**Refused to leak through it:** vendor message shapes (reasoning blocks and per-call extras travel as
`opaque` parts that only their own driver replays), rate-limit and error formats (the driver reads
them; the loop sees milliseconds and an error kind), parameter fallbacks (a driver switches itself to a
compatible request and reports `<model> (compat)`), and model choice (task files reject `model:` and
`provider:` keys; the model comes from `--model` or the environment). `harness doctor` scans the core,
tasks and every non-driver plugin for provider vocabulary. `run.json` hashes the task, every active
plugin and every `src/core` file, and `harness agnostic <runA> <runB>` exits 0 only when nothing
governing differs and both runs are DONE.

## 3. Token budget: baseline vs actual, per turn

**Actual (JIT):** a ~440-token system prompt with a one-line-per-rule standards index, the brief and a
file tree; everything else is fetched on demand (`read_file`, `outline`, `search_code`,
`fetch_standard`, `test_map`); tool returns are compact summaries with raw output on disk; tool inputs
over 300 characters are replayed as `<omitted N chars>`; turns older than the last two are folded into a
digest. **Baseline (`--baseline`):** the same task with the fetch tools withheld, every API file and
every standards document front-loaded into every request, raw returns and no compaction.

Measured on the final code, same task and model (`gpt-5.6-luna`), both runs DONE: the shipped run
`users-api-openai-20261004-145143` against a real `--baseline` run `…145009`
(`tokens/compare-users-api-openai-20261004-145143-vs-users-api-openai-20261004-145009.json`):

| turn | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11–14 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| actual (JIT) | 2,641 | 7,759 | 7,862 | 4,426 | 7,499 | 7,254 | 5,571 | 6,495 | 6,511 | 5,253 | 4,496–5,404 |
| baseline | 12,276 | 12,410 | 15,290 | 16,325 | 18,956 | 19,147 | 19,319 | 19,881 | 20,288 | 20,994 | (done) |

| | JIT run | baseline run | reduction |
|---|---|---|---|
| input tokens per turn (average) | 5,735 | 17,489 | **67.2%** |
| input tokens per run | 80,289 (14 turns) | 174,886 (10 turns) | **54.1%** |

**What earned it** (characters kept out of the JIT run's requests, from its token report): front-loaded
files and documents never sent (608,091), turns folded into the digest (321,717), raw tool output
replaced by summaries (180,438). The baseline grows every turn because it re-sends the whole tree;
the JIT request stays roughly flat. **The >90% target is not met:** a fixed per-turn floor (system
prompt, tool schemas, brief) remains, and the JIT run took more turns. Each normal run also prints a
*shadow* baseline (the same trajectory with the baseline's context, never sent), labelled
`baseline_kind: shadow`; it was 71.4% here, above the measured figure.

## 4. Extension points

A plugin is one file under `plugins/{tools,hooks,gates,checks,drivers}` whose default export comes from
`defineTool`, `defineHook`, `defineGate`, `defineCheck` or `defineDriver` (`src/core/plugin-api.ts`).
Dropping it in is the registration: the registry discovers, validates and fingerprints it. A new tool is
offered on the next run, a new check gets report lines and a place in the `standards` gate, a new driver
is selectable with `--driver`. `"disabled"` in `harness.config.json` turns one off. **`src/core/` never
changes to extend:** `scripts/simulate-extensions.mjs` adds the `examples/plugins/` extensions (a tool,
an ORM check, a lint rule) to a throwaway copy and asserts that only `plugins/**` changed.

## 5. Honesty boundary

**Fail-closed:** a check or gate passes only on positive evidence. Whatever it does not model (an
unresolved handler, `res.write`/`redirect`, a non-constant status, a router it cannot see mounted, a
`.js` file, a schema built on `z.any()`, a probe stopped by authentication, a route the running app
serves that the analysis did not find) is UNPROVEN, never pass, and UNPROVEN keeps a run from DONE.
`npm run audit:mutations` applies 31 such mutations to a shipped API and requires that none reads 100%.

**Proven when the gates pass:** tests pass when the harness runs them fresh; each changed source file
has a case seen red, now passing, red again with that file reverted; existing tests only grew; strict
`tsc` is clean; inputs and 2xx bodies go through Zod; errors are `application/problem+json`; routes
follow the REST rules; idempotent POST/PATCH replay at runtime; created files are used; writes stayed in
scope; the task's endpoints pass their field-spec probes (greenfield); no breaking contract change
(brownfield); no secrets ship; agent code ran sandboxed.

**Not proven, for a human:** that the agent's tests test the intended behaviour; behaviours written only
as free text; behaviour behind an unchanged schema (sorting, filtering meaning); persistence,
performance, security and concurrency. **Known limits:** Express only; the Linux sandbox and the jest
adapter are tested without a live Linux host or jest install; the claude driver has not run against
`api.anthropic.com` (README, Evidence).
