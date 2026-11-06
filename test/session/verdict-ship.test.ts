/**
 * The verdict and /ship. The gates decide, run fresh by the harness, never the model's words:
 *   - all required gates green, an approved item and a change: "Work completed" (the only way to it);
 *   - a required gate missing (the loop's own finish run was green): UNPROVEN, no "Work completed";
 *   - a failing gate on /gates: NOT DONE; model prose that claims completion: no verdict at all.
 * A turn that changes the tree gets a verdict whether or not the model calls finish; leaving with a
 * change no gate judged says UNPROVEN and names it.
 * /ship refuses without a DONE verdict, with a change the agent did not make, with content that differs
 * from what the verdict judged, and on the contract's Base; after DONE it commits the agent's files and
 * the item records on the current branch, pushes it without force, opens the PR against the contract's
 * Base (push and gh faked: nothing leaves), and records the session's DONE run before the shipped entry.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendLedger, type MetricReading } from '../../src/core/items.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scrubPaths } from '../../src/session/ship.ts';
import { WORK_COMPLETED } from '../../src/session/ui.ts';
import { calls, fakeRemote, gate, git, ledgerTypes, proposal, registryWithGates, runScripted, TEST_BODY, text, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo;
beforeEach(() => {
  r = webRepo();
});
afterEach(() => r.cleanup());

const TEST_FILE = 'test/greeting-name.test.ts';

/** The ledger of `slug` under a state home (repos/<id>/items/<slug>/ledger.jsonl). */
function findLedger(home: string, slug: string): string {
  const repos = join(home, 'repos');
  for (const id of readdirSync(repos)) {
    const f = join(repos, id, 'items', slug, 'ledger.jsonl');
    if (existsSync(f)) return f;
  }
  throw new Error(`no ledger for ${slug} under ${repos}`);
}
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

  it('model prose that claims completion is not a verdict, and never takes the harness\'s margin', async () => {
    const ran = await runScripted(r, [text(`${WORK_COMPLETED} All done!\n${WORK_COMPLETED}`)], ['is it done?'], { registry: await registryWithGates() });
    expect(ran.runJson['verdicts']).toEqual([]);
    expect(ran.runJson['lastVerdict']).toBeNull();
    const lines = ran.out.split('\n');
    expect(lines.filter((l) => l.startsWith(WORK_COMPLETED))).toEqual([]);
    expect(lines.filter((l) => l.startsWith(`┆ ${WORK_COMPLETED}`))).toHaveLength(2);
  });

  it('a turn that changes the tree without calling finish still gets a verdict, from the gates (trigger turn)', async () => {
    const steps = [...approveWriteFinish(), calls(['write_file', { path: 'test/other.test.ts', content: TEST_BODY.replace('Ada by name', 'again') }]), text('Added another. All done!')];
    // tests-green fails once the second test exists: the finish verdict is DONE, the turn's is not.
    const reg = await registryWithGates();
    const failsLater = gate('tests-green');
    failsLater.plugin.run = async () => (existsSync(join(r.repo, 'test/other.test.ts')) ? { status: 'fail', summary: 'test/other.test.ts fails' } : { status: 'pass', summary: 'green' });
    const ran = await runScripted(r, steps, ['fix the greeting', 'yes', 'one more test please'], { registry: { ...reg, gates: reg.gates.map((g) => (g.plugin.name === 'tests-green' ? failsLater : g)) } });
    expect(ran.out).toMatch(/the turn changed the working tree: the gates judge it/);
    const after = ran.out.slice(ran.out.indexOf('the turn changed the working tree'));
    expect(after).toMatch(/✗ NOT DONE: the gates, not the model, decide/);
    expect(after).not.toContain(WORK_COMPLETED);
    expect(ran.out.split(WORK_COMPLETED)).toHaveLength(2);
    const verdicts = ran.runJson['verdicts'] as Array<Record<string, unknown>>;
    expect(verdicts.map((v) => v['trigger'])).toEqual(['finish', 'turn']);
    expect(verdicts[1]).toMatchObject({ kind: 'NOT DONE', changed: ['test/greeting-name.test.ts', 'test/other.test.ts'] });
    // The model hears the verdict with the owner's next message, never decides it.
    expect(ran.runJson['lastVerdict']).toBe('NOT DONE');
  });

  it('twin: a turn that changes nothing gets no verdict (chat stays chat)', async () => {
    const ran = await runScripted(r, [...approveWriteFinish(), text('Nothing else to change.')], ['fix the greeting', 'yes', 'anything else?'], { registry: await registryWithGates() });
    expect((ran.runJson['verdicts'] as unknown[]).length).toBe(1);
    expect(ran.out).not.toMatch(/the turn changed the working tree/);
  });

  it('leaving with a change no gate judged says UNPROVEN and names the file; a judged tree leaves quietly (the twin)', async () => {
    const lines = ['fix the greeting', 'yes', () => {
      writeFileSync(join(r.repo, TEST_FILE), `${TEST_BODY}// edited after the verdict\n`);
      return '/exit';
    }];
    const ran = await runScripted(r, approveWriteFinish(), lines, { registry: await registryWithGates() });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/\? UNPROVEN: no gate has judged test\/greeting-name\.test\.ts: this work is not complete/);
    expect(ran.runJson['unjudgedAtExit']).toEqual([TEST_FILE]);
    const judged = await runScripted(r, [], ['/exit'], { registry: await registryWithGates() });
    expect(judged.out).not.toMatch(/no gate has judged/);
    expect(judged.runJson['unjudgedAtExit']).toEqual([]);
  });
});

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
    // The session's run (DONE, the approved hash) comes right before the shipped entry (close requires it).
    expect(ledgerTypes(ran, 'greeting-name')).toEqual(['proposed', 'human_turn', 'approved', 'run', 'shipped']);
    // Nothing committed or sent names an absolute local path.
    const committed = git(r.repo, 'show', 'HEAD:.harness/items/greeting-name/session.json') + git(r.repo, 'log', '-1', '--format=%B');
    for (const p of [r.base, r.repo, r.home, homedir()]) {
      expect((pr ?? '').includes(p), p).toBe(false);
      expect(committed.includes(p), p).toBe(false);
    }
    expect(committed).toContain('<state-dir>/sessions/');
  });

  it('refuses an item that closed after its DONE verdict: nothing is committed, pushed or recorded (the open item ships: the test above)', async () => {
    git(r.repo, 'remote', 'add', 'origin', 'git@github.com:acme/tiny-web.git');
    const seen: string[] = [];
    // The owner closes the item from another terminal between the verdict and /ship.
    const closeIt = (): string => {
      const file = findLedger(r.home, 'greeting-name');
      const reading = { value: 1, sha: 'abc', ref: 'development', command: 'node metrics/x.mjs', scriptSha256: 'f'.repeat(64), stdoutSha256: 'e'.repeat(64), excerpt: '' } as unknown as MetricReading;
      appendLedger(file, { type: 'closed', before: reading, after: reading, prUrl: 'https://example.test/pr/1', mergeSha: 'abc', mergedBy: 'someone', closeRunId: 'c1' });
      return '/ship';
    };
    const ran = await runScripted(r, approveWriteFinish(), ['fix the greeting', 'yes', closeIt], { registry: await registryWithGates(), exec: fakeRemote(seen) });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/✗ ship refused: item "greeting-name" is closed \(ledger seq \d+\).*nothing was shipped/);
    expect(seen.some((c) => c.includes(' push ') || c.startsWith('gh pr create') || c.includes(' commit '))).toBe(false);
    expect(git(r.repo, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(ledgerTypes(ran, 'greeting-name').slice(-1)).toEqual(['closed']);
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

  it('refuses a file whose content changed after the DONE verdict (same paths, other bytes), and commits nothing', async () => {
    git(r.repo, 'remote', 'add', 'origin', 'git@github.com:acme/tiny-web.git');
    const seen: string[] = [];
    const lines = ['fix the greeting', 'yes', () => {
      writeFileSync(join(r.repo, TEST_FILE), TEST_BODY.replace("'Hello, Ada'", "'Hello, Eve'"));
      return '/ship';
    }];
    const ran = await runScripted(r, approveWriteFinish(), lines, { registry: await registryWithGates(), exec: fakeRemote(seen) });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/✗ ship refused: test\/greeting-name\.test\.ts changed since the verdict; run \/gates/);
    expect(git(r.repo, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(git(r.repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(seen.some((c) => c.includes(' push '))).toBe(false);
  });

  it('twin: after /gates judges the new content, /ship ships it', async () => {
    git(r.repo, 'remote', 'add', 'origin', 'git@github.com:acme/tiny-web.git');
    const seen: string[] = [];
    const lines = ['fix the greeting', 'yes', () => {
      writeFileSync(join(r.repo, TEST_FILE), TEST_BODY.replace("'Hello, Ada'", "'Hello, Eve'"));
      return '/gates';
    }, '/ship'];
    const ran = await runScripted(r, approveWriteFinish(), lines, { registry: await registryWithGates(), exec: fakeRemote(seen) });
    expect(ran.out).toMatch(/✔ shipped [0-9a-f]{12} on fix\/greeting/);
    expect(git(r.repo, 'show', `HEAD:${TEST_FILE}`)).toContain("'Hello, Eve'");
  });

  it('refuses when the current branch is the contract\'s Base', async () => {
    const ran = await runScripted(r, approveWriteFinish({ base: 'fix/greeting' }), ['fix the greeting', 'yes', '/ship'], { registry: await registryWithGates() });
    expect(ran.out).toContain(WORK_COMPLETED);
    expect(ran.out).toMatch(/✗ ship refused: the branch fix\/greeting is the contract's Base/);
  });

  it('scrubPaths replaces a root only where it is a path of its own: a checkout at /app leaves "src/app/page.tsx" alone', () => {
    const roots = { top: '/app', stateRoot: '/home/dev/.sf-harness/repos/x', harnessRoot: '/opt/harness', home: '/home/dev' };
    const json = JSON.stringify({ changed: ['src/app/page.tsx', 'app/routes.ts'], fingerprint: { 'src/app/page.tsx': 'abc' }, top: '/app', other: '/application/x', file: '/app/src/app/page.tsx' });
    const out = scrubPaths(json, roots);
    expect(out).toContain('"changed":["src/app/page.tsx","app/routes.ts"]');
    expect(out).toContain('"fingerprint":{"src/app/page.tsx":"abc"}');
    expect(out).toContain('"/application/x"');
    expect(out).toContain('"top":"."');
    expect(out).toContain('"file":"./src/app/page.tsx"');
    // A root nested in another (the state directory under home) is named by the longer one; a replacement is never matched again.
    expect(scrubPaths('records: /home/dev/.sf-harness/repos/x/sessions/s1; notes: /home/dev/notes and /home/dev.', roots)).toBe('records: <state-dir>/sessions/s1; notes: ~/notes and ~.');
    expect(scrubPaths('kept: /home/dev/.sf-harness/repos/xy and /home/devices', roots)).toBe('kept: ~/.sf-harness/repos/xy and /home/devices');
    // The twin: every absolute root itself is still scrubbed.
    for (const p of ['/app', '/home/dev/.sf-harness/repos/x', '/opt/harness', '/home/dev']) expect(scrubPaths(`at ${p}/y`, roots)).not.toContain(p);
  });

  it('without a remote it commits and says it did not push (status committed, never faked)', async () => {
    const ran = await runScripted(r, approveWriteFinish(), ['fix the greeting', 'yes', '/ship'], { registry: await registryWithGates() });
    expect(ran.out).toMatch(/● committed [0-9a-f]{12} on fix\/greeting/);
    expect(ran.out).toMatch(/no remote "origin": committed .* not pushed/);
    expect(readFileSync(join(r.repo, 'docs/contracts/greeting-name.md'), 'utf8')).toContain('Repo: local:tiny-web');
  });
});
