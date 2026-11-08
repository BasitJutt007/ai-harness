#!/usr/bin/env node
/**
 * demo-routes: how many of the expected routes the API under <apiDir> does not register.
 *
 *   node metrics/demo-routes.mjs <apiDir> METHOD:/path [METHOD:/path ...]
 *
 * The Measure of the two 01 demo items (users-api, projects-change), read in a checkout of
 * BasitJutt007/harness-demo. A route counts as registered when a non-test .ts file under <apiDir>/src
 * calls `<receiver>.<method>('<path>', ...)` with the path as a string literal (the express style both
 * demo APIs use). Comments are stripped first, and path parameters compare by position (":userId"
 * equals ":id"). A missing <apiDir> registers nothing, so every expected route is missing.
 *
 * Static on purpose (it runs confined, with no network and no install): it proves a route is
 * declared, not that it behaves. Behaviour is what the run's gates prove (spec coverage, the contract
 * lock, tests seen red then green).
 *
 * Prints a JSON summary, then the number of missing routes on the last line.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [apiDir, ...want] = process.argv.slice(2);
if (apiDir === undefined || want.length === 0 || want.some((w) => !/^[A-Za-z]+:\//.test(w))) {
  console.error('usage: node metrics/demo-routes.mjs <apiDir> METHOD:/path [METHOD:/path ...]');
  process.exit(2);
}

const norm = (p) => (p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param').replace(/\/+$/, '') || '/');

const files = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p);
    } else if (e.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      files.push(p);
    }
  }
}
const src = join(apiDir, 'src');
if (existsSync(src)) walk(src);
files.sort();

const CALL = /\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`$]+)\2/g;
const registered = new Set();
for (const f of files) {
  const text = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const m of text.matchAll(CALL)) registered.add(`${m[1].toUpperCase()} ${norm(m[3])}`);
}

const expected = want.map((w) => {
  const i = w.indexOf(':');
  return `${w.slice(0, i).toUpperCase()} ${norm(w.slice(i + 1))}`;
});
const missing = expected.filter((e) => !registered.has(e));
console.log(JSON.stringify({ apiDir, files: files.length, expected, missing }));
console.log(missing.length);
