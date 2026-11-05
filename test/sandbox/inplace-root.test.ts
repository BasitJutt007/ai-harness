/**
 * In-place runs name their confined tree explicitly (the owner's checkout) instead of the tree being
 * inferred from .harness/worktrees or .harness/tmp suffixes, and inside it confined code never reads
 * a `.git` or `.env*` entry: on Seatbelt (macOS) by regexes denied after the allow, checked here
 * against the real mechanism; on bwrap (Linux) by masking each such entry, checked here on the argv.
 * The in-process TypeScript fence hides the same entries. Without a registered root (worktree runs,
 * file mode) every fence is exactly as before.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import {
  bwrapArgs,
  confinedRoot,
  detectMechanism,
  enclosingRoot,
  hiddenEntries,
  hiddenPatterns,
  isHiddenInPlace,
  readFence,
  regexLiteral,
  seatbeltProfile,
  setConfinedRoot,
} from '../../src/core/sandbox.ts';
import { createTsFence } from '../../src/core/ts-fence.ts';

let base: string;
let root: string;
let scratch: string;

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'inplace-root-')));
  root = join(base, 'app');
  scratch = join(base, 'scratch');
  mkdirSync(scratch);
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  put('src/a.ts', 'export const a = 1;\n');
  put('environment.ts', 'export const env = "dev";\n');
  put('.env', 'API_KEY=CANARY_ENV\n');
  put('sub/.env.local', 'API_KEY=CANARY_ENV_LOCAL\n');
  put('.envs/prod', 'API_KEY=CANARY_ENVS\n');
  put('.gitignore', '.env\n');
  put('sub/x.ts', 'export {};\n');
  put('node_modules/pkg/.env', 'X=1\n');
  symlinkSync('.env', join(root, 'link.txt'));
  writeFileSync(join(base, 'sibling.txt'), 'outside the tree\n');
});
afterEach(() => {
  setConfinedRoot(null);
  rmSync(base, { recursive: true, force: true });
});

describe('setConfinedRoot', () => {
  it('registers an existing checkout and clears with null', () => {
    setConfinedRoot(root);
    expect(confinedRoot()).toBe(root);
    setConfinedRoot(null);
    expect(confinedRoot()).toBeNull();
  });

  it('refuses a root that is missing, relative, the filesystem root, or that contains the home dir or the harness', () => {
    for (const bad of [join(base, 'missing'), 'app', '/', homedir(), HARNESS_ROOT, dirname(HARNESS_ROOT)]) {
      expect(() => setConfinedRoot(bad), bad).toThrow(/sandbox:/);
      expect(confinedRoot()).toBeNull();
    }
  });

  it("refuses a root that contains the folder of every run's worktree, or the harness scratch (.harness/tmp)", () => {
    const harnessState = join(HARNESS_ROOT, '.harness');
    mkdirSync(join(harnessState, 'worktrees'), { recursive: true });
    mkdirSync(join(harnessState, 'tmp'), { recursive: true });
    expect(() => setConfinedRoot(harnessState)).toThrow(/sandbox: confined root .* contains .*\.harness\/worktrees; confined code may never read it whole/);
    expect(() => setConfinedRoot(join(harnessState, 'tmp'))).toThrow(/sandbox: confined root .* contains .*\.harness\/tmp; confined code may never read it whole/);
    expect(confinedRoot()).toBeNull();
    // the twin: an ordinary checkout beside them is registered
    setConfinedRoot(root);
    expect(confinedRoot()).toBe(root);
  });
});

describe('the confined tree', () => {
  it('a cwd anywhere in the registered checkout is confined to the whole checkout', () => {
    setConfinedRoot(root);
    expect(enclosingRoot(join(root, 'sub'))).toBe(root);
    expect(enclosingRoot(root)).toBe(root);
    expect(enclosingRoot(scratch)).toBe(scratch); // outside it: inferred as before
  });

  it('file-mode twin: with nothing registered the tree is inferred as before (the cwd itself here)', () => {
    expect(enclosingRoot(join(root, 'sub'))).toBe(join(root, 'sub'));
    expect(readFence(process.execPath, root, [scratch])).not.toHaveProperty('hiddenIn');
  });

  it("the read fence allows the checkout and marks it as one whose .git and .env* stay hidden", () => {
    setConfinedRoot(root);
    const f = readFence(process.execPath, join(root, 'sub'), [scratch]);
    expect(f.allow).toContain(root);
    expect(f.allow).not.toContain(join(root, 'sub'));
    expect(f.hiddenIn).toEqual([root]);
  });
});

describe('the hidden-entry patterns (Seatbelt regexes)', () => {
  it('match every .git and .env* entry at any depth of the tree, in any letter case, and nothing else', () => {
    const res = hiddenPatterns(root).map((p) => new RegExp(p));
    const hidden = (p: string): boolean => res.some((r) => r.test(p));
    for (const p of ['.env', 'sub/.env.local', '.ENV', '.Env.production', '.envs', '.envs/prod/x', '.git', '.git/config', 'sub/.git/HEAD', '.GIT/HEAD']) expect(hidden(`${root}/${p}`), p).toBe(true);
    for (const p of ['environment.ts', 'src/a.ts', '.gitignore', '.github/workflows/ci.yml', 'src/env.ts', 'sub/x.env']) expect(hidden(`${root}/${p}`), p).toBe(false);
    expect(hidden(`${root}-other/.env`)).toBe(false); // a sibling with the same prefix is another tree
  });

  it('take the root literally (regex metacharacters escaped)', () => {
    const odd = '/tmp/a+b (1)/[x].y';
    expect(new RegExp(`^${regexLiteral(odd)}$`).test(odd)).toBe(true);
    expect(new RegExp(`^${regexLiteral(odd)}$`).test('/tmp/aab (1)/x.y')).toBe(false);
  });

  it('the Seatbelt profile denies them after the allow and before the credential stores; without them the profile is unchanged', () => {
    const counts = { writable: 1, deny: 2, allow: 3, metadata: 4, secrets: 1 };
    expect(seatbeltProfile({ ...counts, hidden: 0 }, 'none')).toBe(seatbeltProfile(counts, 'none'));
    const lines = seatbeltProfile({ ...counts, hidden: 2 }, 'none').split('\n');
    const at = (prefix: string): number => lines.findIndex((l) => l.startsWith(prefix));
    expect(lines).toContain('(deny file-read* (regex (param "H0")) (regex (param "H1")))');
    expect(at('(deny file-read* (regex')).toBeGreaterThan(at('(allow file-read-metadata'));
    expect(at('(deny file-read* (regex')).toBeLessThan(lines.indexOf('(deny file-read* (subpath (param "S0")))'));
  });
});

describe.runIf(detectMechanism() === 'sandbox-exec')('Seatbelt, for real: confined code in the checkout', () => {
  const READ = `
const fs = require('node:fs');
const r = {};
for (const p of JSON.parse(process.argv[1])) { try { fs.readFileSync(p, 'utf8'); r[p] = 'ok'; } catch (e) { r[p] = e.code || String(e); } }
process.stdout.write(JSON.stringify(r));`;
  async function readAs(cwd: string, rels: string[]): Promise<Record<string, string>> {
    const paths = rels.map((p) => join(root, p));
    const out = await exec(process.execPath, ['-e', READ, JSON.stringify(paths)], { cwd, sandbox: { writable: [scratch], network: 'none' }, timeoutMs: 20_000 });
    expect(out.sandbox).toBe('sandbox-exec');
    const parsed = JSON.parse(out.stdout) as Record<string, string>;
    return Object.fromEntries(rels.map((p, i) => [p, parsed[paths[i] ?? ''] ?? 'missing']));
  }

  it("reads the checkout's source but never a .git or .env* entry, however it is reached", async () => {
    setConfinedRoot(root);
    put('late/.env.test', 'created after registration\n');
    const r = await readAs(join(root, 'sub'), ['src/a.ts', 'environment.ts', 'sub/x.ts', '.env', 'sub/.env.local', '.envs/prod', '.git/HEAD', 'link.txt', 'sub/../.env', 'late/.env.test', '../sibling.txt']);
    expect(r).toMatchObject({ 'src/a.ts': 'ok', 'environment.ts': 'ok', 'sub/x.ts': 'ok' });
    for (const p of ['.env', 'sub/.env.local', '.envs/prod', '.git/HEAD', 'link.txt', 'sub/../.env', 'late/.env.test', '../sibling.txt']) expect(r[p], p).toBe('EPERM');
  });

  it('file-mode twin: with nothing registered, code in the tree reads it whole as before (the .env too)', async () => {
    const r = await readAs(root, ['src/a.ts', '.env']);
    expect(r).toEqual({ 'src/a.ts': 'ok', '.env': 'ok' });
  });
});

describe('bwrap: the hidden entries are masked', () => {
  it('finds the top .git and every .env* entry (node_modules skipped), and fails closed on a tree too big to walk', () => {
    expect(hiddenEntries(root).sort()).toEqual([join(root, '.env'), join(root, '.envs'), join(root, '.git'), join(root, 'sub', '.env.local')].sort());
    expect(() => hiddenEntries(root, 3)).toThrow(/more than 3 entries; its \.env files cannot all be found/);
  });

  it('masks every nested .git too (a vendored checkout, a submodule\'s .git file), in any letter case, without walking into it', () => {
    put('vendor/lib/.git/config', '[remote "origin"]\n');
    put('packages/ui/.GIT', 'gitdir: ../../.git/modules/ui\n');
    put('vendor/lib/.git/hooks/.env', 'never walked into\n');
    const found = hiddenEntries(root);
    expect(found).toContain(join(root, 'vendor', 'lib', '.git'));
    expect(found).toContain(join(root, 'packages', 'ui', '.GIT'));
    expect(found).not.toContain(join(root, 'vendor', 'lib', '.git', 'hooks', '.env')); // inside a masked .git
    // ...and each is masked on the argv: a directory with a tmpfs, a file with /dev/null
    const args = bwrapArgs({ deny: [], allow: [root], metadata: [], secrets: [], hiddenIn: [root] }, [scratch], root);
    expect(args.some((a, i) => a === '--tmpfs' && args[i + 1] === join(root, 'vendor', 'lib', '.git'))).toBe(true);
    expect(args.some((a, i) => a === '--ro-bind' && args[i + 1] === '/dev/null' && args[i + 2] === join(root, 'packages', 'ui', '.GIT'))).toBe(true);
    // the twins stay readable: .gitignore, .github
    put('.github/workflows/ci.yml', 'on: push\n');
    expect(hiddenEntries(root).some((p) => /\.gitignore$|\.github/.test(p))).toBe(false);
  });

  it('masks each one after the tree is bound back: files with /dev/null, directories with a tmpfs', () => {
    const args = bwrapArgs({ deny: [], allow: [root], metadata: [], secrets: [], hiddenIn: [root] }, [scratch], root);
    const bind = args.findIndex((a, i) => a === '--ro-bind' && args[i + 1] === root);
    const after = (flag: string, path: string): boolean => args.some((a, i) => i > bind && a === flag && args[i + (flag === '--tmpfs' ? 1 : 2)] === path);
    expect(bind).toBeGreaterThan(0);
    expect(after('--ro-bind', join(root, '.env'))).toBe(true);
    expect(after('--ro-bind', join(root, 'sub', '.env.local'))).toBe(true);
    expect(after('--tmpfs', join(root, '.git'))).toBe(true);
    expect(after('--tmpfs', join(root, '.envs'))).toBe(true);
    // file-mode twin: no hiddenIn, no masks inside the tree
    const plain = bwrapArgs({ deny: [], allow: [root], metadata: [], secrets: [] }, [scratch], root);
    expect(plain.some((a) => a.startsWith(`${root}/.`))).toBe(false);
  });
});

describe('the in-process TypeScript fence', () => {
  it('never shows a program a .git or .env* entry of the checkout; the source is visible', () => {
    setConfinedRoot(root);
    const fence = createTsFence(root);
    expect(fence.allows('src/a.ts')).toBe(true);
    expect(fence.allows('sub/x.ts')).toBe(true);
    for (const p of ['.env', 'sub/.env.local', '.envs/prod', '.git/HEAD', 'link.txt']) expect(fence.allows(p), p).toBe(false);
    expect(isHiddenInPlace(join(root, '.git'))).toBe(true);
    expect(isHiddenInPlace(join(scratch, '.env'))).toBe(false);
  });

  it('file-mode twin: with nothing registered the fence is as before', () => {
    const fence = createTsFence(root);
    expect(fence.allows('.env')).toBe(true);
    expect(isHiddenInPlace(join(root, '.env'))).toBe(false);
  });
});
