/**
 * web-typecheck (web: the generic profile of an in-place run; typecheck): the repository's OWN type check,
 * as repo-typecheck runs it (its TypeScript, or its vue-tsc where installed, its tsconfig and every project
 * a solution-style tsconfig references), but run confined: in place the repository is any repository and
 * the checker loads what its tsconfig names.
 *
 * Not a 'standards' rule: an arbitrary repository often carries type errors of its own, so like lint it
 * blocks only what a run introduces (the standards gate compares with the base commit) instead of making
 * the owner fix the whole repository first. A repository without a tsconfig.json configures no type check:
 * nothing to check (n/a), never a pass, decided on the tsconfig.json alone (a JavaScript repository often has
 * a TypeScript package installed for its tools). It counts only for a change it looks at: when no file the
 * run changed is in the program (a src/x.js without allowJs, a stylesheet), it is n/a, so a whole-project
 * pass never stands for a change no standard examined. UNPROVEN: a tsconfig without the TypeScript to run it,
 * a config the checker cannot read, a timeout, or a failure without diagnostics. When every rule of the web
 * profile is n/a the standards gate stays UNPROVEN (a human verifies standards).
 */
import { defineCheck } from '../../src/core/plugin-api.ts';
import { repoTypecheck } from './repo-typecheck.ts';

const RULE = 'web-typecheck';

const DOC = `web-typecheck: the repository's own type check (tsc, or vue-tsc where it is installed, with its tsconfig)
reports no new error in what you changed. Fix every error it names in your files; never loosen a tsconfig,
never add // @ts-ignore. A repository without a tsconfig.json has no type check (n/a).`;

export default defineCheck({
  id: RULE,
  stacks: ['web'],
  category: 'typecheck',
  description: "The repository's own type check (tsc or vue-tsc, its tsconfig) reports nothing new; n/a without a tsconfig.json.",
  unit: 'errors',
  doc: DOC,
  run: (ctx) => repoTypecheck(ctx, { rule: RULE, confined: true, vueTsc: true, naWithoutTypeScript: true, onlyWhenChangeCovered: true }),
});
