# Delete projects and filter by status (the 01 brownfield task, re-run under the 02 gates)

Problem: The 01 rubric is re-run on both drivers with every 02 gate in place, and no run edits anything without an approved contract, so the 01 brownfield task needs one. Clients of the Projects API in samples/existing-api cannot delete a project or filter the project list by status (tasks/projects-change.task.yaml). At rubric-01 (harness-demo before the 01 pull requests merged) the API serves list, create, get and patch, and no DELETE route.
Owner: sf-harness 01 demo (Abdul Basit)
Stakeholder: Abdul Basit
Repo: BasitJutt007/harness-demo
Base: rubric-01
Commit: feat(projects): delete projects and filter the project list by status
Metric: Projects API routes the change adds that the demo app does not register, rubric-01 HEAD before: 1 after: 0
Measure: node metrics/demo-routes.mjs samples/existing-api DELETE:/v1/projects/:projectId
Scenario: WHEN a client deletes an existing project THEN the API answers 204 and a later GET of it answers 404
Scenario: WHEN a client lists projects with status=archived THEN only archived projects are returned, still cursor-paginated
Scenario: WHEN a client calls any route the API served before THEN it behaves exactly as before (the contract only gains routes and properties)
Not included:
- the status filter in the metric: the run's tests and the contract lock prove it; the metric counts routes only
- bulk delete and soft delete
- merging into main: main already holds the 01 result (harness-demo #11); a re-run's PR targets rubric-01
Signed: Abdul Basit, 2026-11-08 (recorded by the harness from the typed reply at ledger seq 3; the human-yes gate reads the ledger, not this line)
