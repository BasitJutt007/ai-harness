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
`path-guard` (API root, task scope, harness-owned files, `.ts` only, case-insensitive),
`observed-red` (a `src/` file is writable only if a test whose import closure reaches it
was run by the harness, failed for a valid reason, and has not been edited since that run),
`test-preservation` (no deleting/skipping pre-existing tests), `source-boundary` (source
may not import test code or reach outside `src/`), `unsafe-code-guard` (`any`, `x!`,
`@ts-ignore`), `secret-guard`.
**Gates** (`plugins/gates/`, run fresh at finish and again at ship): `tests-green`,
`observed-red`, `standards` (the four `standards` rules 100% over the whole API, or refuse; any
other check, e.g. a dropped-in ORM or lint rule, blocks only for violations in files the run
changed, and its violations in unchanged scaffold or task-denied files, which path-guard keeps
read-only, are reported as `pre-existing (not blocking)`), `scope`,
`contract-lock` (brownfield), and `secrets` (ship only).

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
compatible request (the model id then reads `<id> (compat)`).

**Refused to leak through the interface:** provider names, model ids, vendor tool-schema
formats, vendor message shapes, vendor stop reasons and reasoning blocks. Reasoning blocks
travel as `opaque` parts that only their own driver replays. Task files are
`.strict()`-validated, so a `model:` or `provider:` key is a load error. `harness doctor`
scans `src/core/`, `tasks/` and every file under every plugin directory except driver plugins
and `drivers/` for provider vocabulary.
`run.json` fingerprints the task file, every tool/hook/gate/check file and every shared helper
under the plugin directories (`plugins/lib/**`; driver code excluded), and lists the tools offered
and checks registered, so `harness agnostic <runA> <runB>` proves "zero diff" between the two
drivers' runs, shared check and gate logic included.

## 3. Token budget: baseline vs actual, per turn

Every run writes `tokens/<runId>.json` with, per turn, `actual_input_tokens` (the request
sent) and `baseline_input_tokens`. The baseline is the same request with JIT fetchers and
compaction disabled: the whole API root and every standards doc front-loaded into the
system prompt, raw tool returns (whole numbered files, the runner's console output, the
full standards report), and no elision or history compaction. Both sides are counted with
the driver's own counter (`messages.countTokens` for Claude, o200k for OpenAI). `--baseline`
runs that configuration for real, and `harness tokens compare` measures one run against the other.

| mechanism (40-turn realistic simulation, `test/token-efficiency/long-run.test.ts`) | actual input tokens | reduction |
|---|---|---|
| baseline: front-load + raw returns + full history | 1,304,736 | — |
| + JIT context (rules index and file tree only; `read_file` ranges, `outline`, `search_code`, `test_map`, `fetch_standard`) | 963,696 | 26.1% |
| + compact tool returns (pass/fail lines and diff stats; raw output to `runs/<id>/logs`) | 499,236 | 61.7% |
| + input elision (large `write_file`/`edit_file` payloads elided from their first replay) | 374,463 | 71.3% |
| + digest of turns older than 2 (one line per call, append-only so the prefix stays cacheable) | **118,153** | **90.9%** |

History keeps the last `keepRecentTurns` turns verbatim (default 2 in `harness.config.json`);
the same test prints the trade-off: 1 → 91.9%, 2 → 90.9%, 3 → 90%.
The scripted 9-turn runs in `tokens/` measure 89.1% (greenfield, also against a real
`--baseline` run) and 85.3% (brownfield). Short runs are bounded by a fixed per-turn floor:
turn 1 of the greenfield run (system prompt, tool schemas and task brief only) is already
1,717 tokens. The ratio rises with run length, because the baseline grows by every raw
return while the actual stays nearly flat (2,145 per turn on average in that run).

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
never proven. A new tool appears in the next
run's tool list. Checks also receive the task kind, the run's base commit and the API's
`package.json` dependencies. Disable a plugin with `"disabled"` in `harness.config.json`.
**Core = `src/core/`. It never changes to extend.** `docs/extending.md` has a minimal,
type-checked `openapi-diff` tool, ORM validator and lint rule; `examples/plugins/` holds
fuller versions (`openapi_diff`, `orm-explicit-columns`, `no-console`), and
`scripts/simulate-extensions.mjs` adds them one at a time to a throwaway copy of the repo
and asserts that `git diff --stat` touches only `plugins/**`.

## 5. Honesty boundary

**Proven by the harness:** the agent's tests pass when run fresh by the harness; every
changed source file was unlocked by an observed red of a covering test; `tsc --strict
--noUncheckedIndexedAccess` is clean with no `any`/`x!`/`@ts-ignore`; every handler parses
params/query/body/headers and its 2xx body with Zod; every non-2xx path seen statically
and by runtime probes (404, 400 malformed JSON, 422, unknown id, an injected 500) is
`application/problem+json` with all five fields; the routes follow the REST rules; no
breaking contract change; nothing outside scope; no secrets.

**Reported as UNPROVEN, never green:** a check that crashed or was skipped, a rule with
zero units (e.g. an empty scaffold), runtime probes when the app cannot start, a schema
whose runtime shape could not be extracted. A PR step without `gh` or a remote ends as
`committed`, never `shipped`.

**A human still has to verify:** that the agent's tests cover the intended behaviour (green
only means its own tests pass), semantics beyond those tests, any change admitted with
`allowBreaking`, and persistence, performance, security and concurrency.
The cheap-red residual risk (a test that fails trivially still unlocks the sources it
imports) is documented, not hidden. `run.json` lists these items for every run.
