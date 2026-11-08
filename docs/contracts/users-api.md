# Users API (the 01 greenfield task, re-run under the 02 gates)

Problem: The 01 rubric is re-run on both drivers with every 02 gate in place, and no run edits anything without an approved contract, so the 01 greenfield task needs one. The demo repository needs a Users REST API built from tasks/users-api.task.yaml: create, list with cursor pagination, get, update and delete users, problem+json errors and idempotent creates. At rubric-01 (harness-demo before the 01 pull requests merged) generated/users-api does not exist, so none of its five routes is served.
Owner: sf-harness 01 demo (Abdul Basit)
Stakeholder: Abdul Basit
Repo: BasitJutt007/harness-demo
Base: rubric-01
Commit: feat(users): add the Users API with cursor pagination and idempotent creates
Metric: Users API routes of tasks/users-api.task.yaml the demo app does not register, rubric-01 HEAD before: 5 after: ____
Measure: node metrics/demo-routes.mjs generated/users-api POST:/v1/users GET:/v1/users GET:/v1/users/:userId PATCH:/v1/users/:userId DELETE:/v1/users/:userId
Scenario: WHEN a client POSTs a valid user THEN the API answers 201 with a Location header pointing at the new user
Scenario: WHEN a client follows nextCursor through GET /v1/users THEN it visits every user exactly once
Scenario: WHEN a request body, query or path parameter is invalid THEN the API answers 422 application/problem+json naming each failing field
Scenario: WHEN a POST repeats an Idempotency-Key with the same body THEN the original response is replayed and no second user is created
Not included:
- persistence beyond the process (the store is in memory, as in 01)
- authentication and authorization
- merging into main: main already holds the 01 result (harness-demo #10); a re-run's PR targets rubric-01
Signed: Abdul Basit, 2026-11-08 (recorded by the harness from the typed reply at ledger seq 3; the human-yes gate reads the ledger, not this line)
