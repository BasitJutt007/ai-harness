# Admin-only routes refuse vendor tokens

Problem: Any signed-in vendor account can call 10 routes that only the admin app uses: create, list, edit and delete admin accounts (POST, GET, PATCH, DELETE /admins); delete any company, which cascades to its users and memberships (DELETE /company/:id); list every company with every user column (GET /company/get); read and change any product's feature settings (GET and PATCH /company/feature-settings/:productId); and create notifications or read any product's notifications (POST /notifications, GET /notifications/by-slug/:slug). AdminGuard enforces admin access only on handlers marked @AdminOnly(), none of these ten is, and login creates an account for any email address, so anyone with an inbox can get such a token. Live on development, staging and main. Routes without the access check they need are my most repeated review finding (6 backend PRs).
Owner: Vendor Portal backend (Abdul Basit)
Stakeholder: Abdul Basit
Repo: Software-Finder-1/vp-business-backend
Base: harness-test
Metric: admin-only routes open to vendor tokens, harness-test HEAD before: ____ after: ____
Measure: node metrics/admin-only-sweep.mjs
Scenario: WHEN a vendor token calls any of the 10 admin-only routes THEN the API answers 403 and the service is never called
Scenario: WHEN an admin token calls any of them THEN it works exactly as today
Scenario: WHEN a vendor token calls the vendor routes of the same controllers (company by-user, search, create, add-member, members and products; notifications me, by-user, read, mark-all-read) THEN they work exactly as today
Not included:
- POST /admins/qa/purchase-premium-plan: a QA route, left exactly as reachable as today
- removing any route: the ten stay where they are and require an admin
- tenant checks inside vendor routes (member add, /users self-scope, badge routes): separate items
- the jest moduleNameMapper line that lets a spec import src/ paths: a prerequisite landed by a person first, since no run may write package.json
