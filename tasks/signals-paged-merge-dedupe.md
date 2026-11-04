---
id: signals-paged-merge-dedupe
kind: brownfield
target: .
scope:
  allow: ["src/store/buyerIntent/buyerIntentApi.ts", "test/**/*.ts"]
  deny: []
standards: baseline
---
# Signals lists stop repeating a page after a refresh

Fix the repeated Signals page described by the approved contract (it opens the brief).

Where the fix goes: `appendPage` in `src/store/buyerIntent/buyerIntentApi.ts`, the merge shared by
`getHeadquarterLocations`, `getTechStack` and `getTechStacks`. A refetch of a page that is already in
the list must replace that page's rows (the list holds pages of `SIGNALS_CHART_PAGE_SIZE` rows, in page
order) instead of appending them again; page 1 still replaces the list and a new page still appends.
Export `appendPage` if the test needs it, without changing its behaviour for the other pages.

Test first, with node:test, in `test/signals-paged-merge.test.ts`: import `appendPage` (or build a store
with the real `buyerIntentApi` reducer and middleware, stubbing `globalThis.window` and `globalThis.fetch`
before importing it, since `src/config.ts` reads `window.location.host` at import). Merge page 1, then
page 2, then page 2 again with changed rows: assert 50 rows, no row twice, and page 2's new rows present.
Also assert page 3 appends and page 1 replaces. Run it and see the refetch case fail before editing.

The standards run in baseline mode because the app project already has 33 type errors from before this
change (its build's type check covers no files); this run must add none.
