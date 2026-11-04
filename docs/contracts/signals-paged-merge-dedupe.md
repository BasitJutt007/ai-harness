# Signals lists stop repeating a page after a refresh

Problem: In Buyer Intelligence > Signals, once the Buyers' Tech Stack or Headquarters list has scrolled past its first 25 rows, clicking "All" in the Competitor filter shows the last page of rows twice (50 rows become 75). The click refreshes the Signals cards by invalidating their cache tags; RTK Query refetches each cached list with its last page argument, and the shared merge (appendPage in buyerIntentApi.ts) appends that page again instead of replacing it. Present on development, staging and main. Pagination and cache-merge bugs are a class reviewers flagged on 6 of my React PRs (#1066, #1068, #1074 among them), and I wrote this merge in #1066.
Owner: Vendor Portal vendor app, Buyer Intelligence (Abdul Basit)
Stakeholder: Abdul Basit
Repo: Software-Finder-1/VendorPortal-React
Base: harness-test
Metric: duplicate rows in the Tech Stack and Headquarters caches after a refresh at page 2, harness-test HEAD before: 50 after: ____
Measure: node metrics/signals-paged-merge-dedupe.mjs
Scenario: WHEN the Tech Stack or Headquarters list is on page 2 and the Signals cards are refreshed THEN each row appears once and the refreshed rows replace the old ones
Scenario: WHEN the next page (3) loads THEN its rows are appended after the existing ones
Scenario: WHEN page 1 loads again THEN it replaces the list
Not included:
- changing the page size or the cache key (page stays outside it, so pages keep merging into one list)
- the Location filter chip's option list, which shares the merge (fixed by the same change, not measured)
- adding a test runner to package.json: the spec runs with node:test (npx tsx --test test/)
