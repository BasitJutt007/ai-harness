# A health check route for the Projects API

Problem: The Projects API in samples/existing-api has no health check, so a load balancer or a deploy check can only probe it through a real route, which needs data and can fail for reasons that are not about whether the service is up. At rubric-01 the API serves only the projects routes and no GET /v1/health.
Owner: sf-harness demo (Abdul Basit)
Stakeholder: Abdul Basit
Repo: BasitJutt007/harness-demo
Base: rubric-01
Commit: feat(health): add a health check route to the Projects API
Metric: Health check routes the demo Projects API does not register, rubric-01 HEAD before: 1 after: ____
Measure: node metrics/demo-routes.mjs samples/existing-api GET:/v1/health
Scenario: WHEN a client calls GET /v1/health THEN the API answers 200 application/json { "status": "ok" }
Scenario: WHEN a client calls any route the API served before THEN it behaves exactly as before (the contract only gains a route)
Not included:
- checks of dependencies (the store is in memory; there is nothing to probe)
- authentication on the health route
- merging into main: a re-run's PR targets rubric-01, as the other demo items do
