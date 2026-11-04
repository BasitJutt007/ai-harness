# Members list refreshes after Add member

Problem: On Members, "Member added successfully!" appears and the modal closes, but the list keeps its old rows; the new member shows up only after a tab, page or search change, or a reload. The add call (productApi.addProductMember) invalidates only productApi's "Product" tag, while the list is cached by a different API slice (memberApi, tag Members/LIST), and RTK Query tags do not cross slices. A stale list after a save is a mistake I keep making: reviewers flagged stale lists or wrong cache tags on 7 of my Admin PRs (13 comments), and I fixed the class three times before (#390, #414, #540).
Owner: Vendor Portal admin app (Abdul Basit)
Stakeholder: Abdul Basit
Repo: Software-Finder-1/VendorPortal-Admin
Base: harness-test
Commit: fix(members): refetch every Members list after a member is added
Metric: members lists left stale after a member mutation (failed checks of 3), harness-test HEAD before: 1 after: ____
Measure: node metrics/members-list-stale-after-add.mjs
Scenario: WHEN an admin adds a member and the request succeeds THEN every subscribed Members list (any tab, page, page size or search) is fetched again
Scenario: WHEN adding a member fails THEN no Members list is fetched again
Scenario: WHEN an admin blocks or unblocks a user THEN the Members lists refresh exactly as they do today
Not included:
- changes to AddNewMemberModal.tsx or the Members page (the fix belongs in the API slice, so every caller gets it)
- refetch on window focus (setupListeners) for the store
- adding a test runner to package.json: the spec runs with node:test (npx tsx --test test/)
