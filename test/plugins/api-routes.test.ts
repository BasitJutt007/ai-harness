/**
 * In place, an API route a file-routed framework serves by where the file is (a Next.js route handler or
 * pages/api, Nuxt server/, a SvelteKit +server.ts, ...) is named UNPROVEN when the run changes or deletes it,
 * even next to a red that proves its behaviour: no route lock reads it, so its contract is a human's to
 * verify. Each named route has its twin: a page of the same framework, or the same path in a package that
 * does not declare the framework, is not named. File mode names nothing.
 */
import { rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { apiRouteFramework, FRAMEWORK_API_ROUTES } from '../../plugins/lib/conventions.ts';
import { unprovenEdits } from '../../plugins/lib/proof.ts';
import type { RunContext, RunnerSummary, TargetLayout } from '../../src/core/plugin-api.ts';
import { LEGACY_LAYOUT, setActiveLayout } from '../../src/core/target.ts';
import { scratch, writeTree } from '../target/_variants.ts';
import { brownfieldTask, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  setActiveLayout(undefined);
  await Promise.all(dirs.splice(0).map(removeTmp));
});

const SUPPORTED: RunnerSummary = { kind: 'vitest', name: 'vitest 5.0.3', supported: true };
const WEB: TargetLayout = { ...LEGACY_LAYOUT, sourceRoots: ['src', 'server'], testRoots: ['test'], testSupportRoots: ['test'], testGlobs: ['test/**/*.test.ts'], codeKinds: 'web' };

/** An in-place run over `files` (all present at run start) that then applies `change` (null deletes). */
async function changed(files: Record<string, string>, change: Record<string, string | null>, inPlace = true): Promise<RunContext> {
  const h = await makeHarness({ label: 'api-routes', task: brownfieldTask(), files });
  dirs.push(h.dir);
  setActiveLayout(WEB);
  for (const [rel, content] of Object.entries(files)) h.ctx.state.initialHashes.set(rel, sha(content));
  for (const [rel, content] of Object.entries(change)) {
    if (content === null) rmSync(h.ws.resolve(rel));
    else await h.ws.write(rel, content);
  }
  return { ...h.ctx, ...(inPlace ? { inPlace: { repoTop: '/repo', branch: 'feat/x' } } : {}), runner: SUPPORTED };
}

const pkg = (deps: Record<string, string>): string => JSON.stringify({ name: 'app', private: true, dependencies: deps });
const NEXT = {
  'package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
  'src/app/api/users/route.ts': 'export function GET() { return Response.json([]); }\n',
  'src/app/users/page.tsx': 'export default function Page() { return null; }\n',
};

describe('API routes of file-routed frameworks are named in place', () => {
  it('a changed Next.js route handler is named, with the framework', async () => {
    const ctx = await changed(NEXT, { 'src/app/api/users/route.ts': 'export function GET() { return Response.json([1]); }\n' });
    expect(await unprovenEdits(ctx)).toEqual([{ file: 'src/app/api/users/route.ts', why: expect.stringMatching(/^an API route Next\.js serves by where the file is: no route lock reads it/) }]);
  });

  it('a deleted route handler is named too (an endpoint removed is a contract change)', async () => {
    const ctx = await changed(NEXT, { 'src/app/api/users/route.ts': null });
    expect((await unprovenEdits(ctx)).map((e) => e.file)).toEqual(['src/app/api/users/route.ts']);
  });

  it('twin: a changed Next.js page is red-tier logic, not named', async () => {
    const ctx = await changed(NEXT, { 'src/app/users/page.tsx': 'export default function Page() { return 1; }\n' });
    expect(await unprovenEdits(ctx)).toEqual([]);
  });

  it('twin: the same route path in a package that does not declare next is not named', async () => {
    const ctx = await changed({ ...NEXT, 'package.json': pkg({ react: '19.0.0' }) }, { 'src/app/api/users/route.ts': 'export function GET() { return 1; }\n' });
    expect(await unprovenEdits(ctx)).toEqual([]);
  });

  it('a Nuxt server route is named; a Nuxt page (in place, red-tier) is not', async () => {
    const files = { 'package.json': pkg({ nuxt: '4.0.0' }), 'server/api/hello.ts': 'export default 1;\n', 'src/pages/index.ts': 'export default 1;\n' };
    const ctx = await changed(files, { 'server/api/hello.ts': 'export default 2;\n', 'src/pages/index.ts': 'export default 2;\n' });
    expect((await unprovenEdits(ctx)).map((e) => e.file)).toEqual(['server/api/hello.ts']);
  });

  it('file mode names nothing (the twin)', async () => {
    const ctx = await changed(NEXT, { 'src/app/api/users/route.ts': 'export function GET() { return 2; }\n' }, false);
    expect(await unprovenEdits(ctx)).toEqual([]);
  });
});

describe('apiRouteFramework: the route conventions, by the nearest package.json', () => {
  const tmp = scratch('api-route-conventions');
  afterAll(() => tmp.cleanup());

  it('names each framework\'s routes and leaves its pages alone', () => {
    const cases: Array<[Record<string, string>, string[], string[]]> = [
      [{ next: '15' }, ['app/api/x/route.ts', 'src/app/route.js', 'pages/api/users.ts', 'middleware.ts'], ['app/page.tsx', 'app/x/layout.tsx', 'pages/index.tsx']],
      [{ nuxt: '4' }, ['server/api/x.ts', 'server/routes/y.ts', 'server/middleware/auth.ts'], ['pages/index.vue', 'components/A.vue']],
      [{ '@sveltejs/kit': '2' }, ['src/routes/api/+server.ts', 'src/routes/+page.server.ts', 'src/routes/+layout.server.js', 'src/hooks.server.ts'], ['src/routes/+page.svelte', 'src/routes/+page.ts', 'src/hooks.client.ts']],
      [{ '@remix-run/react': '2' }, ['app/routes/users.tsx', 'app/routes/api.users.ts', 'app/entry.server.tsx'], ['app/root.tsx', 'app/components/x.tsx']],
      [{ astro: '5' }, ['src/pages/api/users.ts', 'src/pages/rss.xml.js', 'src/middleware.ts', 'src/actions/index.ts'], ['src/pages/index.astro', 'src/components/A.astro']],
      [{ gatsby: '5' }, ['src/api/hello.js'], ['src/pages/index.js']],
      [{ '@solidjs/start': '1' }, ['src/routes/api/users.ts', 'src/middleware.ts'], ['src/routes/index.tsx']],
    ];
    for (const [i, [deps, routes, pages]] of cases.entries()) {
      const root = `${tmp.dir}/c${i}`;
      writeTree(root, { 'package.json': pkg(deps) });
      for (const r of routes) expect(apiRouteFramework(root, r), `${Object.keys(deps)[0]} ${r}`).not.toBeNull();
      for (const p of pages) expect(apiRouteFramework(root, p), `${Object.keys(deps)[0]} ${p}`).toBeNull();
    }
    expect(FRAMEWORK_API_ROUTES.map((c) => c.framework)).toEqual(['Next.js', 'Nuxt', 'SvelteKit', 'Remix', 'Astro', 'Gatsby', 'SolidStart']);
  });

  it('a monorepo app is matched by its own package.json; the root manifest without the framework does not match (the twin)', () => {
    const root = `${tmp.dir}/mono`;
    writeTree(root, { 'package.json': pkg({}), 'apps/web/package.json': pkg({ next: '15' }) });
    expect(apiRouteFramework(root, 'apps/web/app/api/x/route.ts')).toBe('Next.js');
    expect(apiRouteFramework(root, 'app/api/x/route.ts')).toBeNull();
  });
});
