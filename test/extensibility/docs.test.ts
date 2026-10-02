/**
 * docs/extending.md stays truthful: every snippet headed "// plugins/<kind>/<file>.ts" or
 * "// file: plugins/<kind>/<file>.ts" is extracted into a scratch plugin dir laid out like
 * the repo (src/ and plugins/lib/ symlinked to the real ones) and must load through the real
 * registry with no errors (at least one plugin of each of the five kinds).
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { loadRegistry } from '../../src/core/registry.ts';
import { repoTmp } from './_helpers.ts';

const DOC = readFileSync(join(HARNESS_ROOT, 'docs', 'extending.md'), 'utf8');
const tmp = repoTmp('docs');

afterAll(() => tmp.cleanup());

describe('docs/extending.md', () => {
  it('states the core boundary and documents all five plugin kinds', () => {
    expect(DOC).toContain('The core engine is `src/core/` — extensions never edit it.');
    for (const h of ['## Tool', '## Check', '## Hook', '## Gate', '## Driver']) expect(DOC).toContain(h);
    expect(DOC).toMatch(/"disabled": \[/);
  });

  it('every copy-paste example loads as a valid plugin', async () => {
    // tmp/src → the real src and tmp/plugins/lib → the real lib, so '../../src/core/plugin-api.ts'
    // and '../lib/contract.ts' resolve exactly as in plugins/<kind>/ (the registry never loads lib/)
    symlinkSync(join(HARNESS_ROOT, 'src'), join(tmp.dir, 'src'), 'dir');
    mkdirSync(join(tmp.dir, 'plugins'), { recursive: true });
    symlinkSync(join(HARNESS_ROOT, 'plugins', 'lib'), join(tmp.dir, 'plugins', 'lib'), 'dir');
    const files: string[] = [];
    for (const m of DOC.matchAll(/```ts\n\/\/ (?:file: )?(plugins\/[\w/-]+\.ts)[^\n]*\n([\s\S]*?)```/g)) {
      const rel = m[1] ?? '';
      const dest = join(tmp.dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, m[2] ?? '');
      files.push(rel);
    }
    expect(new Set(files).size, 'each snippet names its own file').toBe(files.length);
    expect([...new Set(files.map((f) => f.split('/')[1]))].sort()).toEqual(['checks', 'drivers', 'gates', 'hooks', 'tools']);
    const reg = await loadRegistry({ ...loadConfig(HARNESS_ROOT), pluginDirs: [join(tmp.dir, 'plugins')] }, HARNESS_ROOT);
    expect(reg.errors).toEqual([]);
    const loaded = [...reg.drivers, ...reg.tools, ...reg.hooks, ...reg.gates, ...reg.checks].map((r) => r.file.slice(r.file.indexOf('plugins/')));
    expect(loaded.sort()).toEqual([...files].sort());
    for (const n of [reg.drivers.length, reg.tools.length, reg.hooks.length, reg.gates.length, reg.checks.length]) expect(n).toBeGreaterThanOrEqual(1);
    // the graded additions are covered: a tool, an ORM validator and a lint rule
    expect(reg.checks.map((c) => c.plugin.category)).toEqual(expect.arrayContaining(['orm', 'lint']));
  });
});
