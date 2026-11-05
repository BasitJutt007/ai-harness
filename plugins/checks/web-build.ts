/**
 * web-build (web: the generic profile of an in-place run; build): the repository's own `vite build`, as
 * vite-build runs it for react-vite (confined, no network, output to a temp directory, the repository's
 * browserslist), for any web repository that has Vite installed and a vite config: a Vue, Svelte or
 * JavaScript React app built with Vite gets its production build checked before merge too.
 *
 * Not a 'standards' rule: an arbitrary repository's build may already be broken, so like its type check and
 * lint it blocks only what a run introduces (the standards gate compares with the base commit). A repository
 * without its own Vite or without a vite config builds nothing with Vite: n/a, never a pass. UNPROVEN: a
 * build that times out.
 */
import { defineCheck } from '../../src/core/plugin-api.ts';
import { viteBuild } from './vite-build.ts';

const RULE = 'web-build';

export default defineCheck({
  id: RULE,
  stacks: ['web'],
  category: 'build',
  description: "The repository's own production build (vite build) succeeds on the changed tree; n/a without Vite installed and a vite config.",
  unit: 'builds',
  doc: 'web-build: the repository\'s own `vite build` succeeds on the changed tree (output to a temp directory). Fix what it reports in your files; never edit the vite config. A repository without Vite installed and a vite config has no build to check (n/a).',
  run: (ctx) => viteBuild(ctx, { rule: RULE, naWithoutVite: true }),
});
