/**
 * vite-build (react-vite; standards): the production build the team deploys (`vite build`) succeeds on
 * the changed tree, before merge: where the build only runs in a deploy workflow, a broken build is
 * otherwise found after the merge.
 *
 * The build runs the repository's vite.config (code), so it runs confined: no network, output to a temp
 * directory, nothing written into the target. UNPROVEN: no Vite in the repository, or a build that times out.
 *
 * Browser targets: browserslist (behind autoprefixer, plugin-legacy, ...) looks for its config by walking up
 * from each file it handles, through directories the sandbox does not let the build read (a node_modules
 * linked from another checkout leads it outside the tree). The harness reads the repository's own config
 * itself (package.json "browserslist", a browserslist or .browserslistrc file, from the API root up to the
 * repository top; its production section) and hands it over as BROWSERSLIST, which browserslist takes
 * before any walk: the build targets what the repository says wherever its files live, and browserslist's
 * own `defaults` when it says nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding } from '../../src/core/plugin-api.ts';

const RULE = 'vite-build';
const PROJECT = '(project)';

/** Queries of a browserslist config text (a browserslist / .browserslistrc file): its production section, else the lines outside any section. */
export function parseBrowserslistRc(text: string, env = 'production'): string[] {
  const general: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head !== null) {
      current = [];
      for (const name of (head[1] ?? '').trim().split(/\s+/)) sections.set(name, current);
      continue;
    }
    (current ?? general).push(line);
  }
  return sections.get(env) ?? sections.get('defaults') ?? general;
}

/** package.json "browserslist" as queries (a string, a list, or per-environment lists), or null when it has none. */
function packageQueries(file: string, env = 'production'): string[] | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const v: unknown = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'browserslist') : undefined;
  const list = (x: unknown): string[] | null => (typeof x === 'string' ? [x] : Array.isArray(x) && x.every((q) => typeof q === 'string') ? x : null);
  if (v === undefined) return null;
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return list(Reflect.get(v, env)) ?? list(Reflect.get(v, 'defaults'));
  return list(v);
}

/**
 * The BROWSERSLIST value for a build of the API at `root`: the nearest config from `root` up to `top` (the
 * repository top; `root` alone without one), as browserslist would find it for the repository's own files.
 * 'defaults' when there is none: what browserslist uses then.
 */
export function browserslistQueries(root: string, top?: string): string {
  let dir = root;
  for (;;) {
    const fromPkg = existsSync(join(dir, 'package.json')) ? packageQueries(join(dir, 'package.json')) : null;
    if (fromPkg !== null && fromPkg.length > 0) return fromPkg.join(', ');
    for (const name of ['browserslist', '.browserslistrc']) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const queries = parseBrowserslistRc(readFileSync(file, 'utf8'));
      if (queries.length > 0) return queries.join(', ');
    }
    const up = dirname(dir);
    const rel = top === undefined ? '..' : relative(top, up);
    if (up === dir || rel.startsWith('..')) return 'defaults';
    dir = up;
  }
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const vite = join(ctx.root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: "the repository's Vite is not installed (node_modules/vite)" }];
  const tmp = mkdtempSync(join(tmpdir(), 'vite-build-'));
  try {
    const out = join(tmp, 'dist');
    const browsers = browserslistQueries(ctx.root, ctx.base?.repoRoot);
    // --configLoader runner: load vite.config without bundling it into node_modules/.vite-temp (a write
    // outside the temp dir, which the sandbox refuses); Vite 6.1+.
    const r = await ctx.exec(process.execPath, [vite, 'build', '--configLoader', 'runner', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: ctx.root,
      timeoutMs: 900_000,
      env: { TMPDIR: tmp, CI: '1' },
      sandbox: { writable: [tmp], network: 'none', env: { BROWSERSLIST: browsers } },
    });
    await ctx.logs.write('vite-build.txt', `$ BROWSERSLIST="${browsers}" vite build --outDir <tmp>  (exit ${String(r.code)})\n${r.stdout.trim()}\n${r.stderr.trim()}`);
    if (r.timedOut) return [{ rule: RULE, file: PROJECT, status: 'skip', units: { passed: 0, total: 0 }, violations: [], skipReason: 'vite build timed out' }];
    if (r.code === 0) return [{ rule: RULE, file: PROJECT, status: 'pass', units: { passed: 1, total: 1 }, violations: [] }];
    const lines = (r.stderr || r.stdout).trim().split('\n').filter((l) => l.trim().length > 0).slice(-8);
    return [{ rule: RULE, file: PROJECT, status: 'fail', units: { passed: 0, total: 1 }, violations: lines.map((l) => ({ location: `${PROJECT}:0:0`, message: l.trim() })) }];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default defineCheck({
  id: RULE,
  stacks: ['react-vite'],
  category: 'standards',
  description: 'The production build (vite build) succeeds on the changed tree.',
  unit: 'builds',
  doc: 'vite-build: `vite build` succeeds on the changed tree (output to a temp directory). Fix what it reports in your files.',
  run,
});
