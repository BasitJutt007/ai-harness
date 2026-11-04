#!/usr/bin/env node
// Hardened metric probe: members-list-stale-after-add (VendorPortal-Admin)
//
// Bundles the clone's REAL Redux store (src/store/store.ts: every slice and
// middleware wired as the app wires them) with esbuild in memory, stubs fetch
// so nothing leaves the process, and checks the Members list
// (memberApi.getMembers) the way src/pages/Members.tsx subscribes to it.
//
// Three subscribed lists with different argument sets (All tab defaults,
// Pending tab page 2, Signed Up tab with search + country), built with every
// key present as Members.tsx does. A list counts as "refetched" only when BOTH
// its cache entry got a new requestId and is fulfilled, AND a new GET was sent
// to the exact path + query string that list used for its first fetch.
//
//   C1 add_success_refetches_every_list   after a successful
//      productApi.addProductMember, every subscribed list is refetched.
//   C2 add_failure_does_not_refetch       after an addProductMember that fails
//      with HTTP 500, no list is refetched and no list GET is sent.
//   C3 block_control_refetches_every_list after memberApi.toggleBlockUser,
//      every subscribed list is refetched (today's behaviour; must stay).
//
// value = number of failed checks (0..3). Lower is better; target 0.
// Guards (exit 2, no value): the store fails to load, a list's first fetch is
// not exactly one GET, or a mutation's own request is not seen or does not
// settle the way the check staged it.
//
// Usage: node metrics/members-list-stale-after-add.mjs [clone (default: cwd)] [--store=real|slices]
// Origin: the adversarially verified (hardened) probe of the assignment-02 candidate review.
// No network (fetch stubbed), no secrets, no database. Read-only on the clone.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const METRIC = "members_list_stale_after_mutation";

const ENTRY_REAL = `
export { store } from "./store/store";
export { productApi } from "./store/product/productApi";
export { memberApi } from "./store/member/memberApi";
`;
const ENTRY_SLICES = `
import { configureStore } from "@reduxjs/toolkit";
import { productApi } from "./store/product/productApi";
import { memberApi } from "./store/member/memberApi";
export const store = configureStore({
  reducer: {
    [productApi.reducerPath]: productApi.reducer,
    [memberApi.reducerPath]: memberApi.reducer,
    auth: (s = { token: "probe" }) => s,
  },
  middleware: (gdm) =>
    gdm({ serializableCheck: false, immutableCheck: false }).concat(productApi.middleware, memberApi.middleware),
  devTools: false,
});
export { productApi, memberApi };
`;

// Members.tsx passes every key, undefined when unused.
const LIST_ARGS = [
  { page: 1, take: 10, search: undefined, countryCode: undefined, isVerified: undefined, isBlocked: undefined, withoutProducts: undefined },
  { page: 2, take: 25, search: undefined, countryCode: undefined, isVerified: false, isBlocked: undefined, withoutProducts: undefined },
  { page: 1, take: 50, search: "probe", countryCode: ["US", "GB"], isVerified: undefined, isBlocked: undefined, withoutProducts: true },
];

const ADD_ARG = {
  slug: "probe-product",
  data: { email: "new@example.invalid", role: "VIEWER", vendorType: "PRODUCT" },
};

class GuardError extends Error {}
const guard = (ok, msg) => {
  if (!ok) throw new GuardError(msg);
};

async function bundle(clone, mode, overrides) {
  const req = createRequire(path.join(clone, "package.json"));
  const esbuild = req("esbuild");
  const plugins = [];
  if (overrides && Object.keys(overrides).length) {
    plugins.push({
      name: "probe-overrides",
      setup(b) {
        b.onLoad({ filter: /[\\/]src[\\/].*\.tsx?$/ }, (a) => {
          const rel = path.relative(clone, a.path).split(path.sep).join("/");
          if (!Object.prototype.hasOwnProperty.call(overrides, rel)) return undefined;
          return { contents: overrides[rel], loader: a.path.endsWith(".tsx") ? "tsx" : "ts", resolveDir: path.dirname(a.path) };
        });
      },
    });
  }
  const out = await esbuild.build({
    stdin: { contents: mode === "slices" ? ENTRY_SLICES : ENTRY_REAL, resolveDir: path.join(clone, "src"), sourcefile: "probe-entry.ts", loader: "ts" },
    bundle: true,
    write: false,
    // Resolve packages through the checkout's node_modules link (the only path a confined reading may read).
    preserveSymlinks: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins,
  });
  return { text: out.outputFiles[0].text, req };
}

// A fresh module instance (fresh store, fresh API slices) per check.
function instantiate({ text, req }) {
  const mem = new Map();
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  };
  const window = {
    location: { host: "localhost", hostname: "localhost", href: "http://localhost/", origin: "http://localhost", pathname: "/" },
    localStorage,
    addEventListener() {},
    removeEventListener() {},
    // react-hot-toast's goober writes CSS at import; give it an in-memory sheet.
    _goober: { parentNode: {}, firstChild: { data: "" } },
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", "window", "localStorage", text)(module, module.exports, req, window, localStorage);
  return module.exports;
}

const calls = [];
const stub = { failAdd: false };
globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = String((typeof input === "object" && !(input instanceof URL) ? input.method : init?.method) ?? init?.method ?? "GET").toUpperCase();
  const u = new URL(rawUrl, "http://probe.invalid");
  const pathname = u.pathname.replace(/\/+$/, "");
  calls.push({ method, pathname, search: u.search });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && /\/products\/[^/]+\/members$/.test(pathname)) {
    return stub.failAdd
      ? json(500, { statusCode: 500, message: "probe: add failed" })
      : json(200, { member: {}, user: { id: "u1", email: "new@example.invalid", isVerified: false }, invited: true, addedByAdmin: true });
  }
  if (method === "GET" && /\/members$/.test(pathname)) {
    return json(200, { data: [], meta: { page: 1, take: 10, itemCount: 0, pageCount: 0, hasPreviousPage: false, hasNextPage: false } });
  }
  return json(200, { message: "ok" });
};

// Same fixed settle as the original probe: 30 x 10 ms (the stub answers at once).
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 10));
};

async function runCheck(built, name, makeMutation, expect) {
  calls.length = 0;
  stub.failAdd = expect.mutationOutcome === "rejected";
  const { store, memberApi, productApi } = instantiate(built);
  guard(store && memberApi && productApi, `${name}: store or API slices missing from the bundle`);
  const rp = memberApi.reducerPath;
  const lists = [];
  const subs = [];
  for (const args of LIST_ARGS) {
    const before = calls.length;
    const sub = store.dispatch(memberApi.endpoints.getMembers.initiate(args));
    subs.push(sub);
    await settle();
    const first = calls.slice(before).filter((c) => c.method === "GET");
    guard(first.length === 1, `${name}: first fetch of list ${JSON.stringify(args)} sent ${first.length} GETs, expected 1`);
    const entry = store.getState()[rp].queries[sub.queryCacheKey];
    guard(entry && entry.status === "fulfilled", `${name}: list ${sub.queryCacheKey} not fulfilled after first fetch`);
    lists.push({ key: sub.queryCacheKey, pathname: first[0].pathname, search: first[0].search, requestId: entry.requestId });
  }
  const listPaths = new Set(lists.map((l) => l.pathname));
  guard(listPaths.size === 1, `${name}: lists used different paths`);
  const listPath = [...listPaths][0];
  const mark = calls.length;

  let outcome;
  try {
    await store.dispatch(makeMutation({ productApi, memberApi })).unwrap();
    outcome = "fulfilled";
  } catch {
    outcome = "rejected";
  }
  await settle();
  const after = calls.slice(mark);
  guard(after.some((c) => c.method === expect.mutationMethod && expect.mutationPath.test(c.pathname)), `${name}: the mutation's own ${expect.mutationMethod} request was not seen`);
  guard(outcome === expect.mutationOutcome, `${name}: mutation ${outcome}, staged ${expect.mutationOutcome}`);

  const perList = lists.map((l) => {
    const entry = store.getState()[rp].queries[l.key];
    const storeRefetched = !!entry && entry.status === "fulfilled" && entry.requestId !== l.requestId;
    const getsSent = after.filter((c) => c.method === "GET" && c.pathname === l.pathname && c.search === l.search).length;
    return { list: l.key, store_refetched: storeRefetched, list_gets_after: getsSent };
  });
  const anyListGet = after.some((c) => c.method === "GET" && c.pathname === listPath);
  subs.forEach((s) => s.unsubscribe());

  let pass;
  if (expect.listsRefetch) {
    pass = perList.every((p) => p.store_refetched && p.list_gets_after >= 1);
  } else {
    pass = perList.every((p) => !p.store_refetched && p.list_gets_after === 0) && !anyListGet;
  }
  return { check: name, pass, mutation_outcome: outcome, lists: perList };
}

export async function runProbe(clone, { mode = "real", overrides } = {}) {
  const built = await bundle(clone, mode, overrides);
  const checks = [];
  checks.push(
    await runCheck(built, "add_success_refetches_every_list", ({ productApi }) => productApi.endpoints.addProductMember.initiate(ADD_ARG), {
      listsRefetch: true,
      mutationOutcome: "fulfilled",
      mutationMethod: "POST",
      mutationPath: /\/products\/probe-product\/members$/,
    }),
  );
  checks.push(
    await runCheck(built, "add_failure_does_not_refetch", ({ productApi }) => productApi.endpoints.addProductMember.initiate(ADD_ARG), {
      listsRefetch: false,
      mutationOutcome: "rejected",
      mutationMethod: "POST",
      mutationPath: /\/products\/probe-product\/members$/,
    }),
  );
  checks.push(
    await runCheck(built, "block_control_refetches_every_list", ({ memberApi }) => memberApi.endpoints.toggleBlockUser.initiate({ action: "block", userId: "u1" }), {
      listsRefetch: true,
      mutationOutcome: "fulfilled",
      mutationMethod: "PATCH",
      mutationPath: /\/admin-auth\/block\/u1$/,
    }),
  );
  const failed = checks.filter((c) => !c.pass).map((c) => c.check);
  return { metric: METRIC, store: mode, value: failed.length, failed, checks };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Measure contract (src/core/measure.ts): run by the harness in a checkout of the commit to read
  // (the current directory), confined; the last stdout line is the value. A guard failure prints no
  // value and exits 2, which the harness records as no reading.
  const args = process.argv.slice(2);
  const clone = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  const mode = (args.find((a) => a.startsWith("--store=")) ?? "--store=real").slice(8);
  try {
    const res = await runProbe(clone, { mode });
    console.log(JSON.stringify(res));
    console.log(String(res.value));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ metric: METRIC, store: mode, error: String(err?.message ?? err), guard: err instanceof GuardError }));
    process.exit(2);
  }
}
