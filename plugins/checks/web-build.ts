/**
 * web-build (build; web, and express or nestjs in place): the repository's own `vite build`, as vite-build
 * runs it for react-vite (confined, no network, output to a temp directory, the repository's browserslist),
 * for any repository a session works in that is a Vite app (viteApp: a vite config, or Vite's defaults with a
 * script that runs Vite or the index.html it builds from): a Vue, Svelte or JavaScript React app, or a server
 * that also builds its frontend with Vite, gets its production build checked before merge too. File mode's
 * express and nestjs reports are unchanged (inPlaceStacks), and react-vite has vite-build.
 *
 * Not a 'standards' rule: an arbitrary repository's build may already be broken, so like its type check and
 * lint it blocks only what a run introduces (the standards gate compares with the base commit). A repository
 * without its own Vite, or that is no Vite app, builds nothing with Vite: n/a, never a pass. UNPROVEN: a
 * build that times out.
 */
import { defineCheck } from '../../src/core/plugin-api.ts';
import { viteBuild } from './vite-build.ts';

const RULE = 'web-build';

export default defineCheck({
  id: RULE,
  stacks: ['web'],
  inPlaceStacks: ['express', 'nestjs'],
  category: 'build',
  description: "The repository's own production build (vite build) succeeds on the changed tree; n/a when it is no Vite app.",
  unit: 'builds',
  doc: 'web-build: the repository\'s own `vite build` succeeds on the changed tree (output to a temp directory). Fix what it reports in your files; never edit the vite config. A repository that is no Vite app (no Vite installed, no vite config, no script running Vite, no index.html) has no build to check (n/a).',
  run: (ctx) => viteBuild(ctx, { rule: RULE, naWithoutVite: true }),
});
