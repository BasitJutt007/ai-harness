# The two governed APIs

Snapshots of what the harness produced and shipped, so they can be read and checked from this
repository. They are copies of the shipped commits, not edited by hand.

| folder | task | run (evidence) | model | shipped as |
|---|---|---|---|---|
| `users-api/` | greenfield `tasks/users-api.task.yaml` | `runs/users-api-openai-20261004-045649/` | `gpt-5.4` | commit `196b853` in [BasitJutt007/harness-demo#1](https://github.com/BasitJutt007/harness-demo/pull/1) |
| `projects-change/` | brownfield `tasks/projects-change.task.yaml` on `samples/existing-api` | `runs/projects-change-openai-20261004-052623/` | `gpt-5.6-luna` | commit `e65eff8` in [BasitJutt007/harness-demo#2](https://github.com/BasitJutt007/harness-demo/pull/2) |

- **`users-api/`**: the `templates/express-zod` scaffold plus what the model wrote. The scope gate
  recorded 2 changed files: `src/routes/index.ts` and `test/users.test.ts`.
- **`projects-change/`**: `samples/existing-api` after the change. `projects-change.diff` is the exact
  change (4 files: routes, schema, store, and appended test cases).

Check them yourself (no keys needed; dependencies resolve from the harness):

```bash
node bin/harness.mjs check --api governed/users-api        # verdict 100%
node bin/harness.mjs check --api governed/projects-change  # verdict 100%
```

Every gate the harness ran on them is in each run's `gates.json` and `ship.txt` (re-run fresh at
ship time). What the gates do not prove (free-text behaviours, test adequacy) is listed in each
run's `run.json` under `honesty.humanMustVerify`.
