---
id: members-list-stale-after-add
kind: brownfield
target: .
scope:
  allow: ["src/store/product/productApi.ts", "test/**/*.ts"]
  deny: []
standards: strict
---
# Members list refreshes after Add member

Fix the stale Members list described by the approved contract (it opens the brief).

Where the fix goes: `productApi.addProductMember` in `src/store/product/productApi.ts` must invalidate
memberApi's `{ type: "Members", id: "LIST" }` tag after the add SUCCEEDS, and only then: use
`onQueryStarted` with `await queryFulfilled` and `dispatch(memberApi.util.invalidateTags(...))`, the
same pattern this file already uses for `claimAllRequestApi` (import memberApi from
`../member/memberApi`). Keep `invalidatesTags: ["Product"]` as it is.

Test first, with node:test, in `test/members-list-refresh.test.ts`:
- `src/config.ts` reads `window.location.host` when it is imported: set `globalThis.window` (a plain
  object with `location.host`) BEFORE importing the store modules (use `await import(...)`).
- Build a store with `configureStore` from `@reduxjs/toolkit` holding the real `productApi` and
  `memberApi` reducers and middleware; replace `globalThis.fetch` with a stub that records each request
  and answers JSON (members list, a successful add, and an add that answers HTTP 500).
- Subscribe the Members list (`memberApi.endpoints.getMembers.initiate({ page: 1, take: 10 })`), wait
  for it, dispatch `productApi.endpoints.addProductMember.initiate(...)`, and assert a new GET to the
  members list was sent after a successful add, and none after a failed one.
- Run it with run_tests and see the success case fail before you edit productApi.ts.
