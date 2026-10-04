# The two governed APIs

What the harness produced and shipped for the two tasks, copied from the shipped commits (not edited
by hand). Both runs used the final harness code: every plugin and `src/core` hash in their `run.json`
matches the committed files.

| folder | task | run (evidence) | model | shipped as |
|---|---|---|---|---|
| `users-api/` | greenfield `tasks/users-api.task.yaml` | `runs/users-api-openai-20261004-145143/` | `gpt-5.6-luna` | commit `e9dc209` in [BasitJutt007/harness-demo#10](https://github.com/BasitJutt007/harness-demo/pull/10) |
| `projects-change/` | brownfield `tasks/projects-change.task.yaml` on `samples/existing-api` | `runs/projects-change-openai-20261004-145700/` | `gpt-5.6-luna` | commit `073f91c` in [BasitJutt007/harness-demo#11](https://github.com/BasitJutt007/harness-demo/pull/11) |

- **`users-api/`**: the `templates/express-zod` scaffold plus what the model wrote (`src/routes/index.ts`
  and `test/users.test.ts`).
- **`projects-change/`**: `samples/existing-api` after the change (delete a project, filter the list by
  status); `projects-change.diff` is the shipped commit.

```bash
node bin/harness.mjs check --api governed/users-api        # verdict 100%
node bin/harness.mjs check --api governed/projects-change  # verdict 100%
```
