# A Labels resource for the Projects API

Problem: Clients of the Projects API in samples/existing-api have no way to keep a shared set of labels (a name and a colour) to tag work with, so each client invents its own. At rubric-01 the API serves only the projects routes and no labels route.
Owner: sf-harness demo (Abdul Basit)
Stakeholder: Abdul Basit
Repo: BasitJutt007/harness-demo
Base: rubric-01
Commit: feat(labels): add a Labels resource to the Projects API
Metric: Labels routes the demo Projects API does not register, rubric-01 HEAD before: 3 after: ____
Measure: node metrics/demo-routes.mjs samples/existing-api POST:/v1/labels GET:/v1/labels GET:/v1/labels/:labelId
Scenario: WHEN a client creates a valid label THEN the API answers 201 with the label and a Location header
Scenario: WHEN a client follows nextCursor through GET /v1/labels THEN it visits every label exactly once
Scenario: WHEN a client calls any route the API served before THEN it behaves exactly as before (the contract only gains routes)
Not included:
- attaching labels to projects (a later item)
- updating or deleting labels
- persistence beyond the process (the store is in memory, as for projects)
Signed: Abdul Basit, 2026-11-08 (recorded by the harness from the typed reply at ledger seq 3; the human-yes gate reads the ledger, not this line)
