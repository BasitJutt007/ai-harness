# The two governed APIs

What the harness produced and shipped for the two tasks, copied from the shipped commits (not edited
by hand), so they can be read and checked from this repository. Both runs used the final code: every
plugin fingerprint in their `run.json` matches the committed files.

| folder | task | run (evidence) | model | shipped as |
|---|---|---|---|---|
| `users-api/` | greenfield `tasks/users-api.task.yaml` | `runs/users-api-openai-20261004-084807/` | `gpt-5.4` | commit `266c5b4` in [BasitJutt007/harness-demo#7](https://github.com/BasitJutt007/harness-demo/pull/7) |
| `projects-change/` | brownfield `tasks/projects-change.task.yaml` on `samples/existing-api` | `runs/projects-change-openai-20261004-085129/` | `gpt-5.6-luna` | commit `89f0d04` in [BasitJutt007/harness-demo#8](https://github.com/BasitJutt007/harness-demo/pull/8) |

- **`users-api/`**: the `templates/express-zod` scaffold plus what the model wrote: `src/routes/index.ts`,
  `src/routes/users.ts` and `test/users.test.ts` (`package.json` differs only by the API's name).
- **`projects-change/`**: `samples/existing-api` after the change; `projects-change.diff` is the shipped commit.

Both come from the scaffold with the fixed idempotency helper: a replay sends the original response
bytes, even after the resource was updated (spec-coverage probes this: 18/18 on the greenfield run).

```bash
node bin/harness.mjs check --api governed/users-api        # verdict 100%
node bin/harness.mjs check --api governed/projects-change  # verdict 100%
```
