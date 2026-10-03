# Extending sf-ai-harness

**The core engine is `src/core/` — extensions never edit it.**

Every capability the harness has (model drivers, the tools the agent calls, the hooks
that police those calls, the gates that decide "done", and the standards checks) is a
plugin: a file under a plugin directory whose default export is one of the `define*`
values from `src/core/plugin-api.ts` (or an array of them). Adding the file is the whole
registration step. There is no list to edit and no core change.

```
plugins/
  drivers/   a model provider behind the neutral Driver interface (the only place a provider may be named)
  tools/     what the agent can call
  hooks/     pre/post tool-call policy (fail closed)
  gates/     finish/ship conditions (skip = UNPROVEN, never green)
  checks/    standards, ORM and lint rules for `harness check` and the standards gate
  lib/       shared helpers, not plugins (never loaded by the registry)
```

The sub-folder is for humans: discovery goes by the exported `kind`, not the folder name.

## The three graded additions

Each one is a single new file. After adding it, `git diff --stat` / `git status` show that
file and nothing else (nothing under `src/core/`, no registry to edit).

### 1. A new tool: `openapi-diff`

Tool names may use kebab-case. This one compares `openapi.json` with the routes the code
implements, reusing the contract extractor from `plugins/lib/contract.ts`:

```ts
// file: plugins/tools/openapi-diff.ts
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';
import { extractContract } from '../lib/contract.ts';

const OpenApi = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) });
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
/** "GET /v1/users/{}" for both "/v1/users/{userId}" (OpenAPI) and "/v1/users/:userId" (Express). */
const key = (method: string, path: string): string => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}|:[^/]+/g, '{}')}`;

export default defineTool({
  name: 'openapi-diff',
  description: 'Compare openapi.json with the routes the code actually implements.',
  input: z.object({ spec: z.string().optional().describe('OpenAPI JSON file, relative to the API root (default openapi.json).') }),
  effect: 'exec',
  async run(input, ctx) {
    const specPath = input.spec ?? 'openapi.json';
    const text = await ctx.workspace.read(specPath);
    if (text === null) return { ok: false, summary: `openapi-diff: ${specPath} does not exist` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, summary: `openapi-diff: ${specPath} is not JSON` };
    }
    const spec = OpenApi.safeParse(parsed);
    if (!spec.success) return { ok: false, summary: `openapi-diff: ${specPath} has no "paths" object` };
    const documented = new Set(Object.entries(spec.data.paths).flatMap(([path, ops]) =>
      Object.keys(ops).filter((m) => METHODS.has(m)).map((m) => key(m, path))));
    const contract = await extractContract({ apiRoot: ctx.workspace.root, harnessRoot: ctx.run.harnessRoot, exec: ctx.exec });
    const implemented = new Set(contract.endpoints.map((e) => key(e.method, e.path)));
    const lines = [
      ...[...documented].filter((k) => !implemented.has(k)).map((k) => `documented, not implemented: ${k}`),
      ...[...implemented].filter((k) => !documented.has(k)).map((k) => `implemented, not documented: ${k}`),
    ];
    return { ok: true, summary: lines.length === 0 ? `openapi-diff: all ${documented.size} documented routes match` : lines.join('\n') };
  },
});
```

`harness plugins` then lists `openapi-diff` (`[exec]`, from `plugins/tools/openapi-diff.ts`), and the next run offers it to the model.
Against `samples/existing-api` with an `openapi.json` that documents a `DELETE` but not the
`PATCH`, it returns `documented, not implemented: DELETE /v1/projects/{}` and
`implemented, not documented: PATCH /v1/projects/{}`.

### 2. A custom ORM validator: explicit columns on users

"Every Prisma or Drizzle query on users must select explicit columns." Category `orm`,
one finding per file that queries users, one violation (with `file:line:col`) per offending
call:

```ts
// file: plugins/checks/orm-users-select.ts
import ts from 'typescript';
import { defineCheck, fileFinding, hasProperty, nodeLocation, walk } from '../lib/plugin-helpers.ts';
import type { CheckFinding, Violation } from '../lib/plugin-helpers.ts';

const RULE = 'orm-users-select';
const USERS = /^users?$/;
const READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow']);

/** A Prisma or Drizzle query on users: undefined if `call` is not one, else whether it lists its columns. */
function usersQuery(call: ts.CallExpression): { ok: boolean; message: string } | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  const recv = call.expression.expression;
  // Prisma: prisma.user.findMany({ select: { id: true } }); Drizzle: db.query.users.findMany({ columns: { id: true } })
  if (READS.has(method) && ts.isPropertyAccessExpression(recv) && USERS.test(recv.name.text)) {
    const owner = recv.expression;
    const orm = ts.isPropertyAccessExpression(owner) && owner.name.text === 'query' ? 'drizzle' : 'prisma';
    const prop = orm === 'drizzle' ? 'columns' : 'select';
    const arg = call.arguments[0];
    const ok = arg !== undefined && ts.isObjectLiteralExpression(arg) && hasProperty(arg, prop);
    return { ok, message: `${orm} ${recv.name.text}.${method} without { ${prop}: { … } }` };
  }
  // Drizzle: db.select({ id: users.id }).from(users)
  const table = call.arguments[0];
  if (method === 'from' && table !== undefined && ts.isIdentifier(table) && USERS.test(table.text)
    && ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === 'select') {
    return { ok: recv.arguments.length > 0, message: 'drizzle select().from(users) without a column map' };
  }
  return undefined;
}

export default defineCheck({
  id: RULE,
  category: 'orm',
  description: 'Every Prisma or Drizzle query on users selects explicit columns.',
  unit: 'queries',
  async run(ctx) {
    const out: CheckFinding[] = [];
    for (const file of ctx.sourceFiles) {
      const sf = ctx.sourceFile(file);
      let total = 0;
      const violations: Violation[] = [];
      walk(sf, (n) => {
        const q = ts.isCallExpression(n) ? usersQuery(n) : undefined;
        if (q === undefined) return;
        total++;
        if (!q.ok) violations.push({ location: nodeLocation(sf, n, file), message: q.message });
      });
      const finding = fileFinding(RULE, file, total, violations); // null when the file has no users query
      if (finding !== null) out.push(finding);
    }
    return out; // [] on an API without such queries: reported n/a, not counted
  },
});
```

With the file in `plugins/checks/`, `harness check --api test/fixtures/orm --rule orm-users-select`
prints (and exits 1):

```
orm-users-select  FAIL  src/db/drizzle-users.ts          3/5 queries
    src/db/drizzle-users.ts:7:10  drizzle select().from(users) without a column map
    src/db/drizzle-users.ts:15:10  drizzle users.findFirst without { columns: { … } }
orm-users-select  FAIL  src/db/prisma-users.ts           2/4 queries
    src/db/prisma-users.ts:7:10  prisma user.findMany without { select: { … } }
    src/db/prisma-users.ts:11:10  prisma user.findUnique without { select: { … } }
```

On `samples/existing-api` (no ORM) the rule returns no findings, so it prints an `n/a`
line (`(none)  0/0 queries`) and does not count toward the verdict. The fuller version in
`examples/plugins/checks/orm-explicit-columns.ts` also covers Prisma writes,
`getTableColumns`, `.returning()` and raw `SELECT *`.

### 3. A linter rule

The `no-todo` rule under [Check](#check-standards-orm-and-lint-rules) below is a complete
lint rule: category `lint`, its own pass/FAIL line per file, and each violation as
`file:line:col  message`. `examples/plugins/checks/no-console.ts` is a fuller one (AST based,
with allow-listed methods and files).

### Ready-made copies and the simulation

`examples/plugins/` holds drop-in versions (inactive until copied):

| extension | copy | what you then see |
|---|---|---|
| new tool | `cp examples/plugins/tools/openapi_diff.ts plugins/tools/` | `harness plugins` lists `openapi_diff`; the next run offers it to the model (`runs/<id>/run.json` fingerprint lists the file) |
| ORM validator | `cp examples/plugins/checks/orm-explicit-columns.ts plugins/checks/` | `harness check --api <dir>` prints `orm-explicit-columns` lines; `n/a` on an API with no Prisma/Drizzle queries on users |
| lint rule | `cp examples/plugins/checks/no-console.ts plugins/checks/` | `harness check --api <dir>` prints one `no-console` line per file, failing files followed by `file:line:col  message` |

```bash
node scripts/simulate-extensions.mjs            # all three, in a throwaway copy of the repo
# after copying the two checks into plugins/checks/:
node bin/harness.mjs check --api test/fixtures/orm --rule orm-explicit-columns --rule no-console
```

`scripts/simulate-extensions.mjs` copies the repo to `.harness/tmp/<unique>/repo`, commits it,
drops each example into `plugins/`, runs `harness plugins` and `harness check`, runs one
offline scripted run that calls the new tool, prints `git diff --stat` and
`git status --porcelain` after each step, and fails unless every changed path is under
`plugins/` and the sha256 of `src/core/**` is unchanged. `--no-run` skips the scripted run;
`--keep` keeps the sandbox.

## What the core guarantees to every plugin

- **Discovery.** Each entry of `pluginDirs` in `harness.config.json` (default `["plugins"]`)
  is scanned recursively for `.ts`, `.mts`, `.js` and `.mjs` files, skipping `lib/`,
  `node_modules/` and dot-directories, files or directories starting with `_`,
  `*.test.*` / `*.spec.*` and `*.d.ts`. Files are loaded in sorted path order, so tools,
  hooks, gates and checks run in a deterministic order (`checks/a.ts` before `checks/b.ts`).
- **Trust.** Plugins are trusted code: a file is executed when it is imported (like an eslint
  or Vitest plugin), before validation runs. Only point `pluginDirs` at code you trust. The
  registry refuses, without importing, any plugin dir inside the worktree dir
  (`.harness/worktrees/`), because agent output lives there.
- **Validation.** Every exported value is checked with Zod before it is registered:
  `kind`, a non-empty name or id, the required functions, and a Zod schema as a tool's
  `input`. Tool names must match `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`, so `read_file` and
  `openapi-diff` are both valid. `description` is optional for tools, hooks, gates and checks
  (it defaults to the name or id), and so are a check's `unit` (default `units`) and `doc`
  (default: its description). A file that fails to import, has no default export or exports
  a malformed plugin is reported by `harness plugins` / `harness doctor` with the reason,
  and `harness run` refuses to start. A second plugin with the same kind and name is an
  error; the first one wins.
- **Disabling.** `"disabled": ["openapi_diff", "check:no-console"]` in
  `harness.config.json` turns a plugin off by name, or by `kind:name` when names collide.
  Deleting the file works too.
- **Fingerprints.** Every tool, hook, gate and check file, and every shared helper they can
  import (any other `.ts`/`.mts`/`.js`/`.mjs` under a plugin directory, e.g. `plugins/lib/**`),
  is sha256-fingerprinted into `runs/<id>/run.json`; `harness agnostic <runA> <runB>` proves two
  runs used identical ones. Driver code (files loaded as driver plugins and the `drivers/` folder)
  is excluded, because it legitimately differs between two drivers' runs. `run.json` also lists
  `toolsOffered` (tool names in the order the model got them) and `checksRegistered`.
- **Fail closed.** A hook that throws or returns a malformed verdict blocks the call. A gate
  that throws or returns a malformed result is `unproven`. A check that throws becomes a
  `skip` finding, and a skipped rule makes the verdict `UNPROVEN`. Skipped is never green.
- **Isolation.** Plugins import from `src/core/plugin-api.ts` (types and `define*`), from
  `plugins/lib/*.ts` (which re-exports the plugin API in `plugin-helpers.ts`) and from
  packages. The core never imports a plugin statically.

## Tool

```ts
interface ToolPlugin<I> {
  kind: 'tool';
  name: string;                 // /^[A-Za-z][A-Za-z0-9_-]{0,63}$/: what the model calls ('read_file', 'openapi-diff')
  description?: string;         // one or two sentences: all the model learns up front (default: the name)
  input: z.ZodType<I>;          // converted to a neutral JSON Schema by the core
  effect: 'read' | 'write' | 'exec' | 'control';   // hooks select on this
  availableIn?: ('greenfield' | 'brownfield')[];    // default: both
  paths?(input: I): string[];   // API-relative paths touched (REQUIRED for write tools)
  run(input: I, ctx: RunContext): Promise<ToolResult>;  // { ok, summary, raw?, data? }
}
```

```ts
// plugins/tools/count_lines.ts
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin-api.ts';

export default defineTool({
  name: 'count_lines',
  description: 'Count the lines of a file in the API.',
  input: z.object({ path: z.string().describe('File path relative to the API root.') }),
  effect: 'read',
  async run(input, ctx) {
    const text = await ctx.workspace.read(input.path);
    if (text === null) return { ok: false, summary: `${input.path} does not exist` };
    return { ok: true, summary: `${input.path}: ${text.split('\n').length} lines` };
  },
});
```

The core guarantees:

- The tool appears in the next run's tool list for every task kind it is available in.
- Input is validated with the tool's own Zod schema before `run`. An invalid input goes back
  to the model as an error that lists the issues.
- Every pre/post hook whose `effects`/`tools` filter matches runs around the call. A
  `write` tool that declares no `paths()` is blocked by `path-guard`, because a write that
  cannot be checked is refused.
- Keep `summary` compact. It is what the model sees in normal (JIT) mode. `raw` is shown
  only in `--baseline` mode, and for `exec` and `write` tools it is written to
  `runs/<id>/logs/` when it is over 2 KB. `data` is for hooks and gates and is never shown.
  A tool that throws becomes an error result.

## Check (standards, ORM and lint rules)

```ts
interface CheckPlugin {
  kind: 'check';
  id: string;           // rule id printed in the report
  category: string;     // 'standards' (the graded four), 'orm', 'lint', or any label
  description?: string; // one line; also listed in the agent's system prompt rules index (default: the id)
  unit?: string;        // plural noun for "n/m <unit>" ('files', 'queries', 'routes'); 'errors' prints "N errors" (default: 'units')
  doc?: string;         // full rule text, served on demand by the fetch_standard tool (default: the description)
  run(ctx: CheckContext): Promise<CheckFinding[]>;
}
// CheckContext: root, sourceFiles (src/**/*.ts minus tests), testFiles, read(rel),
//   sourceFile(rel) (parsed, cached), program() (strict ts.Program, cached), exec, harnessRoot, logs,
//   taskKind? ('greenfield' | 'brownfield'; absent for `harness check`),
//   base? ({ repoRoot, rootRel, sha } of the run's base commit; absent for `harness check`),
//   dependencies() (merged dependencies + devDependencies of <root>/package.json, {} if none)
// CheckFinding: { rule, file, status: 'pass'|'fail'|'skip', units: { passed, total }, violations: [{ location: 'src/x.ts:12:5', message }], skipReason? }
```

```ts
// plugins/checks/no-todo.ts
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';

export default defineCheck({
  id: 'no-todo',
  category: 'lint',
  description: 'No TODO comments in src/**.',
  unit: 'files',
  async run(ctx) {
    const out: CheckFinding[] = [];
    for (const file of ctx.sourceFiles) {
      const violations = (await ctx.read(file)).split('\n').flatMap((line, i) =>
        line.includes('TODO') ? [{ location: `${file}:${i + 1}:${line.indexOf('TODO') + 1}`, message: 'TODO left in code' }] : []);
      out.push({ rule: 'no-todo', file, status: violations.length > 0 ? 'fail' : 'pass',
        units: { passed: violations.length > 0 ? 0 : 1, total: 1 }, violations });
    }
    return out;
  },
});
```

Output: one line per rule per file, violations indented under failing lines, then a summary
line per rule and the verdict:

```
no-todo           pass  src/app.ts                       1/1 files
no-todo           FAIL  src/routes/users.ts              0/1 files
    src/routes/users.ts:14:5  TODO left in code
────────────────────────────────────────────────────────────
no-todo           FAIL     7/8 files
verdict           87%     → failing: no-todo
```

The core guarantees:

- The rule joins `harness check`, the `check_standards` tool (compact: only failing lines,
  25 violations at most) and the `standards` gate, so a dropped-in lint or ORM rule can block
  finish and ship. The gate is **diff-aware for rules outside the `standards` category**: their
  violations block only in files this run changed (new, or content different from the run-start
  snapshot). Violations in unchanged files (a greenfield scaffold, brownfield files the task
  scope denies, which path-guard keeps read-only) are listed in the gate details as
  `pre-existing (not blocking): <rule> <location>` and the gate summary says how many there
  are. The four `standards` rules stay strict over the whole API: 100% or refuse. A skipped
  rule of any category still makes the gate `unproven`.
- `harness check --rule <id>` with an id no check has, or `--category <c>` that no check has, is a
  usage error (exit 2) that lists the registered rule ids.
- Its `description` appears in the agent's system prompt rules index, and its `doc` is
  served by `fetch_standard <id>`.
- **Not applicable means no findings.** A non-`standards` rule that returns `[]` (or only
  `0/0` findings) has status `n/a`: it prints `n/a (none) 0/0 <unit>`, does not count toward the
  verdict, and is listed under `n/a` (never `proven`) in `run.json`'s honesty section. Use this when the API has
  nothing to check, e.g. an ORM rule on an API without an ORM (`fileFinding` from
  `plugins/lib/plugin-helpers.ts` returns null for a file with nothing to check). A
  `standards` rule with 0 units is `unproven` (its per-file lines say `unproven` too), because
  an empty check never proves compliance. Do not emit a vacuous `pass` with `0/0`.
- A rule that throws is reported as `skip` with the error, and the verdict becomes
  `UNPROVEN`. Return a `skip` finding yourself when you cannot prove the rule, for example
  when a tool you need will not run.
- Optional helpers live in `plugins/lib/plugin-helpers.ts`: `nodeLocation`, `walk`,
  `fileFinding`, `lastName` and `hasProperty`. It also re-exports the whole plugin API.

## Hook

```ts
interface HookPlugin {
  kind: 'hook';
  name: string;
  description?: string;
  events: ('pre_tool' | 'post_tool')[];
  effects?: ToolEffect[];   // only calls of tools with these effects (default: all)
  tools?: string[];         // only these tool names (default: all)
  run(event: HookEvent, ctx: RunContext): Promise<
    { decision: 'pass' } | { decision: 'block'; reason: string } | { decision: 'record'; note: string }>;
}
```

```ts
// plugins/hooks/no-migrations.ts
import { defineHook } from '../../src/core/plugin-api.ts';

export default defineHook({
  name: 'no-migrations',
  description: 'Blocks writes to migrations/.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event) {
    const hit = event.call.paths.find((p) => p.startsWith('migrations/'));
    return hit === undefined ? { decision: 'pass' } : { decision: 'block', reason: `no-migrations: ${hit} is generated` };
  },
});
```

The core guarantees: hooks run in discovery order, and the first `block` wins (on
`pre_tool` the tool does not run and the model gets `reason`). A `record` note is logged
and added to the model-visible result. A hook that throws or returns anything malformed
blocks the call (fail closed). Every decision is written to `runs/<id>/events.jsonl`.

## Gate

```ts
interface GatePlugin {
  kind: 'gate';
  name: string;
  description?: string;
  phases: ('finish' | 'ship')[];
  appliesTo?: ('greenfield' | 'brownfield')[];   // others → n/a, not run
  run(ctx: RunContext, phase: 'finish' | 'ship'): Promise<{
    status: 'pass' | 'fail' | 'unproven' | 'n/a'; summary: string; details?: string[]; logPath?: string }>;
}
```

```ts
// plugins/gates/has-readme.ts
import { defineGate } from '../../src/core/plugin-api.ts';

export default defineGate({
  name: 'has-readme',
  description: 'The API has a README.md.',
  phases: ['finish', 'ship'],
  async run(ctx) {
    return (await ctx.workspace.exists('README.md'))
      ? { status: 'pass', summary: 'README.md present' }
      : { status: 'fail', summary: 'README.md missing', details: ['add README.md at the API root'] };
  },
});
```

The core guarantees: finish (and ship) succeed only if no gate is `fail` or `unproven`
and at least one gate passed. Gates are re-run fresh at the end of a run and again before
shipping, so cached results are never trusted. A gate that throws is `unproven`. The
`details` of a failing or unproven gate are what the model sees in `FINISH REFUSED`.

## Driver

```ts
interface DriverPlugin {
  kind: 'driver';
  name: string;           // the value of --driver
  description: string;
  create(opts: { model?: string; options: Record<string, string>; env: NodeJS.ProcessEnv; harnessRoot: string }): Driver;
}
interface Driver {
  readonly name: string;
  readonly model: string;          // from --model or the driver's own env var, never from a task file
  readonly tokenCounter: string;   // label of the method countTokens uses
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  countTokens(req: ModelRequest): Promise<number>;
}
```

```ts
// plugins/drivers/echo.ts: a toy driver that always finishes
import { defineDriver } from '../../src/core/plugin-api.ts';

export default defineDriver({
  name: 'echo',
  description: 'Calls finish immediately (demo only).',
  create: () => ({
    name: 'echo',
    model: 'echo-1',
    tokenCounter: 'chars/4',
    countTokens: async (req) => Math.ceil(JSON.stringify(req).length / 4),
    complete: async () => ({
      parts: [{ type: 'tool_call', id: 'c1', name: 'finish', input: { summary: 'done' } }],
      stop: 'tool_calls',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'echo-1',
    }),
  }),
});
```

A driver translates the neutral `ModelRequest` (system text, provider-neutral messages, and
tools as plain JSON Schema) to its provider's wire format and back. **Only
`plugins/drivers/` may name a provider, import a provider SDK or read a provider
credential.** Task files, tools, hooks, gates, checks, prompts and `src/core/` stay
neutral, and `harness doctor` scans for leaks. The core counts tokens with
`countTokens` for both the actual and the shadow-baseline request every turn
(`tokens/<runId>.json`). Driver files are excluded from the run fingerprint, so the same
task can run on two drivers and `harness agnostic` still shows zero diff.

Real endpoints taught four rules (see `runs/real-model/`):
- **Replay what the provider needs back.** Anything that must come back verbatim on later turns
  travels as an `opaque` part tagged with your driver's name, and only your driver reads it.
  Examples: reasoning blocks, or the openai driver's per-tool-call extras, such as a thought
  signature.
- **Keep the provider's status and error text in the error you throw.** The loop recognises a
  rate limit from `status: 429`, or from `429`, `rate limit`, `RESOURCE_EXHAUSTED` or `quota` in
  the message. It reads the stated wait (`retryDelay`, "retry in 37.6s", `Retry-After`, or an
  `X-RateLimit-Reset` epoch timestamp) from the message too. It waits out a wait of 120 s or less and stops the
  run on a longer one.
- **If the endpoint cannot count tokens, let `countTokens` throw.** The loop then estimates
  chars/4 for both the actual and the baseline request, logs that in `events.jsonl`, and the
  token report's `counter` names the fallback instead of your counter.
- **Downgrade a rejected optional parameter once, and say so.** When a 400 names a parameter
  you can drop or change, retry the session with a compatible request and report the model as
  `<id> (compat)`. Example: the openai driver retries with `reasoning_effort: 'none'` when
  `gpt-6-luna` rejects function tools with reasoning on (`test/drivers/openai-reasoning.test.ts`).

## If the core lacks something

Do not edit `src/core/`. Put shared logic in `plugins/lib/` and keep the plugin to one
file. If a plugin needs data the plugin API does not expose, raise it as a change to the
contracts in `src/core/types.ts`, kept separate from the extension.
