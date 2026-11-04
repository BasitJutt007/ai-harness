#!/usr/bin/env node
// Hardened metric probe: signals-paged-merge-dedupe
//
// Same question as the candidate probe (does a tag refresh at page 2 append the
// last page again?), with guards so a change cannot move the number without
// fixing the merge:
//   - realistic row shapes: tech rows {uid,name,...}, location rows {country,...}
//     (no `name` on locations), identity = uid||name for tech, country for locations;
//   - every request is served by an in-memory fake; a refetched page carries a new
//     generation in `count`, so "refreshed rows were applied" is checkable;
//   - guards (fail closed, exit 1): the refresh really issued one page-2 request per
//     endpoint; 50 unique rows before the refresh; no row missing after it; the
//     refreshed page-2 data is present; page 3 still appends; page 1 still replaces.
// Output: JSON, then (only when every guard passed) the metric alone on the last line: the Measure
// contract of src/core/measure.ts. A failed guard exits 1 with no value: no reading.
// Origin: the adversarially verified (hardened) probe of the assignment-02 candidate review.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const clone = path.resolve(process.argv[2] ?? process.cwd());
const cloneRequire = createRequire(path.join(clone, "package.json"));
const ts = cloneRequire("typescript");

const PAGES = 3;
const requests = []; // { endpoint, page, scope }
const generation = new Map(); // `${pathname}|${page}|${sort}` -> times served
globalThis.window ??= { location: { host: "localhost:5173", hostname: "localhost", origin: "http://localhost:5173", href: "http://localhost:5173/" } };
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const page = Number(url.searchParams.get("page") ?? 1);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
  const isTech = url.pathname.endsWith("/buyer-intent/tech-stack");
  const isLoc = url.pathname.endsWith("/buyer-intent/headquarter-locations");
  if (!isTech && !isLoc) throw new Error(`unexpected request ${url.pathname}`);
  const key = `${url.pathname}|${page}|${url.searchParams.get("sort") ?? ""}`;
  const gen = (generation.get(key) ?? 0) + 1;
  generation.set(key, gen);
  requests.push({ endpoint: isTech ? "getTechStack" : "getHeadquarterLocations", page, sort: url.searchParams.get("sort") ?? null });
  const total = pageSize * PAGES;
  const start = (page - 1) * pageSize;
  const items = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => {
    const n = start + i + 1;
    const count = 100000 - n * 10 + gen; // rank order kept; generation visible
    return isTech
      ? { uid: `uid-${n}`, name: `Tech ${n}`, icon: null, count, percentage: 1 }
      : { country: `Country ${n}`, count, percentage: 1 };
  });
  const body = {
    ...(isTech ? { totalTechnologies: total } : { totalCountries: total }),
    totalEntries: total, page, pageSize, hasMore: start + items.length < total, items,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const modCache = new Map();
const resolveFile = (fromDir, spec) => {
  const base = path.resolve(fromDir, spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  throw new Error(`cannot resolve ${spec} from ${fromDir}`);
};
const loadTs = (abs) => {
  if (modCache.has(abs)) return modCache.get(abs).exports;
  const src = fs.readFileSync(abs, "utf8").replace(/\bimport\.meta\.env\b/g, "({})").replace(/\bimport\.meta\b/g, "({ env: {} })");
  const out = ts.transpileModule(src, { fileName: abs, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  modCache.set(abs, mod);
  const req = (spec) => (spec.startsWith(".") ? loadTs(resolveFile(path.dirname(abs), spec)) : cloneRequire(spec));
  vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${out}\n})`, { filename: abs })(mod.exports, req, mod, abs, path.dirname(abs));
  return mod.exports;
};

const { configureStore } = cloneRequire("@reduxjs/toolkit");
const { buyerIntentApi } = loadTs(path.join(clone, "src/store/buyerIntent/buyerIntentApi.ts"));
const settle = () => new Promise((r) => setTimeout(r, 30));
const SLUG = "probe-product";
// The ids SignalsHeader.refetchSignalsCards() invalidates (SignalsHeader.tsx:281-298).
const REFRESH_TAGS = ["activity", "tech", "locations", "sizes", "category-visits", "product-visits", "conversion-visits", "competitor-visits"]
  .map((id) => ({ type: "BuyerIntent", id: `${id}-${SLUG}` }));

const keyOf = (row) => ("country" in row ? row.country : row.uid || row.name);
const numOf = (key) => Number(String(key).match(/(\d+)$/)?.[1]);

const runEndpoint = async (name, scope) => {
  const failed = [];
  const store = configureStore({
    reducer: { [buyerIntentApi.reducerPath]: buyerIntentApi.reducer, auth: () => ({ token: "probe" }) },
    middleware: (gdm) => gdm({ serializableCheck: false, immutableCheck: false }).concat(buyerIntentApi.middleware),
  });
  const base = { productSlug: SLUG, dateRange: "90d", scope };
  const ep = buyerIntentApi.endpoints[name];
  const read = () => ep.select({ ...base, page: 1 })(store.getState()).data?.items ?? [];
  const reqsFor = () => requests.filter((r) => r.endpoint === name && (r.sort === "name") === (scope === "options"));

  const s1 = store.dispatch(ep.initiate({ ...base, page: 1 }));
  await s1; await settle();
  const s2 = store.dispatch(ep.initiate({ ...base, page: 2 }));
  s1.unsubscribe();
  await s2; await settle();
  const before = read();
  const beforeKeys = before.map(keyOf);
  if (before.length !== 50 || new Set(beforeKeys).size !== 50) failed.push(`before_refresh_not_50_unique(${before.length}/${new Set(beforeKeys).size})`);

  const reqsBeforeRefresh = reqsFor().length;
  store.dispatch(buyerIntentApi.util.invalidateTags(REFRESH_TAGS));
  await settle(); await settle();
  const refreshReqs = reqsFor().slice(reqsBeforeRefresh);
  if (refreshReqs.length !== 1 || refreshReqs[0].page !== 2) failed.push(`refresh_did_not_refetch_page_2(${JSON.stringify(refreshReqs.map((r) => r.page))})`);

  const after = read();
  const afterKeys = after.map(keyOf);
  const duplicates = afterKeys.length - new Set(afterKeys).size;
  const missing = Array.from({ length: 50 }, (_, i) => i + 1).filter((n) => !afterKeys.some((k) => numOf(k) === n));
  if (missing.length) failed.push(`rows_missing_after_refresh(${missing.length})`);
  // Page-2 rows must show the refreshed generation (count ends in ...2 for n in 26..50).
  const refreshedApplied = Array.from({ length: 25 }, (_, i) => i + 26).filter((n) =>
    after.some((row) => numOf(keyOf(row)) === n && row.count === 100000 - n * 10 + 2)).length;
  if (refreshedApplied !== 25) failed.push(`refreshed_page_2_not_applied(${refreshedApplied}/25)`);

  // Page 3 must still append (every key 1..75 present).
  const s3 = store.dispatch(ep.initiate({ ...base, page: 3 }));
  s2.unsubscribe();
  await s3; await settle();
  const p3Keys = read().map(keyOf);
  const p3Missing = Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !p3Keys.some((k) => numOf(k) === n)).length;
  if (p3Missing) failed.push(`page_3_append_broken(missing ${p3Missing})`);

  // Page 1 (filter change / remount) must still replace the whole list.
  const r1 = store.dispatch(ep.initiate({ ...base, page: 1 }));
  s3.unsubscribe();
  await r1; await settle();
  const reset = read();
  if (reset.length !== 25 || new Set(reset.map(keyOf)).size !== 25) failed.push(`page_1_reset_broken(${reset.length})`);
  r1.unsubscribe();

  return {
    endpoint: name, scope, rows_before_refresh: before.length, rows_after_refresh: after.length,
    duplicate_rows: duplicates, missing_rows_after_refresh: missing.length, refreshed_rows_applied: refreshedApplied,
    rows_after_page_3: p3Keys.length, rows_after_page_1_reset: reset.length, guards_failed: failed,
  };
};

const chart = [await runEndpoint("getTechStack", "chart"), await runEndpoint("getHeadquarterLocations", "chart")];
// Informational: the Location filter chip's roster (scope "options") shares appendPage and the same tag.
const options = [await runEndpoint("getHeadquarterLocations", "options")];
const guardsFailed = chart.flatMap((r) => r.guards_failed.map((g) => `${r.endpoint}/${r.scope}: ${g}`));
console.log(JSON.stringify({
  probe: "signals-paged-merge-dedupe.hardened",
  clone,
  metric: chart.reduce((s, r) => s + r.duplicate_rows, 0),
  metric_name: "duplicate rows (real identity key) in the Tech Stack + Headquarters chart caches after a refetchSignalsCards tag refresh at page 2",
  guards_failed: guardsFailed,
  endpoints: chart,
  informational_location_chip_roster: options,
  fake_requests: requests.length,
}));
if (guardsFailed.length > 0) process.exit(1);
console.log(String(chart.reduce((s, r) => s + r.duplicate_rows, 0)));
process.exit(0);
