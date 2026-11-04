---
id: admin-only-sweep
kind: brownfield
target: .
scope:
  allow:
    - src/modules/admin/admin.controller.ts
    - src/modules/company/company.controller.ts
    - src/modules/notifications/notifications.controller.ts
    - src/**/*.spec.ts
  deny: []
standards: strict
---
# Admin-only routes refuse vendor tokens

Gate the ten admin-only routes the approved contract names (it opens the brief) with the repository's
`@AdminOnly()` decorator (`src/common/decorators/admin-only.decorator.ts`), on each handler. Do not put
it on the controller class: the same controllers serve vendor routes that must stay reachable. Do not
remove, rename or move any route, and leave `POST /admins/qa/purchase-premium-plan` as it is.

How admin access works here: `AdminGuard` (`src/common/guards/admin.guard.ts`) is a global guard that
reads the `adminOnly` metadata from the handler and its class with the Nest `Reflector`; without it the
route is open to every signed-in user, and with it a user whose `isAdmin` is not true gets a
`ForbiddenException`.

Test first, one jest spec (for example `src/common/guards/admin-only-routes.spec.ts`): for each of the
ten handlers, build an `ExecutionContext` stub whose `getHandler()` returns the controller method and
`getClass()` the controller class and whose request carries a vendor user (`isAdmin: false`), run
`new AdminGuard(new Reflector()).canActivate(ctx)` and expect a `ForbiddenException`; with an admin user
(`isAdmin: true`) expect `true`; and for the vendor routes the contract keeps, expect `true` for a
vendor user. Run it and see the ten vendor cases fail before you edit the controllers.
