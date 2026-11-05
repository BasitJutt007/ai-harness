/**
 * Protected branches: the defaults cover the long-lived branches of the usual workflows, and
 * harness.config.json can add to them but never shorten the list (a config naming only its own
 * extras still protects main). The repository's own config keeps its exact list and order, so
 * file mode records the same governance as before.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROTECTED_BRANCHES, HARNESS_ROOT, loadConfig, withDefaultProtected } from '../../src/core/config.ts';
import { isProtectedBranch } from '../../src/core/workspace.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('protected');
afterAll(() => tmp.cleanup());

describe('protected branches', () => {
  it('the schema defaults name main, master, development, develop, staging, production and release/*', () => {
    for (const b of ['main', 'master', 'development', 'develop', 'staging', 'production', 'release/*']) expect(DEFAULT_PROTECTED_BRANCHES).toContain(b);
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({}));
    const c = loadConfig(tmp.dir);
    expect(c.protectedBranches).toEqual([...DEFAULT_PROTECTED_BRANCHES]);
    for (const b of ['main', 'master', 'development', 'develop', 'staging', 'production', 'release/1.4', 'release/1.4/hotfix', 'Development']) {
      expect(isProtectedBranch(b, c.protectedBranches), b).toBe(true);
    }
  });

  it('a working branch is not protected (the legitimate twin)', () => {
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({}));
    const c = loadConfig(tmp.dir);
    for (const b of ['fix/login-redirect', 'feat/x', 'developer-tools', 'mainline-docs', 'releases']) expect(isProtectedBranch(b, c.protectedBranches), b).toBe(false);
  });

  it('a config adds branches and can never remove a default', () => {
    writeFileSync(join(tmp.dir, 'harness.config.json'), JSON.stringify({ protectedBranches: ['qa'] }));
    const c = loadConfig(tmp.dir);
    expect(c.protectedBranches[0]).toBe('qa');
    expect(isProtectedBranch('qa', c.protectedBranches)).toBe(true);
    expect(isProtectedBranch('main', c.protectedBranches)).toBe(true);
    expect(isProtectedBranch('staging', c.protectedBranches)).toBe(true);
  });

  it("the repository's own config keeps its list and order (file mode records the same governance)", () => {
    const raw = JSON.parse(readFileSync(join(HARNESS_ROOT, 'harness.config.json'), 'utf8')) as { protectedBranches: string[] };
    expect(loadConfig(HARNESS_ROOT).protectedBranches).toEqual(raw.protectedBranches);
    expect(withDefaultProtected(raw.protectedBranches)).toEqual(raw.protectedBranches);
  });
});
