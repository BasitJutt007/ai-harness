/**
 * Every file a package.json script runs is out of the agent's reach in place, as Node and the shell would
 * find it: a module written without its extension (`node scripts/setup` runs scripts/setup.js), one preloaded
 * with -r, the package's main for `node .`, a path after `cd dir &&`, a command inside a quoted string, and a
 * package.json at any depth. A search for package.json files that stops early refuses every write (the list
 * would be partial). Each refusal has its writable twin, and file mode keeps the 01 policy.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inPlaceWritePolicy, packageScriptFiles, scriptFileTokens, writePolicyFor } from '../../plugins/lib/path-policy.ts';
import { brownfieldTask } from './helpers.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A tree with a package.json per entry of `pkgs` (dir -> package.json content) and the given empty dirs. */
function tree(pkgs: Record<string, object>, emptyDirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'script-files-'));
  roots.push(root);
  for (const [dir, pkg] of Object.entries(pkgs)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg));
  }
  for (const d of emptyDirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

const task = brownfieldTask({ allow: ['**/*'], deny: [] });
const decide = (root: string, rel: string, maxDirs?: number) =>
  inPlaceWritePolicy(task, rel, { sourceRoots: ['.'], scriptFiles: packageScriptFiles(root, maxDirs !== undefined ? { maxDirs } : {}) });

describe('scriptFileTokens: what a script runs, as Node and the shell resolve it', () => {
  it('a runner\'s module written without its extension names every file Node or tsx would try', () => {
    const setup = scriptFileTokens('node scripts/setup');
    for (const f of ['scripts/setup.js', 'scripts/setup.cjs', 'scripts/setup.mjs', 'scripts/setup.ts', 'scripts/setup/index.js']) expect(setup).toContain(f);
    expect(scriptFileTokens('npx tsx watch scripts/seed')).toContain('scripts/seed.ts');
    expect(scriptFileTokens('node setup')).toContain('setup.js');
    expect(scriptFileTokens('nodemon --watch src server')).toContain('server.js');
    expect(scriptFileTokens('nodemon --watch src server')).not.toContain('src/index.js');
  });

  it('a module preloaded with -r / --import is a file only when written as a relative path (a bare name is a package)', () => {
    expect(scriptFileTokens('node -r ./scripts/hook server.js')).toEqual(expect.arrayContaining(['./scripts/hook.js', 'server.js']));
    expect(scriptFileTokens('node --import=./scripts/register app.js')).toContain('./scripts/register.mjs');
    expect(scriptFileTokens('node -r dotenv/config server.js')).toEqual(['server.js']);
  });

  it('`node .` runs the package main (and index.js); a path-like command or a shell runs its file as written', () => {
    expect(scriptFileTokens('node .', 'lib/main.js')).toEqual(expect.arrayContaining(['lib/main.js', 'index.js']));
    expect(scriptFileTokens('./bin/www')).toEqual(['./bin/www']);
    expect(scriptFileTokens('bash scripts/setup')).toEqual(['scripts/setup']);
  });

  it('`cd dir &&` resolves what follows against dir; a subshell\'s cd ends with it', () => {
    expect(scriptFileTokens('cd tools && node gen/run.js')).toEqual(['tools/gen/run.js']);
    expect(scriptFileTokens('cd tools && cd .. && node run.js')).toEqual(['run.js']);
    expect(scriptFileTokens('(cd web && node build.js) && node post.js')).toEqual(['web/build.js', 'post.js']);
  });

  it('a quoted command is read as one (nodemon --exec, sh -c, concurrently)', () => {
    expect(scriptFileTokens('nodemon --exec "tsx src/server"')).toContain('src/server.ts');
    expect(scriptFileTokens("sh -c 'node scripts/a.js'")).toEqual(['scripts/a.js']);
    expect(scriptFileTokens('concurrently "node api.js" "vite"')).toEqual(['api.js']);
  });

  it('twins that name no file: tools\' bare words, inline code, test directories, globs and variables', () => {
    expect(scriptFileTokens('vite build && eslint src && vitest run src')).toEqual([]);
    expect(scriptFileTokens('node -e "console.log(1)"')).toEqual([]);
    expect(scriptFileTokens('node --test test/')).toEqual([]);
    expect(scriptFileTokens('node $ENTRY && tsx "src/**/*.ts"')).toEqual([]);
  });
});

describe('the in-place policy refuses every file a script runs', () => {
  it('extensionless entries, preloads and `node .`: refused, naming the script; the unnamed twins are writable', () => {
    const root = tree({ '.': { name: 'x', main: 'lib/main.js', scripts: { postinstall: 'node scripts/setup', seed: 'tsx scripts/seed', prepare: 'node -r ./scripts/hook scripts/prepare', start: 'node .' } } });
    for (const [f, script] of [['scripts/setup.js', 'postinstall'], ['scripts/seed.ts', 'seed'], ['scripts/hook.js', 'prepare'], ['scripts/prepare.mjs', 'prepare'], ['lib/main.js', 'start'], ['index.js', 'start']] as const) {
      const d = decide(root, f);
      expect(d.allowed, f).toBe(false);
      expect(d.reason, f).toMatch(new RegExp(`named by package\\.json scripts\\.${script}`));
    }
    for (const f of ['scripts/other.js', 'scripts/seed-data.json', 'lib/util.js']) expect(decide(root, f).allowed, f).toBe(true);
  });

  it('`cd tools && node gen/run.js` refuses tools/gen/run.js; tools/gen/other.js stays writable', () => {
    const root = tree({ '.': { name: 'x', scripts: { prebuild: 'cd tools && node gen/run.js' } } });
    expect(decide(root, 'tools/gen/run.js')).toMatchObject({ allowed: false, reason: expect.stringMatching(/named by package\.json scripts\.prebuild/) });
    expect(decide(root, 'tools/gen/other.js').allowed).toBe(true);
  });

  it('a package.json at any depth is read (no depth limit)', () => {
    const root = tree({ '.': { name: 'x' }, 'a/b/c/d/e/f/g/h': { name: 'deep', scripts: { postinstall: 'node setup.js' } } });
    expect(decide(root, 'a/b/c/d/e/f/g/h/setup.js')).toMatchObject({ allowed: false, reason: expect.stringMatching(/a\/b\/c\/d\/e\/f\/g\/h\/package\.json scripts\.postinstall/) });
    expect(decide(root, 'a/b/c/d/e/f/g/h/other.js').allowed).toBe(true);
  });

  it('a search that stops early refuses every write (the list would be partial); the twin under the limit reads it whole', () => {
    const root = tree({ '.': { name: 'x' }, 'zz-app': { name: 'app', scripts: { postinstall: 'node setup.js' } } }, ['aa/1', 'aa/2', 'aa/3', 'aa/4']);
    const partial = packageScriptFiles(root, { maxDirs: 3 });
    expect(partial.incomplete).toMatch(/stopped after 3 directories/);
    for (const f of ['zz-app/setup.js', 'src/app.ts', 'zz-app/other.js']) {
      expect(decide(root, f, 3)).toMatchObject({ allowed: false, reason: expect.stringMatching(/stopped after 3 directories, so which files package\.json scripts run is unknown/) });
    }
    const whole = packageScriptFiles(root);
    expect(whole.incomplete).toBeNull();
    expect(whole.packageDirs).toEqual(new Set(['', 'zz-app']));
    expect(decide(root, 'zz-app/setup.js').allowed).toBe(false);
    expect(decide(root, 'zz-app/other.js').allowed).toBe(true);
  });

  it('writePolicyFor reads the workspace\'s scripts in place; file mode keeps the 01 policy (the twin)', () => {
    const root = tree({ '.': { name: 'x', scripts: { postinstall: 'node scripts/setup' } } });
    const ctx = { task: brownfieldTask({ allow: ['scripts/**/*.ts'], deny: [] }), workspace: { root } };
    expect(writePolicyFor({ ...ctx, inPlace: { repoTop: root, branch: 'feat/x' } }, 'scripts/setup.ts')).toMatchObject({ allowed: false, reason: expect.stringMatching(/scripts\.postinstall/) });
    expect(writePolicyFor(ctx, 'scripts/setup.ts')).toMatchObject({ allowed: true });
  });
});
