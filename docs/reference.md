# Design reference

The detail behind the two-page design note ([design.md](design.md)): the full hook and gate list, loop
rules, isolation, the driver interface, how tokens are counted, extension mechanics, and every known
limit of the checks.

## 1. Architecture in detail

**Code decides** scaffolding, git, the test runner (the target's vitest, jest 29+ or node:test, run
by `src/core/testing.ts`, the only source of "observed red"), the import-graph test map, the type
check, the standards checks, contract extraction, every gate, token accounting and shipping. **The
model decides** the plan, which context to fetch, test design and code. It has no shell.

**Plugins** (`node bin/harness.mjs plugins`): 3 drivers (`claude`, `openai`, offline `scripted`),
15 tools, 9 hooks, 8 gates, 4 checks. Write tools (`write_file`, `edit_file`, `append_file`,
`delete_file`, the last only for files the run created) declare `preview()`, the exact post-write
content; content hooks judge that post-image and refuse a write tool without one.
- *Pre-tool hooks* (a crashing hook blocks): `path-guard` (API root, scope, `.ts` only),
  `observed-red` (a source file is writable only after a covering test, at its current content,
  ran in the harness with a case failing on an assertion, in any assertion API, on source values),
  `test-preservation` (existing cases append-only), `source-boundary` (source may not import tests,
  leave the source roots, or use absolute, computed or loader imports), `unsafe-code-guard` (`any`,
  `x!`, `@ts-ignore`), `secret-guard`, `elision-guard` (no `<omitted N chars>`-style placeholders; no
  write that breaks the parse of an existing source file or drops over half its exports and routes),
  `dependency-policy` (an added import must be a builtin or a declared, installed package). *Post-tool:*
  `typecheck-feedback` records up to 3 type errors of the written files and never blocks.
- *Gates* (fresh at finish and at ship; finish needs no `fail`/`unproven` and one `pass`):
  `tests-green`, `observed-red` (red → green on the same case, plus a **revert check** per changed
  file: with that file alone put back at its run-start content the case fails again), `standards`, `scope`, `orphans` (every created
  file is reachable from a test or from pre-existing code), `spec-coverage` (structured greenfield:
  the endpoints resources × operations imply exist and field-spec probes pass against the sandboxed
  app), `contract-lock` (brownfield), `secrets` (ship only).

**Brownfield.** The target profile (`src/core/target.ts`, kept in `run.json`) reads source and test
roots, import resolution, the runner and the installed express/zod/vitest/typescript from the
target's own config; what it cannot support (a framework other than Express, jest < 29, an unknown
runner) is UNPROVEN at preflight, and a task without `scope` writes within the profile's roots.
`standards` holds the four standards rules at 100% over the whole API (pre-existing violations in files
the task scope forbids fail as "incompatible target") and compares the other rules with the base commit
(a task may opt in to `standards: baseline`, labelled "baseline mode: below 100% allowed");
`tests-green` compares with the suite's results at run start (`src/core/test-baseline.ts`): an
already-skipped case is listed for a human, a newly skipped one is UNPROVEN, a failing test always
blocks. **Contract Lock** (`plugins/lib/contract.ts`) diffs routes and the JSON Schemas of each
request part and 2xx response, generated from the real Zod schemas at the base commit and in the
worktree; a breaking change fails unless the task sets `allowBreaking: true`.
When cases fail, `run_tests` re-runs up to two of them alone (vitest and jest name filters, same
sandbox) and names each one that passes alone: it depends on test order, e.g. an exact count over a
module-level store that earlier cases filled. Those re-runs are diagnostic only, never an observation.

**Loop rules** (`src/core/loop.ts`). *Turn limit:* `--max-turns` or the task's `limits.maxTurns` is a
hard cap; otherwise 40 + 20 per resource (at least one) + 2 per behaviour, at most 150, extended by
10 turns (at most +50% in all) when the latest refused finish, within the last 10 turns, had fewer
failing units than the one before. *Context overflow:* when the driver reports `context_overflow`
(`Driver.errorKind`), the request is shrunk once (1 recent turn, no working-set file text) and
resent, never resent unchanged; if that fails the run ends with `error`, and a `--baseline` request
is never shrunk.
*Rate limits:* a wait the driver reads from the error (`Driver.retryAfterMs`, else a standard
`Retry-After`) of at most 120 s is waited out; a longer one stops the run. Three turns without a
tool call end the run as `stalled`; SIGINT/SIGTERM stop it as `aborted` (exit 130/143) with the
evidence written and the final gates reported as not run.

**Isolation.** Agent-written code runs in the test runner, the contract extractor and the runtime
probes, each under the OS sandbox (`src/core/sandbox.ts`; `sandbox-exec` on macOS, `bwrap` on Linux):
writes only to a per-call temp dir; reads fenced to the enclosing worktree, the `node_modules`
chain, the node install and four harness files (`package.json`, `probe-runtime.ts`,
`contract-runtime.ts`, `node-test-reporter.mjs`), with the operator's home, the harness root and
credential stores refused; an env allow-list (`LANG`, `LC_*`, `TZ`, `CI` inherited; `PATH`, `HOME`,
`XDG_*`, `TMPDIR` set by the harness; provider keys and everything else dropped); loopback-only
network (none for contract extraction). In-process TypeScript programs over the agent's tsconfig
and imports (the strict type check behind `tsc-strict`, Contract Lock's program) read through a
fenced compiler host with the same allow-list (`src/core/ts-fence.ts`); `typecheck-feedback` does not
(§5). The runner's JSON report travels over a pipe on its fd 3 that test workers do not inherit; the
probe child only serves the app while the harness sends and judges every request. Without a working
sandbox a run refuses to start; `HARNESS_SANDBOX=off` runs unconfined and records `isolation` as
UNPROVEN. `harness doctor` self-tests the write, read, network and env boundaries.

## 2. Driver interface

The core speaks one neutral model (`src/core/types.ts`): `Message{role, parts}` with `text`,
`tool_call`, `tool_result` and `opaque` parts, and tools as plain JSON Schema from their Zod input.

```ts
interface Driver {
  name: string; model: string; tokenCounter: string;
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  countTokens(req: ModelRequest): Promise<number>;        // one counter for actual and baseline
  retryAfterMs?(error: unknown): number | null;            // the provider's rate-limit formats
  errorKind?(error: unknown): 'context_overflow' | null;   // the provider's overflow wording
}
```

`plugins/drivers/claude.ts` maps it to the Anthropic Messages API, `openai.ts` to Chat Completions
function tools (local o200k counting). On a 400 that rejects an optional parameter a driver switches
the session to a compatible request and reports `<id> (compat)`. Vendor shapes never cross the
interface: reasoning blocks and per-call extras (a thought signature) travel as `opaque` parts only
their own driver replays. Task files cannot name a model or provider, and `harness doctor` scans
`src/core/`, `tasks/` and every non-driver plugin file for provider vocabulary. `run.json`
fingerprints the task and every non-driver plugin file (`plugins/lib/**` included) and records
`governance`: the ACTIVE manifest (kind, name, file, sha256 of every enabled tool, hook, gate and
check), the governing config and its hash (`disabled`, sandbox mode, limits, ...), and a hash of
every `src/core/` file; plus the run's `verdict` and `gateStatuses`. `harness agnostic <runA> <runB>`
compares all of it (a field an older run.json lacks counts as a difference, UNPROVEN) and exits 0
only when nothing governing differs AND both runs are DONE.

## 3. How tokens are counted

Each turn the loop counts two requests with the driver's counter (both fall back to chars/4, and the
report's `counter` says so, if a count fails). **Actual (JIT):** a short system prompt with a
one-line-per-rule index, the brief with a file tree, context fetched on demand, compact tool returns,
tool inputs over 300 characters replayed as `<omitted N chars>`, turns older than the last 2 folded
into a digest, and a working set of folded reads (12,000 characters). **Baseline:** the same turn with
every text file of the API re-read from the current tree (200 KB cap), every standards doc, raw
returns, full history and no context fetchers.

A **shadow** baseline (`baseline_kind: shadow` in every `tokens/<runId>.json`) is rebuilt from the
JIT run's own trajectory and never sent, so it assumes the same turns with a bigger context. A
**measured** baseline is a real `--baseline` run (fetchers withheld, repository re-front-loaded every
turn, no compaction), compared by `harness tokens compare <jitRun> <baselineRun>`.

## 4. Extension mechanics

A plugin is a file under `plugins/` (`lib/`, `_*`, tests and `.d.ts` skipped) whose default export
comes from `defineTool`, `defineHook`, `defineGate`, `defineCheck` or `defineDriver`
(`src/core/plugin-api.ts`). Dropping it in is the whole registration: the registry discovers,
Zod-validates and fingerprints it. A new tool is offered on the next run; a new check gets report
lines, a rules-index line and a place in the `standards` gate (category `standards`: strict over the
whole API; other categories: only files the run changed, or in brownfield only what it introduced;
no findings = `n/a`). `"disabled"` in `harness.config.json` turns a plugin off. Plugins are trusted
code; the registry refuses plugin directories inside the worktree dir. **`src/core/` never changes
to extend:** `docs/extending.md` has type-checked examples, and `scripts/simulate-extensions.mjs`
adds the `examples/plugins/` versions to a throwaway copy and asserts that only `plugins/**` changed.

## 5. Honesty boundary in detail

**Fail-closed by construction.** A check or gate passes only on positive evidence; whatever it does not
model is UNPROVEN (or FAIL), never pass. Concretely:

- *Route rules* carry, per route, everything in its chain the analysis does not follow
  (`RouteInfo.unknowns` in `plugins/lib/api-ast.ts`): an unresolved, library or declared-only handler or
  middleware (body parsers, `cors`, `helmet`, `compression`, `morgan`, `cookie-parser` excepted), a `res`
  member that may send or set the status (`write`, `redirect`, `sendFile`, `format`, `statusCode =`,
  computed members, aliasing, `res` handed to code it cannot follow), a status that is not a constant
  (outside a recorded replay), an Express request member that may carry input (`req.param()`, `req.res`,
  …), and a router no followed mount serves. Each route rule reports such a route UNPROVEN unless it
  already fails.
- *Files*: JavaScript/JSX/TSX under the source roots is code no rule reads: UNPROVEN.
- *Schemas* are judged by construction as well as by output type (`z.any()`/`z.unknown()`/unchecked
  `z.custom()` roots, `.catch()` fallbacks), and a `safeParse` counts only where `success` is tested.
- *Runtime as a witness that can only withhold*: the probe runtime lists the routes the served app
  registers; a served route the static table lacks (`app.all`, loops, unmodelled registrations) or an
  analysed route the app does not serve is UNPROVEN, as is a probe answered by authentication before the
  route. The listing comes from agent code, so it never grants a pass.
- *Gates*: observed-red proves each changed file by reverting it alone; no source change, an inverted
  case (`it.fails`), a non-zero runner exit, test files the runner did not collect, a missing required
  gate, sandbox isolation off and similar run-level gaps keep a run from DONE.
- *Regression guard*: `npm run audit:mutations` applies 31 mutations to a shipped Users API (`test/fixtures/apis/audit-users-api`; broken
  standards and unmodelled constructs alike) and requires that none reads 100% under the full check. A
  new bypass is fixed in the checker and added to that list, never excused.


**Proven when the gates pass:** the tests pass when the harness runs them fresh; each changed source
file has a case seen red that now passes and fails again with the run-start source; pre-existing
cases were only appended to; strict `tsc` is clean with no `any`/`x!`/`@ts-ignore`; handlers parse
their inputs and 2xx bodies with Zod; every probed or statically seen error is
`application/problem+json`; routes follow the REST rules; created files are used; writes stayed in
scope; no breaking contract change (brownfield); the task's endpoints pass the field-spec probes
(structured greenfield); no secrets ship; agent code ran sandboxed.

**UNPROVEN, never green:** a crashed or skipped check, a standards rule with zero units, probes when
the app cannot start, a changed schema whose shape could not be extracted, a revert check that could
not run, an unsupported framework or runner, a skip the run introduced, an aborted run's gates,
`isolation: off`. `n/a` is never counted; a PR step without `gh` or a remote ends as `committed`.

**What the checks cannot see:**
- *Routes whose path the harness cannot resolve to a constant:* `rest-conventions` and
  `zod-boundary` report them UNPROVEN; Contract Lock leaves them out of the contract.
- *Frameworks other than Express:* every route-based check and Contract Lock understand Express
  only; preflight reports anything else as UNPROVEN.
- *Idempotency behaviour:* `rest-conventions` proves statically that each POST and PATCH chain stores
  a response keyed by the `Idempotency-Key` and replays it from the same store, judged by object
  identity (`plugins/lib/store-identity.ts`): the store must be one object created once that no code
  replaces, clears or leaks through any alias, property, helper or closure; anything it cannot
  establish (a key or store handed to code it cannot follow, dynamic code, a library subclass) is
  UNPROVEN. A replay counts only when the response body is the stored value itself (the lookup, a
  property of it, a wrapper object around it, or `Schema.parse` of it); a body rebuilt from the
  current row does not. That static acceptance is never enough on its own: the runtime replay probe
  sends each such POST or PATCH twice with one key (creating parent resources through their collection
  POST to fill path parameters) and fails a retry that is not replayed. When it cannot run, for
  example because no valid body can be generated from the route's schema, the route is UNPROVEN, not
  passed; a person can resolve it by adding a valid body to `harness.probe.json` in the API root
  (`{"POST /users": {"body": {"email": "u-{{unique}}@example.com"}}}`; `{{unique}}` is replaced
  per request). The probe cannot see retries after other writes or concurrency. `spec-coverage` also probes replays (an immediate retry,
  and a retry after the resource was updated), only on structured greenfield tasks.
- *Other error paths:* the runtime probes cover an unknown path, malformed JSON, an invalid body, a
  missing `Idempotency-Key`, an unknown id and an injected 500; the rest is judged statically.
- *Schema intent:* `zod-boundary` proves parsing with constraining schemas, not that the schemas
  match the task; only `spec-coverage` compares behaviour with the field specs.
- *Behaviour behind an unchanged schema:* Contract Lock misses filtering, sorting and cursor
  meaning, which condition yields which status (non-2xx statuses are a set per endpoint), response
  headers, and constraints that live only in `.refine`/`.transform` (UNPROVEN, not classified).
- *Free-text behaviours* are checked only by the agent's own tests: a free-text greenfield task's
  `spec-coverage` is UNPROVEN (never DONE) unless the task opts out with `specCoverage: human`
  (then `n/a`, and a human verifies behaviour coverage).

**A human still verifies** that the agent's tests test the intended behaviour (any failing
non-constant assertion on source values counts as red), changes admitted with `allowBreaking`,
pre-existing violations and skips the baselines list, and persistence, performance, security and
concurrency.

**Residual risks:**
- An app that detects the probes could serve something else in production.
- The revert check reverts each changed file alone in an identical fresh copy, but cannot prove a test
  checks the intended behaviour.
- On macOS a detached process started by a test outlives the run (still confined, not killed).
- The Linux `bwrap` path is tested on its argument list only, the jest adapter on recorded reports
  only.
