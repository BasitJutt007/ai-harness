/**
 * End-to-end: the grader's procedure in a throwaway copy of the repo
 * (scripts/simulate-extensions.mjs). Drops each example into plugins/, asserts it is
 * listed, reported (pass/FAIL + file:line:col, or n/a) and that git sees only plugins/**
 * changes, including one scripted (offline) run that calls the new tool, bound to a fresh item in a
 * temp items root (never the owner's real items, whose ledgers stay byte-identical). The parent's
 * HARNESS_RUNS_DIR / HARNESS_TOKENS_DIR point at a decoy directory that must stay empty:
 * the sandbox's evidence stays inside the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';

/** sha256 of every real item ledger and contract: the simulation must never depend on, or touch, the owner's records. */
function realItemRecords(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ['items', join('docs', 'contracts')]) {
    const abs = join(HARNESS_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const file = join(e.parentPath, e.name);
      out[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  return out;
}

describe('scripts/simulate-extensions.mjs', () => {
  it('adds a tool, an ORM validator and a lint rule by dropping files; only plugins/** changes', () => {
    const records = realItemRecords();
    const decoy = join(HARNESS_ROOT, '.harness', 'tmp', `simulate-decoy-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
    const r = spawnSync(process.execPath, [join(HARNESS_ROOT, 'scripts', 'simulate-extensions.mjs')], {
      cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HARNESS_RUNS_DIR: join(decoy, 'runs'), HARNESS_TOKENS_DIR: join(decoy, 'tokens') },
    });
    const out = `${r.stdout}${r.stderr}`;
    const leaked = existsSync(decoy);
    rmSync(decoy, { recursive: true, force: true });
    expect(leaked, 'the sandbox wrote evidence to the parent HARNESS_RUNS_DIR/HARNESS_TOKENS_DIR').toBe(false);
    expect(out, out).toMatch(/^RESULT {2}pass {2}3 extensions added by dropping one file each into plugins\/; src\/core\/ untouched$/m);
    expect(r.status).toBe(0);
    expect(out).not.toMatch(/^ {2}FAIL/m);
    for (const name of ['openapi_diff', 'orm-explicit-columns', 'no-console']) {
      expect(out).toMatch(new RegExp(`ok {4}harness plugins lists (tool|check) "${name}"`));
    }
    expect(out).toMatch(/^ {8}orm-explicit-columns {2}n\/a {3}\(none\)/m);
    expect(out).toMatch(/^ {12}src\/routes\/debug\.ts:3:3 {2}console\.log/m);
    expect(out).toMatch(/ok {4}turn 1 called openapi_diff/);
    expect(out).toMatch(/ok {4}runs\/\S+\/run\.json pluginFingerprint includes plugins\/tools\/openapi_diff\.ts/);
    // bound to a fresh item in a temp items root: no real item's yes is needed, and none is touched
    expect(out).toMatch(/ok {4}the run was recorded in the temp item simulate-extensions's ledger, outside the repository/);
    expect(out).toMatch(/ok {4}the run changed nothing outside plugins\/, runs\/, tokens\/ \(the real items\/ untouched\)/);
    expect(realItemRecords()).toEqual(records);
    // cleaned up after itself
    const tmp = join(HARNESS_ROOT, '.harness', 'tmp');
    const left = existsSync(tmp) ? readdirSync(tmp).filter((d) => d.startsWith(`simulate-extensions-${String(r.pid)}-`)) : [];
    expect(left).toEqual([]);
  }, 300_000);
});
