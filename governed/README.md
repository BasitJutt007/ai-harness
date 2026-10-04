# The two governed APIs

What the harness produced for the two tasks, copied from the runs' worktrees (not edited by hand),
so they can be read and checked from this repository. Both come from the scaffold with the fixed
idempotency helper (replays send the original bytes, even after the resource was updated).

| folder | task | run (evidence) | model |
|---|---|---|---|
| `users-api/` | greenfield `tasks/users-api.task.yaml` | `runs/users-api-openai-20261004-073321/` | `gpt-5.6-luna` |
| `projects-change/` | brownfield `tasks/projects-change.task.yaml` on `samples/existing-api` | `runs/projects-change-openai-20261004-081959/` | `gpt-5.6-luna` |

- **`users-api/`**: the `templates/express-zod` scaffold plus what the model wrote: `src/routes/index.ts`
  and `test/users.test.ts` (`package.json` differs only by the API's name). The run used the code of a
  few commits before the final one; `ship-dry-run-final-code.txt` in its run directory re-ran every gate
  of the final code on this output: all green (spec-coverage 18/18, 32/32 tests, standards 100%).
- **`projects-change/`**: `samples/existing-api` after the change; `projects-change.diff` is the exact
  change. That run used the final code (every plugin fingerprint matches).

Check them yourself (no keys needed; dependencies resolve from the harness):

```bash
node bin/harness.mjs check --api governed/users-api        # verdict 100%
node bin/harness.mjs check --api governed/projects-change  # verdict 100%
```

The pull requests on `BasitJutt007/harness-demo` (#1–#4) came from earlier runs; the README's evidence
section says which code each one used.
