/**
 * What file-routed frameworks do with a file because of where it is, not because something imports it:
 *   - FRAMEWORK_CONVENTIONS: the files they load (a Next.js page, a SvelteKit +page.svelte, ...). The orphans
 *     gate never calls a new one an orphan; it is UNPROVEN ("loaded by the framework by convention").
 *   - FRAMEWORK_API_ROUTES: the files that serve an HTTP API (a Next.js route handler or pages/api, Nuxt
 *     server/, a SvelteKit +server.ts, an Astro endpoint, Remix route modules with their loaders and actions,
 *     ...). No route lock reads them, so a change to one is named UNPROVEN in place (plugins/lib/proof.ts):
 *     its contract is a human's to verify, never green.
 * Globs are relative to the package that declares the framework (the nearest package.json above the file, up
 * to the API root), so a monorepo app is matched by its own manifest.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

export interface FrameworkConvention {
  framework: string;
  /** Dependencies that declare it (any one). */
  deps: readonly string[];
  /** Package-relative globs. */
  globs: readonly string[];
}

const CODE = '{js,jsx,ts,tsx,mjs,cjs,mts,cts}';

/** Files a file-routed framework loads by where they are. */
export const FRAMEWORK_CONVENTIONS: readonly FrameworkConvention[] = [
  {
    framework: 'Next.js',
    deps: ['next'],
    globs: [
      '?(src/)app/**/{page,layout,route,loading,error,not-found,template,default,global-error}.{js,jsx,ts,tsx,mjs}',
      '?(src/)pages/**', '?(src/)middleware.{js,ts}', '?(src/)instrumentation.{js,ts}',
    ],
  },
  { framework: 'Nuxt', deps: ['nuxt'], globs: ['?(app/){pages,components,layouts,composables,utils,middleware,plugins}/**', 'server/**'] },
  { framework: 'SvelteKit', deps: ['@sveltejs/kit'], globs: ['src/routes/**/+*.{svelte,js,ts}', 'src/hooks.{server,client}.{js,ts}', 'src/params/**'] },
  { framework: 'Remix', deps: ['@remix-run/react', '@remix-run/dev', '@react-router/dev'], globs: ['app/routes/**', 'app/root.{js,jsx,ts,tsx}', 'app/entry.{client,server}.{js,jsx,ts,tsx}'] },
  { framework: 'Astro', deps: ['astro'], globs: ['src/pages/**', 'src/middleware.{js,ts}'] },
  { framework: 'Gatsby', deps: ['gatsby'], globs: ['src/pages/**', 'src/templates/**'] },
  { framework: 'SolidStart', deps: ['@solidjs/start'], globs: ['src/routes/**'] },
];

/**
 * Files that serve an HTTP API by where they are. Path only, never "does it export a handler now": a change
 * that removes a loader or a GET export changes the API as much as one that adds it.
 */
export const FRAMEWORK_API_ROUTES: readonly FrameworkConvention[] = [
  { framework: 'Next.js', deps: ['next'], globs: [`?(src/)app/**/route.${CODE}`, '?(src/)pages/api/**', `?(src/)middleware.${CODE}`] },
  { framework: 'Nuxt', deps: ['nuxt'], globs: ['server/**'] },
  {
    framework: 'SvelteKit',
    deps: ['@sveltejs/kit'],
    globs: ['src/routes/**/+server.{js,ts}', 'src/routes/**/+page.server.{js,ts}', 'src/routes/**/+layout.server.{js,ts}', 'src/hooks.server.{js,ts}'],
  },
  { framework: 'Remix', deps: ['@remix-run/react', '@remix-run/dev', '@react-router/dev'], globs: [`app/routes/**/*.${CODE}`, `app/entry.server.${CODE}`] },
  { framework: 'Astro', deps: ['astro'], globs: ['src/pages/**/*.{js,ts,mjs,mts}', `src/middleware.${CODE}`, 'src/actions/**'] },
  { framework: 'Gatsby', deps: ['gatsby'], globs: ['src/api/**'] },
  { framework: 'SolidStart', deps: ['@solidjs/start'], globs: ['src/routes/**/*.{js,ts,mjs,mts}', 'src/routes/api/**', `src/middleware.${CODE}`] },
];

/** Declared dependency names of the package.json in `dir` (absolute), or null when it has none. */
function declaredDeps(dir: string): Set<string> | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const out = new Set<string>();
  if (typeof pkg !== 'object' || pkg === null) return out;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps: unknown = Reflect.get(pkg, field);
    if (typeof deps === 'object' && deps !== null) for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

const matchers = new WeakMap<readonly FrameworkConvention[], Array<FrameworkConvention & { match: (p: string) => boolean }>>();

/** Manifest cache shared across lookups of one gate run: absolute dir -> its declared dependencies (null: no package.json). */
export type ManifestCache = Map<string, Set<string> | null>;

/**
 * The framework of `list` whose convention matches `rel` (API-relative), or null: the nearest package.json
 * above it (up to the API root `root`) declares that framework, and `rel` lies where it looks.
 */
export function conventionMatch(list: readonly FrameworkConvention[], root: string, rel: string, cache: ManifestCache = new Map()): string | null {
  let compiled = matchers.get(list);
  if (compiled === undefined) {
    compiled = list.map((c) => ({ ...c, match: picomatch([...c.globs], { dot: true }) }));
    matchers.set(list, compiled);
  }
  const parts = rel.split('/').slice(0, -1);
  for (let i = parts.length; i >= 0; i -= 1) {
    const dirRel = parts.slice(0, i).join('/');
    const dir = dirRel === '' ? root : path.join(root, dirRel);
    if (!cache.has(dir)) cache.set(dir, declaredDeps(dir));
    const deps = cache.get(dir);
    if (deps === null || deps === undefined) continue;
    const inPackage = dirRel === '' ? rel : rel.slice(dirRel.length + 1);
    return compiled.find((c) => c.deps.some((d) => deps.has(d)) && c.match(inPackage))?.framework ?? null;
  }
  return null;
}

/** The framework that loads `rel` by convention (FRAMEWORK_CONVENTIONS), or null. */
export function conventionFramework(root: string, rel: string, cache: ManifestCache = new Map()): string | null {
  return conventionMatch(FRAMEWORK_CONVENTIONS, root, rel, cache);
}

/** The framework that serves `rel` as an API route by convention (FRAMEWORK_API_ROUTES), or null. */
export function apiRouteFramework(root: string, rel: string, cache: ManifestCache = new Map()): string | null {
  return conventionMatch(FRAMEWORK_API_ROUTES, root, rel, cache);
}
