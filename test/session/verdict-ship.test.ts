/**
 * The verdict and /ship. The gates decide, run fresh by the harness, never the model's words:
 *   - all required gates green, an approved item and a change: "Work completed" (the only way to it);
 *   - a required gate missing (the loop's own finish run was green): UNPROVEN, no "Work completed";
 *   - a failing gate on /gates: NOT DONE; model prose that claims completion: no verdict at all.
 * /ship refuses without a DONE verdict, with a change the agent did not make, and on the contract's
 * Base; after DONE it commits the agent's files and the item records on the current branch, pushes it
 * without force and opens the PR against the contract's Base (push and gh faked: nothing leaves).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec as coreExec } from '../../src/core/exec.ts';
import type { Exec } from '../../src/core/types.ts';
import { WORK_COMPLETED } from '../../src/session/ui.ts';
import { calls, git, ledgerTypes, proposal, registryWithGates, runScripted, TEST_BODY, text, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo;
beforeEach(() => {
  r = webRepo();
});
afterEach(() => r.cleanup());

const TEST_FILE = 'test/greeting-name.test.ts';
const approveWriteFinish = (over: Record<string, unknown> = {}) => [
  calls(['propose_contract', proposal(over)]),
  calls(['write_file', { path: TEST_FILE, content: TEST_BODY }]),
  calls(['finish', { summary: 'test added' }]),
];

describe('the verdict', () => {
  it('every required gate green, fresh: "Work completed", recorded in run.json', async () => {
    const ran = await runScripted(r, approveWriteFinish(), ['fix the greeting', 'yes'], { registry: await registryWithGates() });
    expect(ran.out).toContain('◆ finish accepted by the gates');
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.runJson['lastVerdict']).toBe('DONE');
    const v = (ran.runJson['verdicts'] as Array<Record<string, unknown>>)[0];
    expect(v).toMatchObject({ kind: 'DONE', trigger: 'finish', item: { slug: 'greeting-name' }, changed: [TEST_FILE] });
    // Nothing was committed: the change is in the working tree only.
    expect(git(r.repo, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(git(r.repo, 'status', '--porcelain')).toBe(`?? ${TEST_FILE}`);
  });

  it('twin: a required gate that is not registered makes it UNPROVEN, though the loop\'s own finish run was green', async () => {
    const reg = await registryWithGates();
    const ran = await runScripted(r, approveWriteFinish(), ['fix the greeting', 'yes'], { registry: { ...reg, gates: reg.gates.filter((g) => g.plugin.name !== 'observed-red') } });
    expect(ran.out).toContain('◆ finish accepted by the gates');
    expect(ran.out).toMatch(/\? UNPROVEN: the gates, not the model, decide/);
    expect(ran.out).toMatch(/gate observed-red UNPROVEN: required gate is not registered/);
    expect(ran.out).not.toContain(WORK_COMPLETED);
    expect(ran.runJson['lastVerdict']).toBe('UNPROVEN');
    // The model hears the verdict with the owner's next message.
  });

  it('/gates with a failing gate: NOT DONE, with the reason', async () => {
    const ran = await runScripted(r, approveWriteFinish().slice(0, 2).concat([text('Test written.')]), ['fix the greeting', 'yes', '/gates'], { registry: await registryWithGates({ 'tests-green': 'fail' }) });
    expect(ran.out).toMatch(/✗ NOT DONE: the gates, not the model, decide/);
    expect(ran.out).toMatch(/gate tests-green failed: tests-green says fail/);
    expect(ran.out).not.toContain(WORK_COMPLETED);
  });

  it('/gates before any contract: never DONE (no approved item, no change)', async () => {
    const ran = await runScripted(r, [], ['/gates'], { registry: await registryWithGates() });
    expect(ran.out).toMatch(/\? UNPROVEN/);
    expect(ran.out).toMatch(/no approved contract is bound to this session/);
    expect(ran.out).toMatch(/the working tree has no change/);
  });

  it('model prose that claims completion is not a verdict', async () => {
    const ran = await runScripted(r, [text(`${WORK_COMPLETED} All done!`)], ['is it done?'], { registry: await registryWithGates() });
    expect(ran.runJson['verdicts']).toEqual([]);
    expect(ran.runJson['lastVerdict']).toBeNull();
  });

  it('a write after a DONE verdict makes it stale: /ship then needs /gates again', async () => {
    const steps = [...approveWriteFinish(), calls(['write_file', { path: 'test/other.test.ts', content: TEST_BODY.replace('Ada by name', 'again') }]), text('Added another.')];
    const ran = await runScripted(r, steps, ['fix the greeting', 'yes', 'one more test please', '/ship'], { registry: await registryWithGates() });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/✗ ship refused: the last verdict is none yet/);
  });
});

/** The core exec, except `git push` and `gh` (nothing leaves the machine); records what was asked. */
function fakeRemote(seen: string[]): Exec {
  return async (cmd, args, opts) => {
    seen.push([cmd, ...args].join(' '));
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', durationMs: 0, timedOut: false });
    if (cmd === 'gh') {
      if (args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/acme/tiny-web/pull/7\n');
      return ok('gh version test\n');
    }
    if (cmd === 'git' && args.includes('push')) return ok();
    return coreExec(cmd, args, opts);
  };
}

describe('/ship', () => {
  it('refuses without a DONE verdict', async () => {
    const ran = await runScripted(r, [], ['/ship'], { registry: await registryWithGates() });
    expect(ran.out).toMatch(/✗ ship refused: no approved contract is bound to this session/);
  });

  it('after DONE: commits the agent\'s file and the item records on the current branch, pushes it (no force), opens the PR against the Base', async () => {
    git(r.repo, 'remote', 'add', 'origin', 'git@github.com:acme/tiny-web.git');
    const seen: string[] = [];
    const ran = await runScripted(r, approveWriteFinish(), ['fix the greeting', 'yes', '/ship'], { registry: await registryWithGates(), exec: fakeRemote(seen) });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/✔ shipped [0-9a-f]{12} on fix\/greeting {2}https:\/\/github\.com\/acme\/tiny-web\/pull\/7/);
    const ship = seen.slice(seen.findIndex((c) => c.includes(' add --all ')));
    expect(ship).toContainEqual(`git -C ${r.repo} add --all -- ${TEST_FILE}`);
    expect(ship).toContainEqual(`git -C ${r.repo} add --force -- docs/contracts/greeting-name.md .harness/items/greeting-name/ledger.jsonl .harness/items/greeting-name/session.json`);
    expect(ship).toContainEqual(`git -C ${r.repo} -c core.hooksPath=/dev/null push --no-force -u origin refs/heads/fix/greeting:refs/heads/fix/greeting`);
    const pr = ship.find((c) => c.startsWith('gh pr create'));
    expect(pr).toMatch(/^gh pr create --base development --head fix\/greeting --title fix\(greeting\): greet visitors by the name they gave --body /);
    expect(ship.some((c) => /push.*--force(?!-)|push -f/.test(c.replace('--no-force', '')))).toBe(false);
    // The commit is on the current branch, with the contract's header and no attribution.
    expect(git(r.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/greeting');
    const msg = git(r.repo, 'log', '-1', '--format=%B');
    expect(msg.split('\n')[0]).toBe('fix(greeting): greet visitors by the name they gave');
    expect(msg).not.toMatch(/Co-Authored-By|Generated with/i);
    expect(git(r.repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['.harness/items/greeting-name/ledger.jsonl', '.harness/items/greeting-name/session.json', 'docs/contracts/greeting-name.md', TEST_FILE]);
    const summary = JSON.parse(git(r.repo, 'show', 'HEAD:.harness/items/greeting-name/session.json')) as Record<string, unknown>;
    expect(summary).toMatchObject({ item: { slug: 'greeting-name' }, branch: 'fix/greeting', verdict: { kind: 'DONE' } });
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
    expect(ledgerTypes(ran, 'greeting-name')).toEqual(['proposed', 'human_turn', 'approved', 'shipped']);
  });

  it('refuses a change the agent did not make (it would ship unjudged), and stages nothing', async () => {
    const steps = [...approveWriteFinish()];
    const lines = ['fix the greeting', 'yes', () => {
      writeFileSync(join(r.repo, 'src', 'owner-edit.ts'), 'export const x = 1;\n');
      return '/ship';
    }];
    const ran = await runScripted(r, steps, lines, { registry: await registryWithGates() });
    expect(ran.out).toMatch(/✗ ship refused: the working tree has changes the agent did not make \(src\/owner-edit\.ts\)/);
    expect(git(r.repo, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(git(r.repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses when the current branch is the contract\'s Base', async () => {
    const ran = await runScripted(r, approveWriteFinish({ base: 'fix/greeting' }), ['fix the greeting', 'yes', '/ship'], { registry: await registryWithGates() });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/✗ ship refused: the branch fix\/greeting is the contract's Base/);
  });

  it('without a remote it commits and says it did not push (status committed, never faked)', async () => {
    const ran = await runScripted(r, approveWriteFinish(), ['fix the greeting', 'yes', '/ship'], { registry: await registryWithGates() });
    expect(ran.out).toMatch(/● committed [0-9a-f]{12} on fix\/greeting/);
    expect(ran.out).toMatch(/no remote "origin": committed .* not pushed/);
    expect(readFileSync(join(r.repo, 'docs/contracts/greeting-name.md'), 'utf8')).toContain('Repo: local:tiny-web');
  });
});
